"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import {
  Bot, FileText, ArrowRight, Upload, Folder, X,
  Check, CircleAlert, Clock, Loader2, Square, CheckSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { RunStatus } from "@/lib/types";
import { updateFavicon, resetFavicon } from "@/lib/favicon";

type RunSummary = { id: string; createdAt: number; status: RunStatus; title: string };
type MdFile = { name: string; file: File };
type BatchItem = { file: MdFile; id: string | null; status: "queued" | "skipped" | RunStatus; startedAt?: number; finishedAt?: number };

const ACTIVE = new Set(["running", "waiting", "paused"]);

const EXAMPLE = `TC-001 — Login and add item to cart
URL: https://www.saucedemo.com/
Credentials: standard_user / secret_sauce

Steps:
1. Open the home page.
   Expected: login form with Username and Password fields is visible.
2. Enter Username "standard_user" and Password "secret_sauce", click Login.
   Expected: Products page opens with 6 items.
3. Click "Add to cart" on "Sauce Labs Backpack".
   Expected: cart counter shows 1.
4. Click the cart icon.
   Expected: cart contains exactly one item — Sauce Labs Backpack at $29.99.`;

// persists across route transitions within the same tab
let _text = "";
let _mdFiles: MdFile[] = [];
let _selectedFile: string | null = null;
let _checkedFiles: Set<string> = new Set();
let _batchItems: BatchItem[] = [];
let _batchRunning = false;
let _batchAbort = false;
let _batchCurrentId: string | null = null;
let _batchStartedAt: number | null = null;
let _batchFinishedAt: number | null = null;

export default function Home() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState(_text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [mdFiles, setMdFiles] = useState<MdFile[]>(_mdFiles);
  const [selectedFile, setSelectedFile] = useState<string | null>(_selectedFile);
  const [history, setHistory] = useState<RunSummary[]>([]);

  // batch
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(_checkedFiles);
  const [batchItems, setBatchItems] = useState<BatchItem[]>(_batchItems);
  const [batchRunning, setBatchRunning] = useState(_batchRunning);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!batchRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [batchRunning]);

  useEffect(() => {
    fetch("/api/runs").then(r => r.ok ? r.json() : []).then(setHistory).catch(() => {});
  }, []);

  // sync batch state from module-level vars when re-mounting mid-batch
  useEffect(() => {
    if (!_batchRunning) return;
    const t = setInterval(() => {
      setBatchItems([..._batchItems]);
      setBatchRunning(_batchRunning);
      if (!_batchRunning) clearInterval(t);
    }, 200);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // favicon: spin while batch running, show result when done
  useEffect(() => {
    if (batchRunning) {
      updateFavicon("running");
    } else if (_batchItems.length > 0) {
      const hasError = _batchItems.some(it => it.status === "failed" || it.status === "error");
      const allPassed = _batchItems.every(it => it.status === "passed");
      updateFavicon(hasError ? "failed" : allPassed ? "passed" : "default");
    }
  }, [batchRunning]);

  useEffect(() => () => { resetFavicon(); }, []);

  function setTextSaved(v: string) { _text = v; setText(v); }
  function setMdFilesSaved(v: MdFile[]) { _mdFiles = v; setMdFiles(v); }
  function setSelectedFileSaved(v: string | null) { _selectedFile = v; setSelectedFile(v); }
  function setCheckedFilesSaved(v: Set<string>) { _checkedFiles = v; setCheckedFiles(v); }
  function setBatchItemsSaved(v: BatchItem[] | ((prev: BatchItem[]) => BatchItem[])) {
    const next = typeof v === "function" ? v(_batchItems) : v;
    _batchItems = next;
    setBatchItems([...next]);
  }
  function setBatchRunningSaved(v: boolean) { _batchRunning = v; setBatchRunning(v); }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (typeof ev.target?.result === "string") setTextSaved(ev.target.result);
    };
    reader.readAsText(file, "utf-8");
    e.target.value = "";
  }

  function onFolderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const all = Array.from(e.target.files ?? []);
    const files: MdFile[] = all
      .filter(f => f.name.endsWith(".md"))
      .map(f => ({ name: (f as any).webkitRelativePath || f.name, file: f }));
    files.sort((a, b) => a.name.localeCompare(b.name));
    setMdFilesSaved(files);
    setSelectedFileSaved(null);
    setCheckedFilesSaved(new Set());
    setBatchItemsSaved([]);
    e.target.value = "";
  }

  async function onSelectFile(f: MdFile) {
    const content = await f.file.text();
    setTextSaved(content);
    setSelectedFileSaved(f.name);
  }

  function toggleCheck(name: string) {
    const next = new Set(checkedFiles);
    next.has(name) ? next.delete(name) : next.add(name);
    setCheckedFilesSaved(next);
  }

  function toggleAll() {
    setCheckedFilesSaved(
      checkedFiles.size === mdFiles.length ? new Set() : new Set(mdFiles.map(f => f.name))
    );
  }

  // ── single run ───────────────────────────────────────────────────────────────

  async function createRunApi(content: string, headless: boolean): Promise<string> {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ testCase: content, headless }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "error");
    return json.id;
  }

  async function startRun(headless: boolean) {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const id = await createRunApi(text, headless);
      router.push(`/run/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    startRun(true);
  }

  // ── batch run ────────────────────────────────────────────────────────────────

  function waitForRun(id: string): Promise<RunStatus | "skipped"> {
    return new Promise(resolve => {
      const es = new EventSource(`/api/run/${id}/stream`);

      const pollAbort = setInterval(() => {
        if (_batchAbort) {
          clearInterval(pollAbort);
          es.close();
          resolve("paused");
        }
      }, 150);

      es.onmessage = msg => {
        const data = JSON.parse(msg.data);
        const status: RunStatus = data.run?.status;
        if (_batchAbort) { clearInterval(pollAbort); es.close(); resolve("paused"); return; }
        if (status && !ACTIVE.has(status)) { clearInterval(pollAbort); es.close(); resolve(status); }
      };
      es.onerror = () => { clearInterval(pollAbort); es.close(); resolve("error"); };
    });
  }

  async function stopBatch() {
    _batchAbort = true;
    const id = _batchCurrentId;
    if (id) {
      fetch(`/api/run/${id}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pause" }),
      }).catch(() => {});
    }
  }

  async function runBatch(headless: boolean) {
    const toRun = mdFiles.filter(f => checkedFiles.has(f.name));
    if (!toRun.length) return;

    const items: BatchItem[] = toRun.map(f => ({ file: f, id: null, status: "queued" }));
    setBatchItemsSaved(items);
    setBatchRunningSaved(true);
    _batchAbort = false;
    _batchCurrentId = null;
    _batchStartedAt = Date.now();
    _batchFinishedAt = null;

    for (let i = 0; i < items.length; i++) {
      if (_batchAbort) {
        setBatchItemsSaved(prev => prev.map((it, idx) => idx >= i ? { ...it, status: "skipped" } : it));
        break;
      }

      const itemStart = Date.now();
      setBatchItemsSaved(prev => prev.map((it, idx) => idx === i ? { ...it, status: "running", startedAt: itemStart } : it));

      try {
        const content = await items[i].file.file.text();
        const id = await createRunApi(content, headless);
        _batchCurrentId = id;
        setBatchItemsSaved(prev => prev.map((it, idx) => idx === i ? { ...it, id } : it));
        const finalStatus = await waitForRun(id);
        const itemEnd = Date.now();
        setBatchItemsSaved(prev => prev.map((it, idx) => idx === i ? { ...it, status: finalStatus, finishedAt: itemEnd } : it));
        if (_batchAbort) {
          setBatchItemsSaved(prev => prev.map((it, idx) => idx > i ? { ...it, status: "skipped" } : it));
          break;
        }
      } catch {
        setBatchItemsSaved(prev => prev.map((it, idx) => idx === i ? { ...it, status: "error", finishedAt: Date.now() } : it));
      }
    }

    _batchCurrentId = null;
    _batchFinishedAt = Date.now();
    setBatchRunningSaved(false);
    fetch("/api/runs").then(r => r.ok ? r.json() : []).then(setHistory).catch(() => {});
  }

  const checkedCount = checkedFiles.size;
  const allChecked = mdFiles.length > 0 && checkedFiles.size === mdFiles.length;

  return (
    <main className="flex flex-col items-center min-h-screen px-6 pt-20 pb-24">
      <div className="flex items-center justify-center size-11 rounded-2xl border border-white/10 bg-white/5 mb-6 shadow-lg">
        <Bot className="size-5 text-foreground/80" />
      </div>

      <h1 className="text-3xl font-semibold tracking-tight mb-2">QA Agent</h1>
      <p className="text-sm text-muted-foreground mb-10">Paste a test case. Watch it run.</p>

      <div className="w-full max-w-2xl space-y-3">

        {/* folder picker */}
        <div className="flex items-center gap-2">
          <input ref={folderInputRef} type="file"
            // @ts-ignore
            webkitdirectory="" multiple className="hidden" onChange={onFolderChange} />
          <input ref={fileInputRef} type="file" accept=".md,text/markdown"
            className="hidden" onChange={onFileChange} />
          <Button type="button" variant="outline" size="sm"
            onClick={() => folderInputRef.current?.click()}
            className="gap-2 text-muted-foreground hover:text-foreground">
            <Folder className="size-4" />Choose folder
          </Button>
          <Button type="button" variant="outline" size="sm"
            onClick={() => fileInputRef.current?.click()}
            className="gap-2 text-muted-foreground hover:text-foreground">
            <Upload className="size-4" />Upload .md
          </Button>

          {mdFiles.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {mdFiles.length} .md file{mdFiles.length !== 1 ? "s" : ""} found
            </span>
          )}

          {mdFiles.length > 0 && (
            <Button type="button" variant="ghost" size="sm"
              onClick={() => { setMdFilesSaved([]); setSelectedFileSaved(null); setCheckedFilesSaved(new Set()); setBatchItemsSaved([]); }}
              className="ml-auto text-muted-foreground hover:text-foreground p-1 h-auto">
              <X className="size-3.5" />
            </Button>
          )}
        </div>

        {/* file list */}
        {mdFiles.length > 0 && (
          <>
            <ul className="rounded-xl border border-white/7 divide-y divide-white/5 overflow-hidden">
              {/* select-all row */}
              <li>
                <div className="flex items-center gap-3 px-4 py-2 bg-white/[0.02]">
                  <button type="button" onClick={toggleAll}
                    className="shrink-0 text-muted-foreground/50 hover:text-foreground transition-colors">
                    {allChecked
                      ? <CheckSquare className="size-4 text-foreground/70" />
                      : <Square className="size-4" />}
                  </button>
                  <span className="text-[11px] text-muted-foreground/50 select-none">
                    {checkedCount > 0 ? `${checkedCount} selected` : "Select all"}
                  </span>

                  {checkedCount > 0 && !batchRunning && (
                    <div className="ml-auto flex items-center gap-1.5">
                      <Button type="button" size="sm"
                        className="h-7 gap-1.5 text-xs font-medium"
                        onClick={() => runBatch(true)}>
                        <ArrowRight className="size-3.5" />
                        Run {checkedCount}
                      </Button>
                      <Button type="button" size="sm" variant="secondary"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => runBatch(false)}>
                        <ArrowRight className="size-3.5" />
                        With preview
                      </Button>
                    </div>
                  )}

                  {batchRunning && (
                    <div className="ml-auto flex items-center gap-2">
                      <Loader2 className="size-3.5 text-muted-foreground/50 animate-spin" />
                      <Button type="button" size="sm" variant="ghost"
                        className="h-7 text-xs text-destructive hover:text-destructive"
                        onClick={stopBatch}>
                        Stop
                      </Button>
                    </div>
                  )}
                </div>
              </li>

              {mdFiles.map(f => (
                <li key={f.name} className="flex items-center">
                  <button type="button" onClick={() => toggleCheck(f.name)}
                    className="shrink-0 px-4 py-2.5 text-muted-foreground/50 hover:text-foreground transition-colors">
                    {checkedFiles.has(f.name)
                      ? <CheckSquare className="size-4 text-foreground/70" />
                      : <Square className="size-4" />}
                  </button>
                  <button type="button" onClick={() => onSelectFile(f)}
                    className={cn(
                      "flex-1 text-left py-2.5 pr-4 text-sm font-mono transition-colors truncate",
                      selectedFile === f.name
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}>
                    {f.name}
                  </button>
                </li>
              ))}
            </ul>

            {/* batch progress */}
            {batchItems.length > 0 && (
              <div className="rounded-xl border border-white/7 overflow-hidden">
                <div className="px-4 py-2.5 bg-white/[0.02] flex items-center gap-2">
                  <span className="text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                    Batch run
                  </span>
                  {_batchStartedAt && (
                    <span className="ml-auto text-[11px] font-mono tabular-nums text-muted-foreground/40">
                      {formatDur((_batchFinishedAt ?? now) - _batchStartedAt)}
                    </span>
                  )}
                </div>
                <ul className="divide-y divide-white/5">
                  {batchItems.map((item, i) => (
                    <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                      <BatchStatusIcon status={item.status} />
                      {item.id
                        ? <Link href={`/run/${item.id}`}
                            className="flex-1 min-w-0 text-sm font-mono text-foreground/70 hover:text-foreground truncate transition-colors">
                            {item.file.name}
                          </Link>
                        : <span className="flex-1 min-w-0 text-sm font-mono text-muted-foreground/40 truncate">
                            {item.file.name}
                          </span>
                      }
                      <span className="shrink-0 text-[11px] font-mono tabular-nums text-muted-foreground/30">
                        {item.startedAt
                          ? formatDur((item.finishedAt ?? (item.status === "running" ? now : item.startedAt)) - item.startedAt)
                          : ""}
                      </span>
                      {item.status !== "queued" && item.status !== "running" && item.status !== "skipped" && (
                        <span className={cn(
                          "shrink-0 text-[10.5px] font-semibold uppercase tracking-wide",
                          item.status === "passed" ? "text-success" :
                          item.status === "failed" || item.status === "error" ? "text-destructive" :
                          "text-muted-foreground/40"
                        )}>
                          {item.status}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}

        {/* form */}
        <form ref={formRef} onSubmit={onSubmit} className="space-y-3">
          <div className={cn(
            "rounded-xl border transition-all duration-200",
            focused ? "border-white/15 shadow-[0_0_0_3px_oklch(0.5_0.1_270_/_12%)]" : "border-white/7",
          )}>
            <Textarea
              placeholder="Paste your test case here…"
              value={text}
              onChange={e => setTextSaved(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={e => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
              rows={16}
              className="min-h-[320px] font-mono text-[12.5px] leading-relaxed resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 rounded-xl p-4"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={!text.trim() || busy} size="lg" className="gap-2 font-medium">
              {busy ? "Running…" : <><ArrowRight className="size-4" />Run</>}
            </Button>
            <Button type="button" disabled={!text.trim() || busy} size="lg" variant="secondary"
              onClick={() => startRun(false)} className="gap-2">
              {busy ? "Running…" : <><ArrowRight className="size-4" />Run with preview</>}
            </Button>
            <Button type="button" variant="ghost" size="lg"
              onClick={() => setTextSaved(EXAMPLE)}
              className="text-muted-foreground hover:text-foreground">
              <FileText className="size-4" />Example
            </Button>

            {error && <span className="text-destructive text-xs ml-1">{error}</span>}

            <kbd className="ml-auto hidden sm:inline-flex items-center gap-1 rounded-md border border-border bg-muted/30 px-2 py-1 text-[10px] font-mono text-muted-foreground/60">
              ⌘ + ↵
            </kbd>
          </div>
        </form>
      </div>

      {/* history */}
      {history.length > 0 && (
        <div className="w-full max-w-2xl mt-12">
          <div className="text-[10.5px] font-semibold uppercase tracking-widest text-muted-foreground/40 mb-3">
            Recent runs
          </div>
          <ul className="space-y-1.5">
            {history.map(run => (
              <li key={run.id}>
                <Link href={`/run/${run.id}`}
                  className="flex items-center gap-3 rounded-xl border border-white/7 px-4 py-3 hover:bg-white/5 transition-colors">
                  <RunStatusIcon status={run.status} />
                  <span className="flex-1 min-w-0 text-sm text-foreground/80 truncate">{run.title}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground/40 font-mono tabular-nums">
                    {formatTime(run.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}

function BatchStatusIcon({ status }: { status: "queued" | "skipped" | RunStatus }) {
  if (status === "running")
    return <Loader2 className="size-3.5 shrink-0 text-muted-foreground/50 animate-spin" />;
  if (status === "passed")
    return <Check className="size-3.5 shrink-0 text-success" strokeWidth={2.5} />;
  if (status === "failed" || status === "error")
    return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  if (status === "paused")
    return <span className="size-3.5 shrink-0 text-[10px] text-muted-foreground/40 font-mono">▐▐</span>;
  if (status === "skipped")
    return <span className="size-3.5 shrink-0 text-[10px] text-muted-foreground/30 font-mono">—</span>;
  return <span className="size-3.5 shrink-0 rounded-sm border border-white/15 inline-block" />;
}

function RunStatusIcon({ status }: { status: RunStatus }) {
  if (status === "passed")
    return <Check className="size-3.5 shrink-0 text-success" strokeWidth={2.5} />;
  if (status === "failed" || status === "error")
    return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  return <Clock className="size-3.5 shrink-0 text-muted-foreground/40" />;
}

function formatDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const isToday = d.getDate() === today.getDate()
    && d.getMonth() === today.getMonth()
    && d.getFullYear() === today.getFullYear();
  return isToday
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
