"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Loader2,
  Pause,
  Play,
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
import { cn } from "@/lib/utils";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function RunPage({ params }: PageProps) {
  const { id } = use(params);
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pauseBusy, setPauseBusy] = useState(false);
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
        <p className="text-6xl font-semibold text-muted-foreground/20 mb-4">404</p>
        <p className="text-sm text-muted-foreground mb-6">
          Run not found — it may have finished and been cleared from memory.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-foreground/70 hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-3.5" />
          New run
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
        Back
      </Link>

      {/* status header */}
      <section className="mb-8">
        <BigStatus status={status} />

        <h1 className="text-lg font-semibold tracking-tight mt-5 break-words text-foreground/90">
          {run?.title ?? id}
        </h1>

        {run && (
          <div className="flex items-center justify-between gap-3 mt-1.5">
            <p className="text-xs text-muted-foreground font-mono">
              {steps.length > 0 ? (
                <>
                  <span className="text-foreground/60">{doneN}/{steps.length} steps</span>
                  {passN > 0 && <span className="text-success ml-2">· {passN} passed</span>}
                  {warnN > 0 && <span className="text-warning ml-2">· {warnN} warn</span>}
                  {failN > 0 && <span className="text-destructive ml-2">· {failN} failed</span>}
                </>
              ) : (
                <span className="text-muted-foreground/50">waiting for plan…</span>
              )}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              {isActive && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={togglePause}
                  disabled={pauseBusy || status === "waiting"}
                  className="h-7 px-2 text-muted-foreground/60 hover:text-foreground"
                >
                  {status === "paused"
                    ? <><Play className="size-3.5 mr-1" />Resume</>
                    : <><Pause className="size-3.5 mr-1" />Pause</>
                  }
                </Button>
              )}
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/60 font-mono tabular-nums">
                <Clock className="size-3" />
                {formatDuration(elapsed)}
              </span>
            </div>
          </div>
        )}

        {steps.length > 0 && (
          <div className="relative mt-3 h-[3px] rounded-full bg-white/5 overflow-hidden">
            <div
              className={cn(
                "absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out",
                status === "failed" || status === "error" ? "bg-destructive" : "bg-success",
              )}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </section>

      {/* steps */}
      <section className="space-y-2">
        {steps.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Loader2 className="size-5 text-muted-foreground/30 animate-spin mb-3" />
            <p className="text-sm text-muted-foreground/50">
              waiting for agent to start…
            </p>
          </div>
        )}
        {groups.map((g, gi) => (
          <div key={gi} className="space-y-2">
            {g.title && (
              <div className="pt-4 first:pt-0 text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                {g.title}
              </div>
            )}
            {g.steps.map((s, i) => (
              <div key={s.num} id={`step-${s.num}`} className="scroll-mt-6">
                <StepCard
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
        <div className="mt-6 rounded-xl border border-white/7 bg-card/60 px-4 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40 mb-1.5">
            Summary
          </div>
          <div className="text-sm leading-relaxed text-foreground/80">{run.summary}</div>
        </div>
      )}

      {/* test case instruction */}
      {run?.testCase && (
        <Collapsible className="mt-3">
          <div className="rounded-xl border border-white/7 bg-card/60 overflow-hidden">
            <CollapsibleTrigger className="group w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                Test case
              </span>
              <ChevronRight className="size-3.5 text-muted-foreground/30 group-data-open:hidden" />
              <ChevronDown className="size-3.5 text-muted-foreground/30 hidden group-data-open:inline" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="px-4 pb-4 text-[11.5px] font-mono leading-relaxed text-foreground/60 whitespace-pre-wrap break-words border-t border-white/5 pt-3">
                {run.testCase}
              </pre>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}

      {/* star CTA — show once a run has finished (the "you just saw it work" moment) */}
      {(status === "passed" || status === "failed") && <StarCta />}

      {/* question dialog */}
      <Dialog open={!!run?.pending}>
        <DialogContent showCloseButton={false}>
          {run?.pending && <QuestionBody runId={id} question={run.pending} />}
        </DialogContent>
      </Dialog>
    </main>
  );
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function StarCta() {
  return (
    <a
      href="https://github.com/broxhq/qpilot"
      target="_blank"
      rel="noreferrer"
      className="group mt-6 flex items-center gap-3 rounded-xl border border-white/7 bg-card/60 px-4 py-3 transition-colors hover:border-warning/30 hover:bg-warning/[0.03]"
    >
      <Star className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-warning group-hover:fill-warning" />
      <div className="min-w-0">
        <div className="text-sm text-foreground/80">
          Did qpilot save you time?{" "}
          <span className="text-foreground/95 group-hover:text-warning transition-colors">
            Star it on GitHub
          </span>
        </div>
        <div className="text-xs text-muted-foreground/50">
          A ⭐ helps more people find it — takes two seconds.
        </div>
      </div>
    </a>
  );
}


interface StatusCfg {
  label: string;
  sub: string;
  icon: React.ReactNode;
  color: string;
  bg: string;
  border: string;
  ring?: string;
}

const STATUS_CFG: Record<string, StatusCfg> = {
  running: {
    label: "Running",
    sub: "agent is executing steps",
    icon: <Loader2 className="size-4 animate-spin" />,
    color: "text-foreground/70",
    bg: "bg-white/5",
    border: "border-white/10",
  },
  waiting: {
    label: "Waiting",
    sub: "agent needs your input",
    icon: <CircleAlert className="size-4" />,
    color: "text-warning",
    bg: "bg-warning/10",
    border: "border-warning/20",
  },
  paused: {
    label: "Paused",
    sub: "run is paused",
    icon: <Pause className="size-4" />,
    color: "text-foreground/50",
    bg: "bg-white/5",
    border: "border-white/10",
  },
  passed: {
    label: "Passed",
    sub: "all steps passed",
    icon: <Check className="size-4" strokeWidth={2.5} />,
    color: "text-success",
    bg: "bg-success/10",
    border: "border-success/20",
  },
  failed: {
    label: "Failed",
    sub: "some steps failed",
    icon: <X className="size-4" strokeWidth={2.5} />,
    color: "text-destructive",
    bg: "bg-destructive/10",
    border: "border-destructive/20",
  },
  error: {
    label: "Error",
    sub: "agent crashed",
    icon: <CircleAlert className="size-4" />,
    color: "text-destructive",
    bg: "bg-destructive/10",
    border: "border-destructive/20",
  },
};

function BigStatus({ status }: { status: string }) {
  const v = STATUS_CFG[status] ?? STATUS_CFG.running;
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
          {v.label}
        </div>
        <div className="text-xs text-muted-foreground/60">{v.sub}</div>
      </div>
    </div>
  );
}

const STEP_ACCENT: Record<
  string,
  { border: string; badge: string; bg: string; label: string }
> = {
  queued:  { border: "border-l-white/8",       badge: "bg-white/5 text-muted-foreground/50",     bg: "",                       label: "queued" },
  pass:    { border: "border-l-success/60",     badge: "bg-success/10 text-success",              bg: "",                       label: "pass" },
  warn:    { border: "border-l-warning/60",     badge: "bg-warning/10 text-warning",              bg: "",                       label: "warn" },
  fail:    { border: "border-l-destructive/60", badge: "bg-destructive/10 text-destructive",      bg: "bg-destructive/[0.03]",  label: "fail" },
  skipped: { border: "border-l-white/8",        badge: "bg-white/4 text-muted-foreground/30",     bg: "",                       label: "skipped" },
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
}: {
  step: StepResult;
  events: RunEvent[];
  active: boolean;
  displayNum?: number;
}) {
  const base = STEP_ACCENT[step.status] ?? STEP_ACCENT.queued;
  const a = active ? { ...base, ...ACTIVE_ACCENT } : base;
  const logs = events.filter(isVisibleLog);

  const autoOpen = active || step.status === "fail";
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => setOpen(autoOpen), [autoOpen]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "rounded-xl border border-white/7 border-l-2 overflow-hidden transition-colors",
          a.border,
          a.bg,
        )}
      >
        <CollapsibleTrigger className="group w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors">
          <Badge
            className={cn(
              "border-0 text-[9.5px] tracking-widest font-semibold shrink-0 gap-1 uppercase rounded-md px-1.5",
              a.badge,
            )}
          >
            {active ? (
              <>
                <Loader2 className="size-2.5 animate-spin" />
                running
              </>
            ) : (
              base.label
            )}
          </Badge>
          <span className="flex-1 min-w-0 text-[13px] text-foreground/80">
            <span className="text-muted-foreground/40 mr-2 font-mono text-[11px]">
              {String(displayNum ?? step.num).padStart(2, "0")}
            </span>
            {step.description}
          </span>
          <ChevronRight className="size-3.5 text-muted-foreground/30 shrink-0 group-data-open:hidden" />
          <ChevronDown className="size-3.5 text-muted-foreground/30 shrink-0 hidden group-data-open:inline" />
        </CollapsibleTrigger>

        {step.evidence && (
          <div className="px-4 pb-3 -mt-0.5 text-[11.5px] text-muted-foreground/60 leading-relaxed font-mono">
            {step.evidence}
          </div>
        )}

        <CollapsibleContent>
          <div className="px-4 pb-4 pt-3 space-y-3 border-t border-white/5">
            {step.screenshot && (
              <a
                href={step.screenshot}
                target="_blank"
                rel="noreferrer"
                className="block rounded-lg overflow-hidden border border-white/8 hover:border-white/15 transition-colors"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={step.screenshot}
                  alt={`screenshot step ${step.num}`}
                  className="max-h-64 w-full object-contain bg-black/20"
                />
              </a>
            )}
            {logs.length > 0 ? (
              <div className="space-y-0.5">
                {logs.map((e, i) => (
                  <LogLine key={i} event={e} />
                ))}
              </div>
            ) : (
              <div className="text-[11px] text-muted-foreground/30">
                no events for this step
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function describeAction(name?: string, input?: unknown): string {
  const p = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "navigate": return `Opening ${p.url ?? ""}`;
    case "snapshot": return p.near ? `Reading "${p.near}" block` : "Reading page";
    case "click":    return p.name ? `Clicking "${p.name}"` : "Clicking element";
    case "fill":     return p.name ? `Filling "${p.name}" → "${p.value ?? ""}"` : `Filling "${p.value ?? ""}"`;
    case "select":   return p.name ? `Selecting "${p.value ?? ""}" in "${p.name}"` : `Selecting "${p.value ?? ""}"`;
    case "hover":    return p.name ? `Hovering "${p.name}"` : "Hovering element";
    case "scroll_to": return `Scrolling to ${p.text ? `"${p.text}"` : p.ref ?? "element"}`;
    case "scroll": {
      const dirs = [
        Number(p.y) ? `${Number(p.y) > 0 ? "down" : "up"} ${Math.abs(Number(p.y))}px` : "",
        Number(p.x) ? `${Number(p.x) > 0 ? "right" : "left"} ${Math.abs(Number(p.x))}px` : "",
      ].filter(Boolean).join(", ");
      const target = p.ref ? ` inside ${p.ref}` : "";
      return `Scrolling ${dirs || "0px"}${target}`;
    }
    case "press":    return `Pressing ${p.key ?? ""}`;
    case "dismiss":  return "Closing overlay";
    case "wait":     return `Waiting ${p.ms ?? ""} ms`;
    case "ask_user": return "Asking user";
    default:         return name ?? "action";
  }
}

function renderLog(e: RunEvent): { icon: string; text: string; cls: string } {
  switch (e.kind) {
    case "action":
      return { icon: "→", text: describeAction(e.toolName, e.toolInput), cls: "text-foreground/70" };
    case "step": {
      const s = e.step?.status ?? "";
      const cls = s === "pass" ? "text-success" : s === "fail" ? "text-destructive" : "text-warning";
      const icon = s === "pass" ? "✓" : s === "fail" ? "✗" : "!";
      return { icon, text: `Step ${e.step?.num} — ${s.toUpperCase()}`, cls };
    }
    case "observation": {
      const t = e.text ?? "";
      if (t.startsWith("Error:")) return { icon: "✗", text: t, cls: "text-destructive" };
      return { icon: "·", text: t, cls: "text-muted-foreground/40" };
    }
    case "question":
      return { icon: "?", text: `Asking: ${e.question?.prompt ?? ""}`, cls: "text-warning" };
    case "answer":
      return { icon: "✎", text: "User answered", cls: "text-foreground/50" };
    case "thought":
      return { icon: "›", text: e.text ?? "", cls: "text-muted-foreground/40 italic" };
    case "done":
      return { icon: "■", text: `Run finished — ${e.status ?? ""}`, cls: "text-foreground/60" };
    case "error":
      return { icon: "✗", text: e.text ?? "", cls: "text-destructive" };
    default:
      return { icon: "·", text: "", cls: "text-muted-foreground/30" };
  }
}

function LogLine({ event }: { event: RunEvent }) {
  const { icon, text, cls } = renderLog(event);
  const time = new Date(event.ts).toLocaleTimeString("en-US", { hour12: false });
  return (
    <div className="flex gap-2.5 text-[11.5px] leading-relaxed items-baseline font-mono">
      <span className="shrink-0 tabular-nums text-muted-foreground/25 text-[10px]">
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
}: {
  runId: string;
  question: PendingQuestion;
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
          Agent needs input
        </DialogTitle>
      </DialogHeader>
      <p className="text-sm text-muted-foreground leading-relaxed">{question.prompt}</p>
      <Input
        autoFocus
        type={question.secret ? "password" : "text"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={question.secret ? "OTP / password" : "answer"}
        className="font-mono"
      />
      {error && <p className="text-destructive text-xs">{error}</p>}
      <Button type="submit" disabled={!value || busy} className="w-full">
        {busy ? "Sending…" : "Submit"}
      </Button>
    </form>
  );
}
