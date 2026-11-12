"use client";

import Link from "next/link";
import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, ChevronDown, ChevronRight, CircleAlert, Clock, Copy, Download, Loader2, Paperclip, Pause, Pencil, Play, RotateCw } from "lucide-react";
import { type Run, type RunEvent } from "@/lib/types";
import { updateFavicon, resetFavicon } from "@/lib/favicon";
import { dict } from "@/lib/i18n";
import { cn, formatDuration, formatSize } from "@/lib/utils";
import { groupSteps } from "@/lib/steps";
import { reportHtml, reportMarkdown } from "@/lib/report";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { BigStatus } from "@/components/run/status";
import { StepCard } from "@/components/run/step-card";
import { QuestionBody } from "@/components/run/question";
import { StarCta } from "@/components/run/star-cta";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function RunPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pauseBusy, setPauseBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rerunBusy, setRerunBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const gotSnapshot = useRef(false);

  useEffect(() => {
    gotSnapshot.current = false;
    const es = new EventSource(`/api/run/${id}/stream`);
    es.onmessage = (msg) => {
      // every frame carries the current Run in full; the first also carries the event backlog
      const data = JSON.parse(msg.data) as {
        run: Omit<Run, "events">;
        events?: RunEvent[];
        event?: RunEvent;
      };
      gotSnapshot.current = true;
      if (data.events) setEvents(data.events);
      else if (data.event) setEvents((prev) => [...prev, data.event!]);
      setRun({ ...data.run, events: [] });

      const active = ["running", "waiting", "paused"].includes(data.run.status);
      if (!active) {
        const ts = data.event?.ts ?? data.events?.at(-1)?.ts ?? Date.now();
        setFinishedAt((f) => f ?? ts);
      }
    };
    es.onerror = () => {
      es.close();
      if (!gotSnapshot.current) setNotFound(true);
    };
    return () => es.close();
  }, [id]);

  // the whole page speaks the language the test case was written in
  const t = dict(run?.language);
  const status = run?.status ?? "running";
  const steps = run?.steps ?? [];
  const passN = steps.filter((s) => s.status === "pass").length;
  const failN = steps.filter((s) => s.status === "fail").length;
  const warnN = steps.filter((s) => s.status === "warn").length;

  const isRunning = status === "running" || status === "waiting";
  const isActive = isRunning || status === "paused";

  async function togglePause() {
    if (!isActive) return;
    setPauseBusy(true);
    await fetch(`/api/run/${id}/pause`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: status === "paused" ? "resume" : "pause" }),
    }).catch(() => {});
    setPauseBusy(false);
  }

  async function copyReport() {
    if (!run) return;
    try {
      await navigator.clipboard.writeText(reportMarkdown(run, elapsed, t));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  // a self-contained HTML file: screenshots are inlined, so it can be attached to a ticket
  async function downloadReport() {
    if (!run) return;
    const shots: Record<number, string> = {};
    await Promise.all(
      run.steps.filter((s) => s.screenshot).map(async (s) => {
        try {
          const blob = await (await fetch(s.screenshot!)).blob();
          shots[s.num] = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
        } catch {
          // screenshot is gone (server restarted) — the report still has the text
        }
      }),
    );
    const html = reportHtml(run, elapsed, t, shots);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `qpilot-${run.id}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function runAgain() {
    if (!run) return;
    setRerunBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testCase: run.testCase, headless: run.headless }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      router.push(`/run/${json.id}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setRerunBusy(false);
    }
  }

  // hand the test case back to the home page editor (it also holds the file picker,
  // so a run that had attachments is repeated from there)
  function editTestCase() {
    if (!run) return;
    try {
      sessionStorage.setItem("qpilot:prefill", run.testCase);
    } catch {}
    router.push("/");
  }

  const activeStepNum = isRunning
    ? (steps.find((s) => s.status === "queued")?.num ?? null)
    : null;

  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  useEffect(() => {
    updateFavicon(status);
    return () => { resetFavicon(); };
  }, [status]);

  useEffect(() => {
    if (!run?.title) return;
    const prev = document.title;
    document.title = run.title;
    return () => { document.title = prev; };
  }, [run?.title]);

  useEffect(() => {
    if (activeStepNum == null) return;
    document
      .getElementById(`step-${activeStepNum}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeStepNum]);

  const elapsed = run ? (finishedAt ?? now) - run.createdAt : 0;
  const doneN = steps.filter((s) => s.status !== "queued").length;
  const progressPct = steps.length ? (doneN / steps.length) * 100 : 0;

  const groups = groupSteps(steps);

  if (notFound) {
    return (
      <main className="flex flex-col items-center justify-center min-h-screen px-6 text-center">
        <p className="text-6xl font-semibold text-faint mb-4">404</p>
        <p className="text-sm text-muted-foreground mb-6">
          {t.notFound}
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-foreground/75 hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          {t.newRun}
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 pt-10 pb-24">
      {/* back link */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-8"
      >
        <ArrowLeft className="size-3.5" />
        {t.back}
      </Link>

      {/* status header */}
      <section className="mb-8">
        <BigStatus status={status} t={t} />

        <h1 className="text-lg font-semibold tracking-tight mt-5 break-words text-foreground/90">
          {run?.title ?? id}
        </h1>

        {run && (
          <div className="flex items-center justify-between gap-3 mt-1.5">
            <p className="text-xs text-muted-foreground font-mono">
              {steps.length > 0 ? (
                <>
                  <span className="text-foreground/75">{doneN}/{steps.length} {t.steps}</span>
                  {passN > 0 && <span className="text-success ml-2">· {passN} {t.passedCount}</span>}
                  {warnN > 0 && <span className="text-warning ml-2">· {warnN} {t.warnCount}</span>}
                  {failN > 0 && <span className="text-destructive ml-2">· {failN} {t.failedCount}</span>}
                </>
              ) : (
                <span className="text-subtle">
                  {isActive ? t.waitingForPlan : t.noSteps}
                </span>
              )}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              {isActive && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={togglePause}
                  disabled={pauseBusy || status === "waiting"}
                  className="h-7 px-2 text-muted-foreground hover:text-foreground"
                >
                  {status === "paused"
                    ? <><Play className="size-3.5 mr-1" />{t.resume}</>
                    : <><Pause className="size-3.5 mr-1" />{t.pause}</>
                  }
                </Button>
              )}
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground font-mono tabular-nums">
                <Clock className="size-3" />
                {formatDuration(elapsed)}
              </span>
            </div>
          </div>
        )}

        {/* where the time went: with a slow model nearly all of it is waiting for its answers */}
        {run?.stats && run.stats.calls > 0 && (
          <p className="mt-1 text-[11px] font-mono tabular-nums text-subtle">
            {t.statsModel} {formatDuration(run.stats.modelMs)} · {run.stats.calls} {t.statsCalls} · {t.statsBrowser}{" "}
            {formatDuration(run.stats.browserMs)}
          </p>
        )}

        {steps.length > 0 && (
          <div className="relative mt-3 h-[3px] rounded-full bg-surface-hover overflow-hidden">
            <div
              className={cn(
                "absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out",
                status === "failed" || status === "error" ? "bg-destructive" : "bg-success",
              )}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}

        {run && !isActive && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            {/* attachments are deleted when a run ends, so such a run is repeated via the editor */}
            {run.attachments.length === 0 && (
              <Button size="sm" onClick={runAgain} disabled={rerunBusy} className="gap-1.5">
                <RotateCw className={cn("size-3.5", rerunBusy && "animate-spin")} />
                {t.runAgain}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={editTestCase} className="gap-1.5">
              <Pencil className="size-3.5" />
              {t.editAndRun}
            </Button>
            {steps.length > 0 && (
              <>
                <Button size="sm" variant="outline" onClick={copyReport} className="gap-1.5 sm:ml-auto">
                  {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
                  {copied ? t.copied : t.copyReport}
                </Button>
                <Button size="sm" variant="outline" onClick={downloadReport} className="gap-1.5">
                  <Download className="size-3.5" />
                  {t.downloadReport}
                </Button>
              </>
            )}
          </div>
        )}
        {actionError && <p className="mt-2 text-xs text-destructive">{actionError}</p>}
      </section>

      {/* steps */}
      <section className="space-y-2">
        {/* a run can end (crash, config error) before the agent ever set a plan —
            keep spinning only while it is actually still going */}
        {steps.length === 0 && (
          isActive ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Loader2 className="size-5 text-faint animate-spin mb-3" />
              <p className="text-sm text-subtle">
                {t.waitingToStart}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <CircleAlert className="size-5 text-faint mb-3" />
              <p className="text-sm text-subtle">
                {t.endedBeforePlan}
              </p>
              <p className="text-xs text-subtle mt-1">
                {t.seeReason}
              </p>
            </div>
          )
        )}
        {groups.map((g, gi) => (
          <div key={gi} className="space-y-2">
            {g.title && (
              <div className="pt-4 first:pt-0 text-[10.5px] font-semibold uppercase tracking-widest text-subtle">
                {g.title}
              </div>
            )}
            {g.steps.map((s, i) => (
              <div key={s.num} id={`step-${s.num}`} className="scroll-mt-6">
                <StepCard
                  t={t}
                  step={s}
                  displayNum={i + 1}
                  active={s.num === activeStepNum}
                  events={events.filter((e) => e.stepNum === s.num)}
                />
              </div>
            ))}
          </div>
        ))}
      </section>

      {/* summary */}
      {run?.summary && (
        <div className="mt-6 rounded-xl border border-border bg-card/60 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-subtle mb-1.5">
            {t.summary}
          </div>
          <div className="text-sm leading-relaxed text-foreground/80">{run.summary}</div>
        </div>
      )}

      {/* test case instruction */}
      {run?.testCase && (
        <Collapsible className="mt-3">
          <div className="rounded-xl border border-border bg-card/60 overflow-hidden">
            <CollapsibleTrigger className="group w-full flex items-center justify-between px-4 py-3 hover:bg-surface transition-colors">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-subtle">
                {t.testCase}
              </span>
              <ChevronRight className="size-3.5 text-faint group-data-open:hidden" />
              <ChevronDown className="size-3.5 text-faint hidden group-data-open:inline" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="px-4 pb-4 text-[11.5px] font-mono leading-relaxed text-foreground/75 whitespace-pre-wrap break-words border-t border-border pt-3">
                {run.testCase}
              </pre>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}

      {/* files the agent could upload during this run */}
      {run?.attachments && run.attachments.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-subtle mr-1">
            <Paperclip className="size-3" />
            {t.attached}
          </span>
          {run.attachments.map((a) => (
            <span
              key={a.name}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1"
            >
              <span className="text-[11px] font-mono text-foreground/75 max-w-[200px] truncate">
                {a.name}
              </span>
              <span className="text-[10px] tabular-nums text-subtle">
                {formatSize(a.size)}
              </span>
            </span>
          ))}
        </div>
      )}

      {/* star CTA — show once a run has finished (the "you just saw it work" moment) */}
      {(status === "passed" || status === "failed") && <StarCta />}

      {/* question dialog */}
      <Dialog open={!!run?.pending}>
        <DialogContent showCloseButton={false}>
          {run?.pending && <QuestionBody runId={id} question={run.pending} t={t} />}
        </DialogContent>
      </Dialog>
    </main>
  );
}
