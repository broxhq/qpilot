import { useSyncExternalStore } from "react";
import type { RunStatus } from "./types";

// What the home page holds: the draft, the chosen folder, attachments and the
// batch in progress. It lives outside React on purpose — opening a run and
// coming back unmounts the page, and a batch has to keep going meanwhile.

export interface CaseFile {
  name: string;
  file: File;
}

export interface BatchItem {
  name: string;
  id: string | null;
  status: "queued" | "skipped" | RunStatus;
  startedAt?: number;
  finishedAt?: number;
}

export interface HomeState {
  /** The test case in the editor. */
  text: string;
  /** .md files of the chosen folder. */
  files: CaseFile[];
  /** The file shown in the editor. */
  selected: string | null;
  /** Files ticked for a batch run. */
  checked: string[];
  /** Files the agent may upload during a run. */
  attachments: File[];
  batch: {
    items: BatchItem[];
    running: boolean;
    startedAt: number | null;
    finishedAt: number | null;
  };
}

// keep in sync with lib/attachments.ts
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ACTIVE = new Set<string>(["running", "waiting", "paused"]);
const DRAFT_KEY = "qpilot:text";
const PREFILL_KEY = "qpilot:prefill";

const EMPTY: HomeState = {
  text: "",
  files: [],
  selected: null,
  checked: [],
  attachments: [],
  batch: { items: [], running: false, startedAt: null, finishedAt: null },
};

let state = EMPTY;
const listeners = new Set<() => void>();

function update(patch: Partial<HomeState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useHome(): HomeState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => EMPTY,
  );
}

// ── editor ───────────────────────────────────────────────────────────────────

export function setText(text: string): void {
  update({ text });
  try {
    sessionStorage.setItem(DRAFT_KEY, text);
  } catch {}
}

/**
 * Called when the page mounts. "Edit test case" on a run page hands its text
 * over; otherwise the draft survives a reload.
 */
export function restoreDraft(): void {
  try {
    const prefill = sessionStorage.getItem(PREFILL_KEY);
    if (prefill !== null) {
      sessionStorage.removeItem(PREFILL_KEY);
      setText(prefill);
      update({ selected: null });
    } else if (!state.text) {
      const draft = sessionStorage.getItem(DRAFT_KEY);
      if (draft) update({ text: draft });
    }
  } catch {}
}

// ── folder of test cases ─────────────────────────────────────────────────────

export function setFolder(picked: File[]): void {
  const files = picked
    .filter((f) => f.name.endsWith(".md"))
    .map((f) => ({ name: f.webkitRelativePath || f.name, file: f }))
    .sort((a, b) => a.name.localeCompare(b.name));
  update({ files, selected: null, checked: [], batch: EMPTY.batch });
}

export function clearFolder(): void {
  update({ files: [], selected: null, checked: [], batch: EMPTY.batch });
}

export async function openFile(f: CaseFile): Promise<void> {
  setText(await f.file.text());
  update({ selected: f.name });
}

export function toggleChecked(name: string): void {
  const checked = state.checked.includes(name)
    ? state.checked.filter((n) => n !== name)
    : [...state.checked, name];
  update({ checked });
}

export function toggleAll(): void {
  update({
    checked: state.checked.length === state.files.length ? [] : state.files.map((f) => f.name),
  });
}

// ── attachments ──────────────────────────────────────────────────────────────

/** Returns what is wrong with the files, or null when they were added. */
export function addAttachments(incoming: File[]): string | null {
  if (!incoming.length) return null;
  const tooBig = incoming.find((f) => f.size > MAX_ATTACHMENT_BYTES);
  if (tooBig) return `"${tooBig.name}" is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`;
  // by name, so picking the same file again does not stack it up
  const byName = new Map(state.attachments.map((f) => [f.name, f]));
  for (const f of incoming) byName.set(f.name, f);
  if (byName.size > MAX_ATTACHMENTS) return `At most ${MAX_ATTACHMENTS} attachments per run`;
  update({ attachments: [...byName.values()] });
  return null;
}

export function removeAttachment(name: string): void {
  update({ attachments: state.attachments.filter((f) => f.name !== name) });
}

// ── runs ─────────────────────────────────────────────────────────────────────

/** Starts a run with the current attachments and returns its id. */
export async function startRun(testCase: string, headless: boolean): Promise<string> {
  const form = new FormData();
  form.append("testCase", testCase);
  form.append("headless", String(headless));
  for (const f of state.attachments) form.append("files", f);
  const res = await fetch("/api/run", { method: "POST", body: form });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || "error");
  return json.id;
}

// ── batch: the ticked files, one after another ───────────────────────────────

let stopRequested = false;
let currentRun: string | null = null;

function setItem(index: number, patch: Partial<BatchItem>): void {
  const items = state.batch.items.map((it, i) => (i === index ? { ...it, ...patch } : it));
  update({ batch: { ...state.batch, items } });
}

function skipFrom(index: number): void {
  const items = state.batch.items.map((it, i) =>
    i >= index ? { ...it, status: "skipped" as const } : it,
  );
  update({ batch: { ...state.batch, items } });
}

function waitForRun(id: string): Promise<RunStatus> {
  return new Promise((resolve) => {
    const es = new EventSource(`/api/run/${id}/stream`);
    const finish = (status: RunStatus) => {
      clearInterval(watch);
      es.close();
      resolve(status);
    };
    const watch = setInterval(() => {
      if (stopRequested) finish("paused");
    }, 150);
    es.onmessage = (msg) => {
      const status: RunStatus | undefined = JSON.parse(msg.data).run?.status;
      if (stopRequested) finish("paused");
      else if (status && !ACTIVE.has(status)) finish(status);
    };
    es.onerror = () => finish("error");
  });
}

export async function runBatch(headless: boolean): Promise<void> {
  const files = state.files.filter((f) => state.checked.includes(f.name));
  if (!files.length || state.batch.running) return;

  stopRequested = false;
  currentRun = null;
  update({
    batch: {
      items: files.map((f) => ({ name: f.name, id: null, status: "queued" })),
      running: true,
      startedAt: Date.now(),
      finishedAt: null,
    },
  });

  for (let i = 0; i < files.length; i++) {
    if (stopRequested) {
      skipFrom(i);
      break;
    }
    setItem(i, { status: "running", startedAt: Date.now() });
    try {
      const id = await startRun(await files[i].file.text(), headless);
      currentRun = id;
      setItem(i, { id });
      setItem(i, { status: await waitForRun(id), finishedAt: Date.now() });
    } catch {
      setItem(i, { status: "error", finishedAt: Date.now() });
    }
  }

  currentRun = null;
  update({ batch: { ...state.batch, running: false, finishedAt: Date.now() } });
}

/** Pauses the run in progress and skips the rest of the batch. */
export function stopBatch(): void {
  stopRequested = true;
  if (!currentRun) return;
  fetch(`/api/run/${currentRun}/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "pause" }),
  }).catch(() => {});
}
