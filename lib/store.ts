import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import type { PendingQuestion, PlanGroup, Run, RunEvent } from "./types";

const g = globalThis as unknown as {
  __qa_runs?: Map<string, Run>;
  __qa_emitters?: Map<string, EventEmitter>;
  __qa_waiters?: Map<string, (answer: string) => void>;
  __qa_pause_gates?: Map<string, () => void>;
};
const runs = (g.__qa_runs ??= new Map<string, Run>());
const emitters = (g.__qa_emitters ??= new Map<string, EventEmitter>());
const waiters = (g.__qa_waiters ??= new Map<string, (answer: string) => void>());
const pauseGates = (g.__qa_pause_gates ??= new Map<string, () => void>());

export function createRun(id: string, title: string): Run {
  for (const [k, v] of runs.entries()) {
    if (v.status !== "running" && v.status !== "waiting" && v.status !== "paused") {
      runs.delete(k);
      emitters.delete(k);
    }
  }
  const run: Run = {
    id,
    createdAt: Date.now(),
    status: "running",
    title,
    events: [],
    steps: [],
    pending: null,
  };
  runs.set(id, run);
  emitters.set(id, new EventEmitter());
  return run;
}

export function getRun(id: string): Run | undefined {
  return runs.get(id);
}

export function setPlan(id: string, groups: PlanGroup[]): void {
  const run = runs.get(id);
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
  const run = runs.get(id);
  if (!run) return;
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
      run.status = event.status ?? "passed";
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

  emitters.get(id)?.emit("event", event);
}

export function subscribe(id: string, listener: (e: RunEvent) => void): () => void {
  const emitter = emitters.get(id);
  if (!emitter) return () => {};
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

export function askQuestion(
  runId: string,
  prompt: string,
  secret: boolean,
): Promise<string> {
  const questionId = crypto.randomBytes(4).toString("hex");
  const question: PendingQuestion = { id: questionId, prompt, secret };
  pushEvent(runId, { ts: Date.now(), kind: "question", question });
  return new Promise<string>((resolve) => {
    waiters.set(questionId, resolve);
  });
}

export function answerQuestion(
  runId: string,
  questionId: string,
  answer: string,
): boolean {
  const resolver = waiters.get(questionId);
  if (!resolver) return false;
  waiters.delete(questionId);
  pushEvent(runId, { ts: Date.now(), kind: "answer", text: "(user answer received)" });
  resolver(answer);
  return true;
}

export function pauseRun(id: string): boolean {
  const run = runs.get(id);
  if (!run || run.status !== "running") return false;
  pushEvent(id, { ts: Date.now(), kind: "paused" });
  return true;
}

export function resumeRun(id: string): boolean {
  const run = runs.get(id);
  if (!run || run.status !== "paused") return false;
  const resolve = pauseGates.get(id);
  pauseGates.delete(id);
  pushEvent(id, { ts: Date.now(), kind: "resumed" });
  resolve?.();
  return true;
}

export function checkPause(id: string): Promise<void> {
  const run = runs.get(id);
  if (!run || run.status !== "paused") return Promise.resolve();
  return new Promise<void>((resolve) => {
    pauseGates.set(id, resolve);
  });
}
