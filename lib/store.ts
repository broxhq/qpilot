import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import type { PendingQuestion, PlanGroup, Run, RunEvent } from "./types";

// All state for one run lives in a single entry: the Run, its emitter, pending
// questions, the pause gate, and screenshots (JPEG buffers served via
// GET /api/run/[id]/shot/[num] — never inlined into events).
interface Entry {
  run: Run;
  emitter: EventEmitter;
  waiters: Map<string, (answer: string) => void>;
  pauseGate: (() => void) | null;
  screenshots: Map<number, Buffer>;
}

const g = globalThis as unknown as { __qa_entries?: Map<string, Entry> };
const entries = (g.__qa_entries ??= new Map<string, Entry>());

const ACTIVE = new Set(["running", "waiting", "paused"]);
const MAX_HISTORY = 50;

export function createRun(id: string, title: string, testCase = ""): Run {
  // keep at most MAX_HISTORY finished runs
  const finished = [...entries.entries()].filter(([, e]) => !ACTIVE.has(e.run.status));
  finished
    .sort(([, a], [, b]) => a.run.createdAt - b.run.createdAt)
    .slice(0, Math.max(0, finished.length - MAX_HISTORY + 1))
    .forEach(([k]) => entries.delete(k));
  const run: Run = {
    id,
    createdAt: Date.now(),
    status: "running",
    title,
    testCase,
    events: [],
    steps: [],
    pending: null,
  };
  entries.set(id, {
    run,
    emitter: new EventEmitter(),
    waiters: new Map(),
    pauseGate: null,
    screenshots: new Map(),
  });
  return run;
}

export function getRun(id: string): Run | undefined {
  return entries.get(id)?.run;
}

export function listRuns(): Pick<Run, "id" | "createdAt" | "status" | "title">[] {
  return [...entries.values()]
    .map(({ run }) => ({ id: run.id, createdAt: run.createdAt, status: run.status, title: run.title }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function setPlan(id: string, groups: PlanGroup[]): void {
  const run = getRun(id);
  if (!run) return;
  let num = 0;
  run.steps = groups.flatMap((g) =>
    g.steps.map((raw) => ({
      num: ++num,
      description: raw.replace(/^\s*\d+[.)]\s*/, "").trim(),
      status: "queued" as const,
      group: g.title,
    })),
  );
  pushEvent(id, { ts: Date.now(), kind: "plan", steps: run.steps });
}

export function pushEvent(id: string, event: RunEvent): void {
  const entry = entries.get(id);
  if (!entry) return;
  const run = entry.run;
  run.events.push(event);

  switch (event.kind) {
    case "step":
      if (event.step) {
        const i = run.steps.findIndex((s) => s.num === event.step!.num);
        if (i >= 0) run.steps[i] = { ...run.steps[i], ...event.step };
        else run.steps.push(event.step);
      }
      break;
    case "done":
      // Derive the verdict from steps, don't trust finish's argument:
      // any failed step => failed (the model can't "pass" a run with failures).
      run.status = run.steps.some((s) => s.status === "fail")
        ? "failed"
        : (event.status ?? "passed");
      event.status = run.status;
      run.summary = event.summary;
      run.pending = null;
      run.steps = run.steps.map((s) =>
        s.status === "queued" ? { ...s, status: "skipped" as const } : s,
      );
      break;
    case "error":
      run.status = "error";
      run.summary = event.text;
      run.pending = null;
      break;
    case "question":
      if (event.question) {
        run.status = "waiting";
        run.pending = event.question;
      }
      break;
    case "answer":
      run.status = "running";
      run.pending = null;
      break;
    case "paused":
      run.status = "paused";
      break;
    case "resumed":
      run.status = "running";
      break;
  }

  entry.emitter.emit("event", event);
}

export function subscribe(id: string, listener: (e: RunEvent) => void): () => void {
  const emitter = entries.get(id)?.emitter;
  if (!emitter) return () => {};
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

// ── screenshots ──────────────────────────────────────────────────────────────

export function saveScreenshot(id: string, num: number, buf: Buffer): void {
  entries.get(id)?.screenshots.set(num, buf);
}

export function getScreenshot(id: string, num: number): Buffer | undefined {
  return entries.get(id)?.screenshots.get(num);
}

// ── questions (human-in-the-loop) ────────────────────────────────────────────

export function askQuestion(
  runId: string,
  prompt: string,
  secret: boolean,
): Promise<string> {
  const questionId = crypto.randomBytes(4).toString("hex");
  pushEvent(runId, {
    ts: Date.now(),
    kind: "question",
    question: { id: questionId, prompt, secret } satisfies PendingQuestion,
  });
  return new Promise<string>((resolve) => {
    entries.get(runId)?.waiters.set(questionId, resolve);
  });
}

export function answerQuestion(
  runId: string,
  questionId: string,
  answer: string,
): boolean {
  const entry = entries.get(runId);
  const resolver = entry?.waiters.get(questionId);
  if (!entry || !resolver) return false;
  entry.waiters.delete(questionId);
  pushEvent(runId, { ts: Date.now(), kind: "answer", text: "(user answer received)" });
  resolver(answer);
  return true;
}

// ── pause ────────────────────────────────────────────────────────────────────

export function pauseRun(id: string): boolean {
  const run = getRun(id);
  if (!run || run.status !== "running") return false;
  pushEvent(id, { ts: Date.now(), kind: "paused" });
  return true;
}

export function resumeRun(id: string): boolean {
  const entry = entries.get(id);
  if (!entry || entry.run.status !== "paused") return false;
  const resolve = entry.pauseGate;
  entry.pauseGate = null;
  pushEvent(id, { ts: Date.now(), kind: "resumed" });
  resolve?.();
  return true;
}

export function checkPause(id: string): Promise<void> {
  const entry = entries.get(id);
  if (!entry || entry.run.status !== "paused") return Promise.resolve();
  return new Promise<void>((resolve) => {
    entry.pauseGate = resolve;
  });
}
