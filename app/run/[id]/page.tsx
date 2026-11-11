"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  Download,
  Loader2,
  Paperclip,
  Pause,
  Pencil,
  Play,
  RotateCw,
  Star,
  X,
} from "lucide-react";
import type {
  PendingQuestion,
  Run,
  RunEvent,
  StepResult,
} from "@/lib/types";
import { updateFavicon, resetFavicon } from "@/lib/favicon";
import { dict, type Dict } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn, formatDuration } from "@/lib/utils";
import { reportHtml, reportMarkdown } from "@/lib/report";

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

  const groups: { title?: string; steps: StepResult[] }[] = [];
  for (const s of steps) {
    const last = groups[groups.length - 1];
    if (last && last.title === s.group) last.steps.push(s);
    else groups.push({ title: s.group, steps: [s] });
  }

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function StarCta() {
  return (
    <a
      href="https://github.com/broxhq/qpilot"
      target="_blank"
      rel="noreferrer"
      className="group mt-6 flex items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-3 transition-colors hover:border-warning/30 hover:bg-warning/[0.03]"
    >
      <Star className="size-4 shrink-0 text-subtle transition-colors group-hover:text-warning group-hover:fill-warning" />
      <div className="min-w-0">
        <div className="text-sm text-foreground/80">
          Did qpilot save you time?{" "}
          <span className="text-foreground/95 group-hover:text-warning transition-colors">
            Star it on GitHub
          </span>
        </div>
        <div className="text-xs text-subtle">
          A ⭐ helps more people find it — takes two seconds.
        </div>
      </div>
    </a>
  );
}


interface StatusCfg {
  icon: React.ReactNode;
  color: string;
  bg: string;
  border: string;
  ring?: string;
}

// only the visuals live here — label and sub come from the run's language
const STATUS_CFG: Record<string, StatusCfg> = {
  running: {
    icon: <Loader2 className="size-4 animate-spin" />,
    color: "text-foreground/75",
    bg: "bg-surface-hover",
    border: "border-border",
  },
  waiting: {
    icon: <CircleAlert className="size-4" />,
    color: "text-warning",
    bg: "bg-warning/10",
    border: "border-warning/20",
  },
  paused: {
    icon: <Pause className="size-4" />,
    color: "text-foreground/75",
    bg: "bg-surface-hover",
    border: "border-border",
  },
  passed: {
    icon: <Check className="size-4" strokeWidth={2.5} />,
    color: "text-success",
    bg: "bg-success/10",
    border: "border-success/20",
  },
  failed: {
    icon: <X className="size-4" strokeWidth={2.5} />,
    color: "text-destructive",
    bg: "bg-destructive/10",
    border: "border-destructive/20",
  },
  error: {
    icon: <CircleAlert className="size-4" />,
    color: "text-destructive",
    bg: "bg-destructive/10",
    border: "border-destructive/20",
  },
};

function BigStatus({ status, t }: { status: string; t: Dict }) {
  const v = STATUS_CFG[status] ?? STATUS_CFG.running;
  const text = t.status[status] ?? t.status.running;
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          "flex items-center justify-center size-9 rounded-xl border transition-colors",
          v.bg,
          v.border,
          v.color,
        )}
      >
        {v.icon}
      </div>
      <div>
        <div className={cn("text-sm font-semibold tracking-tight", v.color)}>
          {text.label}
        </div>
        <div className="text-xs text-muted-foreground">{text.sub}</div>
      </div>
    </div>
  );
}

const STEP_ACCENT: Record<string, { border: string; badge: string; bg: string }> = {
  queued:  { border: "border-l-border-strong",       badge: "bg-surface-hover text-subtle",     bg: ""                      },
  pass:    { border: "border-l-success/60",     badge: "bg-success/10 text-success",              bg: ""                      },
  warn:    { border: "border-l-warning/60",     badge: "bg-warning/10 text-warning",              bg: ""                      },
  fail:    { border: "border-l-destructive/60", badge: "bg-destructive/10 text-destructive",      bg: "bg-destructive/[0.03]" },
  skipped: { border: "border-l-border-strong",        badge: "bg-surface text-faint",     bg: ""                      },
};

const ACTIVE_ACCENT = {
  border: "border-l-warning/80",
  badge: "bg-warning/10 text-warning",
  bg: "bg-warning/[0.03]",
};

function isVisibleLog(e: RunEvent): boolean {
  if (
    e.kind === "action" &&
    (e.toolName === "report_step" || e.toolName === "finish" || e.toolName === "set_plan")
  )
    return false;
  if (e.kind === "observation") {
    const t = e.text ?? "";
    return t.startsWith("Error:") || t.startsWith("[debug]");
  }
  return true;
}

function StepCard({
  step,
  events,
  active,
  displayNum,
  t,
}: {
  step: StepResult;
  events: RunEvent[];
  active: boolean;
  displayNum?: number;
  t: Dict;
}) {
  const base = STEP_ACCENT[step.status] ?? STEP_ACCENT.queued;
  const a = active ? { ...base, ...ACTIVE_ACCENT } : base;
  const visible = events.filter(isVisibleLog);
  // the model's reasoning is noise for a tester reading the report — one click away
  const thoughtN = visible.filter((e) => e.kind === "thought").length;
  const [showThoughts, setShowThoughts] = useState(false);
  const logs = showThoughts ? visible : visible.filter((e) => e.kind !== "thought");
  const verdictFailed = step.status === "fail" || step.status === "warn";

  const autoOpen = active || step.status === "fail";
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => setOpen(autoOpen), [autoOpen]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "rounded-xl border border-border border-l-2 overflow-hidden transition-colors",
          a.border,
          a.bg,
        )}
      >
        <CollapsibleTrigger className="group w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface transition-colors">
          <Badge
            className={cn(
              "border-0 text-[9.5px] tracking-widest font-semibold shrink-0 gap-1 uppercase rounded-md px-1.5",
              a.badge,
            )}
          >
            {active ? (
              <>
                <Loader2 className="size-2.5 animate-spin" />
                {t.stepStatus.running}
              </>
            ) : (
              t.stepStatus[step.status] ?? step.status
            )}
          </Badge>
          <span className="flex-1 min-w-0 text-[13px] text-foreground/80">
            <span className="text-subtle mr-2 font-mono text-[11px]">
              {String(displayNum ?? step.num).padStart(2, "0")}
            </span>
            {step.description}
          </span>
          <ChevronRight className="size-3.5 text-faint shrink-0 group-data-open:hidden" />
          <ChevronDown className="size-3.5 text-faint shrink-0 hidden group-data-open:inline" />
        </CollapsibleTrigger>

        {verdictFailed && step.expected ? (
          <dl className="px-4 pb-3 -mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11.5px] leading-relaxed">
            <dt className="text-subtle">{t.expected}</dt>
            <dd className="font-mono text-foreground/80">{step.expected}</dd>
            {step.evidence && (
              <>
                <dt className="text-subtle">{t.actual}</dt>
                <dd className={cn("font-mono", step.status === "fail" ? "text-destructive" : "text-warning")}>
                  {step.evidence}
                </dd>
              </>
            )}
          </dl>
        ) : (
          step.evidence && (
            <div className="px-4 pb-3 -mt-0.5 text-[11.5px] text-muted-foreground leading-relaxed font-mono">
              {step.evidence}
            </div>
          )
        )}

        {step.mockUnverified && (
          <p className="px-4 pb-3 -mt-1 text-[11px] leading-relaxed text-warning/90">⚠ {t.mockUnverified}</p>
        )}

        {step.consoleErrors && step.consoleErrors.length > 0 && (
          <details className="px-4 pb-3 -mt-1 text-[11px] text-warning/90">
            <summary className="cursor-pointer select-none">
              {t.consoleErrors}: {step.consoleErrors.length}
            </summary>
            <ul className="mt-1.5 space-y-1 font-mono text-muted-foreground">
              {step.consoleErrors.map((e, i) => (
                <li key={i} className="break-words">{e}</li>
              ))}
            </ul>
          </details>
        )}

        <CollapsibleContent>
          <div className="px-4 pb-4 pt-3 space-y-3 border-t border-border">
            {step.screenshot && (
              <a
                href={step.screenshot}
                target="_blank"
                rel="noreferrer"
                className="block rounded-lg overflow-hidden border border-border hover:border-border-strong transition-colors"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={step.screenshot}
                  alt={`screenshot step ${step.num}`}
                  className="max-h-64 w-full object-contain bg-surface"
                />
              </a>
            )}
            {logs.length > 0 ? (
              <div className="space-y-0.5">
                {logs.map((e, i) => (
                  <LogLine key={i} event={e} t={t} />
                ))}
              </div>
            ) : (
              thoughtN === 0 && (
                <div className="text-[11px] text-faint">
                  {t.noEvents}
                </div>
              )
            )}
            {thoughtN > 0 && (
              <button
                type="button"
                onClick={() => setShowThoughts((v) => !v)}
                className="text-[11px] text-subtle hover:text-foreground transition-colors"
              >
                {showThoughts ? t.hideReasoning : `${t.showReasoning} (${thoughtN})`}
              </button>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function describeAction(name?: string, input?: unknown, t: Dict = dict("en")): string {
  const p = (input ?? {}) as Record<string, unknown>;
  const a = t.action;
  switch (name) {
    case "navigate": return `${a.opening} ${p.url ?? ""}`;
    case "snapshot": return p.near ? `${a.readingBlock} "${p.near}"` : a.readingPage;
    case "click":    return p.name ? `${a.clicking} "${p.name}"` : a.clickingElement;
    case "fill":     return p.name ? `${a.filling} "${p.name}" → "${p.value ?? ""}"` : `${a.filling} "${p.value ?? ""}"`;
    case "select":   return p.name ? `${a.selecting} "${p.value ?? ""}" — "${p.name}"` : `${a.selecting} "${p.value ?? ""}"`;
    case "hover":    return p.name ? `${a.hovering} "${p.name}"` : a.hoveringElement;
    case "scroll_to": return `${a.scrollingTo} ${p.text ? `"${p.text}"` : p.ref ?? ""}`;
    case "scroll": {
      const dirs = [
        Number(p.y) ? `${Number(p.y) > 0 ? a.down : a.up} ${Math.abs(Number(p.y))}px` : "",
        Number(p.x) ? `${Number(p.x) > 0 ? a.right : a.left} ${Math.abs(Number(p.x))}px` : "",
      ].filter(Boolean).join(", ");
      const target = p.ref ? ` ${a.inside} ${p.ref}` : "";
      return `${a.scrolling} ${dirs || "0px"}${target}`;
    }
    case "press":    return `${a.pressing} ${p.key ?? ""}`;
    case "upload_file": return `${a.uploading} "${p.file ?? ""}"${p.name ? ` ${a.to} "${p.name}"` : ""}`;
    case "dismiss":  return a.closingOverlay;
    case "wait":     return `${a.waiting} ${p.ms ?? ""} ms`;
    case "ask_user": return a.askingUser;
    case "wait_for": return `${p.gone ? a.waitingGone : a.waitingFor} "${p.text ?? ""}"`;
    case "switch_tab": return `${a.switchingTab} ${p.index ?? ""}`;
    case "handle_dialog": return `${a.nextDialog} ${p.action === "dismiss" ? a.dialogDismiss : a.dialogAccept}`;
    case "mock_request": {
      const how = p.abort
        ? a.mockAbort
        : p.patch !== undefined
          ? a.mockPatch
          : p.status !== undefined || p.body !== undefined
            ? String(p.status ?? 200)
            : "";
      const delay = p.delay_ms ? `${a.mockDelay} ${p.delay_ms} ms` : "";
      const target = `${p.method ? `${p.method} ` : ""}${p.url ?? ""}`;
      return `${a.mocking} ${target} → ${[how, delay].filter(Boolean).join(", ")}`;
    }
    case "clear_mocks": return a.clearingMocks;
    case "set_offline": return p.offline === false ? a.goingOnline : a.goingOffline;
    case "get_requests": {
      const find = p.find ?? p.url;
      return find ? `${a.readingRequests} "${find}"` : a.readingRequests;
    }
    case "note": return `${a.noting} ${p.text ?? ""}`;
    case "get_console": return a.readingConsole;
    default:         return name ?? "action";
  }
}

function renderLog(e: RunEvent, t: Dict): { icon: string; text: string; cls: string } {
  switch (e.kind) {
    case "action":
      return { icon: "→", text: describeAction(e.toolName, e.toolInput, t), cls: "text-foreground/75" };
    case "step": {
      const s = e.step?.status ?? "";
      const cls = s === "pass" ? "text-success" : s === "fail" ? "text-destructive" : "text-warning";
      const icon = s === "pass" ? "✓" : s === "fail" ? "✗" : "!";
      return { icon, text: `${t.stepLabel} ${e.step?.num} — ${(t.stepStatus[s] ?? s).toUpperCase()}`, cls };
    }
    case "observation": {
      const t = e.text ?? "";
      if (t.startsWith("Error:")) return { icon: "✗", text: t, cls: "text-destructive" };
      return { icon: "·", text: t, cls: "text-subtle" };
    }
    case "info": {
      const i = e.info;
      const text = !i
        ? (e.text ?? "")
        : i.type === "dialog"
          ? `${t.infoDialog} (${i.dialog}): «${i.message}» — ${i.accepted ? t.infoAccepted : t.infoDismissed}`
          : `${i.type === "newTab" ? t.infoNewTab : t.infoTabClosed}: ${i.url}`;
      return { icon: "•", text, cls: "text-warning/90" };
    }
    case "question":
      return { icon: "?", text: `${t.asking}: ${e.question?.prompt ?? ""}`, cls: "text-warning" };
    case "answer":
      return { icon: "✎", text: t.userAnswered, cls: "text-foreground/75" };
    case "thought":
      return { icon: "›", text: e.text ?? "", cls: "text-subtle italic" };
    case "done":
      return { icon: "■", text: `${t.runFinished} — ${t.status[e.status ?? ""]?.label ?? e.status ?? ""}`, cls: "text-foreground/75" };
    case "error":
      return { icon: "✗", text: e.text ?? "", cls: "text-destructive" };
    default:
      return { icon: "·", text: "", cls: "text-faint" };
  }
}

function LogLine({ event, t }: { event: RunEvent; t: Dict }) {
  const { icon, text, cls } = renderLog(event, t);
  const time = new Date(event.ts).toLocaleTimeString("en-US", { hour12: false });
  return (
    <div className="flex gap-2.5 text-[11.5px] leading-relaxed items-baseline font-mono">
      <span className="shrink-0 tabular-nums text-faint text-[10px]">
        {time}
      </span>
      <span className={cn("shrink-0 w-3.5 text-center", cls)}>{icon}</span>
      <span className={cn("min-w-0 break-words", cls)}>{text}</span>
    </div>
  );
}

function QuestionBody({
  runId,
  question,
  t,
}: {
  runId: string;
  question: PendingQuestion;
  t: Dict;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/run/${runId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: question.id, answer: value }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-base">
          <CircleAlert className="size-4 text-warning shrink-0" />
          {t.needInput}
        </DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground leading-relaxed">{question.prompt}</p>
      <Input
        autoFocus
        type={question.secret ? "password" : "text"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={question.secret ? t.secretPlaceholder : t.answerPlaceholder}
        className="font-mono"
      />
      {error && <p className="text-destructive text-xs">{error}</p>}
      <Button type="submit" disabled={!value || busy} className="w-full">
        {busy ? t.sending : t.submit}
      </Button>
    </form>
  );
}
