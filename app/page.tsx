"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import {
  Bot, FileText, ArrowRight, Upload, Folder, X,
  Check, CircleAlert, Clock, Loader2, Square, CheckSquare,
  ChevronDown, ChevronUp, Paperclip, GitBranch, RefreshCw, Plus, Trash2, Settings as SettingsIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn, formatDuration } from "@/lib/utils";
import type { RunStatus } from "@/lib/types";
import type { RepoInfo } from "@/lib/repos";
import { updateFavicon, resetFavicon } from "@/lib/favicon";
import { dict, type Lang } from "@/lib/i18n";
import { useDismiss } from "@/lib/hooks";
import { ThemeToggle } from "@/components/theme-toggle";

type RunSummary = { id: string; createdAt: number; status: RunStatus; title: string };
// a test case file from a local folder or a connected git repo; read lazily
type MdFile = { name: string; load: () => Promise<string> };
type RepoFiles = { repo: RepoInfo; files: string[]; error?: string };
type HomeDict = ReturnType<typeof dict>["home"];
type BatchItem = { file: MdFile; id: string | null; status: "queued" | "skipped" | RunStatus; startedAt?: number; finishedAt?: number };

const ACTIVE = new Set(["running", "waiting", "paused"]);
const TEXTAREA_COLLAPSED_MAX = 360; // px — close to the default box height

// keep in sync with lib/attachments.ts
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// shared surface tokens — one place to keep panels visually consistent
const PANEL = "rounded-xl border border-border overflow-hidden";
const PANEL_HEAD = "px-4 py-2.5 bg-surface";
const SECTION_LABEL =
  "text-[10.5px] font-semibold uppercase tracking-widest text-subtle";

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

// the last chosen repo is remembered per browser (localStorage); the repos
// themselves are saved server-side, in ~/.qpilot/repos.json
const ACTIVE_REPO_KEY = "qpilot.activeRepo";

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json as T;
}

function repoMdFiles(repoId: string, files: string[]): MdFile[] {
  return files.map(path => ({
    name: path,
    load: async () => {
      const res = await fetch(`/api/repos/${repoId}/file?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      return res.text();
    },
  }));
}

// persists across route transitions within the same tab
let _text = "";
let _mdFiles: MdFile[] = [];
let _selectedFile: string | null = null;
let _checkedFiles: Set<string> = new Set();
let _attachments: File[] = [];
let _batchItems: BatchItem[] = [];
let _batchRunning = false;
let _batchAbort = false;
let _batchCurrentId: string | null = null;
let _batchStartedAt: number | null = null;
let _batchFinishedAt: number | null = null;
let _activeRepoId: string | null = null;

export default function Home() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [text, setText] = useState(_text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [textExpanded, setTextExpanded] = useState(false);
  const [textOverflowing, setTextOverflowing] = useState(false);
  const [mdFiles, setMdFiles] = useState<MdFile[]>(_mdFiles);
  const [selectedFile, setSelectedFile] = useState<string | null>(_selectedFile);
  const [attachments, setAttachments] = useState<File[]>(_attachments);
  const [history, setHistory] = useState<RunSummary[]>([]);

  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(_checkedFiles);
  const [batchItems, setBatchItems] = useState<BatchItem[]>(_batchItems);
  const [batchRunning, setBatchRunning] = useState(_batchRunning);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [activeRepoId, setActiveRepoId] = useState<string | null>(_activeRepoId);
  const [repoSyncing, setRepoSyncing] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // no test case yet on this page, so the browser locale is the only signal.
  // set after mount to keep server and client markup identical.
  const [lang, setLang] = useState<Lang>("en");
  const t = dict(lang).home;

  useEffect(() => {
    if (navigator.language?.toLowerCase().startsWith("ru")) setLang("ru");
  }, []);

  useEffect(() => {
    if (!batchRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [batchRunning]);

  useEffect(() => {
    fetch("/api/runs").then(r => r.ok ? r.json() : []).then(setHistory).catch(() => {});
  }, []);

  // no model configured yet (first launch) — start in Settings
  useEffect(() => {
    fetch("/api/settings").then(r => r.ok ? r.json() : null).then(s => {
      if (s && !s.configured) router.replace("/settings?welcome=1");
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // saved repos; reopen the last used one if nothing else is loaded yet
  useEffect(() => {
    apiJson<RepoInfo[]>("/api/repos").then(list => {
      setRepos(list);
      if (_mdFiles.length > 0 || _activeRepoId) return;
      let last: string | null = null;
      try { last = localStorage.getItem(ACTIVE_REPO_KEY); } catch {}
      if (last && list.some(r => r.id === last)) openRepo(last);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // collapse the textarea once content grows past TEXTAREA_COLLAPSED_MAX, with a manual expand/collapse toggle
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    setTextOverflowing(el.scrollHeight > TEXTAREA_COLLAPSED_MAX + 4);
  }, [text]);

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
  function setAttachmentsSaved(v: File[]) { _attachments = v; setAttachments(v); }
  function setBatchItemsSaved(v: BatchItem[] | ((prev: BatchItem[]) => BatchItem[])) {
    const next = typeof v === "function" ? v(_batchItems) : v;
    _batchItems = next;
    setBatchItems([...next]);
  }
  function setBatchRunningSaved(v: boolean) { _batchRunning = v; setBatchRunning(v); }
  function setActiveRepoSaved(id: string | null) {
    _activeRepoId = id;
    setActiveRepoId(id);
    setRepoError(null);
    try {
      if (id) localStorage.setItem(ACTIVE_REPO_KEY, id);
      else localStorage.removeItem(ACTIVE_REPO_KEY);
    } catch {}
  }

  function showFiles(files: MdFile[]) {
    setMdFilesSaved(files);
    setSelectedFileSaved(null);
    setCheckedFilesSaved(new Set());
    setBatchItemsSaved([]);
  }

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
      .map(f => ({ name: f.webkitRelativePath || f.name, load: () => f.text() }));
    files.sort((a, b) => a.name.localeCompare(b.name));
    setActiveRepoSaved(null);
    showFiles(files);
    e.target.value = "";
  }

  // ── git repositories ─────────────────────────────────────────────────────────

  function upsertRepo(repo: RepoInfo) {
    setRepos(prev => prev.some(r => r.id === repo.id)
      ? prev.map(r => r.id === repo.id ? repo : r)
      : [...prev, repo]);
  }

  async function openRepo(id: string) {
    setActiveRepoSaved(id);
    try {
      // local clone first — instant — then pull in the background
      const { repo, files, error } = await apiJson<RepoFiles>(`/api/repos/${id}/files`);
      if (_activeRepoId !== id) return;
      upsertRepo(repo);
      showFiles(repoMdFiles(id, files));
      if (error) setRepoError(error);
    } catch (err) {
      if (_activeRepoId === id) setRepoError(err instanceof Error ? err.message : String(err));
      return;
    }
    syncRepo(id);
  }

  async function switchBranch(id: string, branch: string) {
    setRepoSyncing(true);
    setRepoError(null);
    try {
      const { repo, files, error } = await apiJson<RepoFiles>(`/api/repos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch }),
      });
      upsertRepo(repo);
      if (_activeRepoId !== id) return;
      showFiles(repoMdFiles(id, files));
      if (error) setRepoError(error);
    } catch (err) {
      if (_activeRepoId === id) setRepoError(err instanceof Error ? err.message : String(err));
    } finally {
      setRepoSyncing(false);
    }
  }

  async function syncRepo(id: string) {
    setRepoSyncing(true);
    setRepoError(null);
    try {
      const { repo, files, error } = await apiJson<RepoFiles>(`/api/repos/${id}/sync`, { method: "POST" });
      upsertRepo(repo);
      // don't swap the list under a running batch or after switching repos
      if (_activeRepoId !== id || _batchRunning) return;
      if (error) setRepoError(error);
      const names = new Set(files);
      setMdFilesSaved(repoMdFiles(id, files));
      setCheckedFilesSaved(new Set([..._checkedFiles].filter(n => names.has(n))));
      if (_selectedFile && !names.has(_selectedFile)) setSelectedFileSaved(null);
    } catch (err) {
      if (_activeRepoId === id) setRepoError(err instanceof Error ? err.message : String(err));
    } finally {
      setRepoSyncing(false);
    }
  }

  function onRepoAdded({ repo, files }: RepoFiles) {
    upsertRepo(repo);
    setActiveRepoSaved(repo.id);
    showFiles(repoMdFiles(repo.id, files));
  }

  async function removeRepo(repo: RepoInfo) {
    if (!window.confirm(t.confirmRemoveRepo.replace("{name}", shortRepoUrl(repo.url)))) return;
    try {
      await apiJson(`/api/repos/${repo.id}`, { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setRepos(prev => prev.filter(r => r.id !== repo.id));
    if (_activeRepoId === repo.id) clearFolder();
  }

  // ── attachments (materials the agent can upload during a test) ───────────────

  function addAttachments(incoming: File[]) {
    if (!incoming.length) return;
    const tooBig = incoming.find(f => f.size > MAX_ATTACHMENT_BYTES);
    if (tooBig) {
      setError(`"${tooBig.name}" is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
      return;
    }
    // de-dupe by name so re-picking the same file doesn't stack up
    const byName = new Map(attachments.map(f => [f.name, f]));
    for (const f of incoming) byName.set(f.name, f);
    const next = [...byName.values()];
    if (next.length > MAX_ATTACHMENTS) {
      setError(`At most ${MAX_ATTACHMENTS} attachments per run`);
      return;
    }
    setError(null);
    setAttachmentsSaved(next);
  }

  function onAttachChange(e: React.ChangeEvent<HTMLInputElement>) {
    addAttachments(Array.from(e.target.files ?? []));
    e.target.value = "";
  }

  function removeAttachment(name: string) {
    setAttachmentsSaved(attachments.filter(f => f.name !== name));
  }

  async function onSelectFile(f: MdFile) {
    try {
      const content = await f.load();
      setTextSaved(content);
      setSelectedFileSaved(f.name);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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

  function clearFolder() {
    setActiveRepoSaved(null);
    showFiles([]);
  }

  // ── single run ───────────────────────────────────────────────────────────────

  async function createRunApi(content: string, headless: boolean): Promise<string> {
    // multipart so attachments ride along with the test case
    const form = new FormData();
    form.append("testCase", content);
    form.append("headless", String(headless));
    for (const f of _attachments) form.append("files", f);

    const res = await fetch("/api/run", { method: "POST", body: form });
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
        if (_batchAbort) { clearInterval(pollAbort); es.close(); resolve("paused"); }
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
        const content = await items[i].file.load();
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

  const activeRepo = repos.find(r => r.id === activeRepoId) ?? null;
  const checkedCount = checkedFiles.size;
  const allChecked = mdFiles.length > 0 && checkedFiles.size === mdFiles.length;
  const batchMode = checkedCount > 0;
  // side-by-side (file list left, textarea right) once files are loaded and not in batch-select mode;
  // batch mode reverts to a single wide column since the textarea form is hidden then
  const sideBySide = mdFiles.length > 0 && !batchMode;
  const containerMaxW = mdFiles.length > 0 ? "max-w-3xl" : "max-w-2xl";

  return (
    <main className="flex flex-col items-center min-h-screen px-6 pt-20 pb-24">
      <div className="absolute right-4 top-4 flex items-center gap-2 sm:right-6 sm:top-6">
        <ThemeToggle labels={dict(lang).settings} />
        <Link href="/settings" title={t.settings}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors">
          <SettingsIcon className="size-3.5" />
          <span className="hidden sm:inline">{t.settings}</span>
        </Link>
      </div>
      <div className="flex items-center justify-center size-11 rounded-2xl border border-border bg-surface-hover mb-6 shadow-lg">
        <Bot className="size-5 text-foreground/80" />
      </div>

      <h1 className="text-3xl font-semibold tracking-tight mb-2">QA Agent</h1>
      <p className="text-sm text-muted-foreground mb-10">{t.tagline}</p>

      <div className={cn("w-full space-y-3", containerMaxW)}>

        {/* hidden pickers */}
        <input ref={folderInputRef} type="file"
          // @ts-expect-error — non-standard but supported by Chrome/Edge/Safari
          webkitdirectory="" multiple className="hidden" onChange={onFolderChange} />
        <input ref={fileInputRef} type="file" accept=".md,text/markdown"
          className="hidden" onChange={onFileChange} />
        <input ref={attachInputRef} type="file" multiple
          className="hidden" onChange={onAttachChange} />

        {/* source toolbar */}
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm"
            onClick={() => folderInputRef.current?.click()}
            className="gap-2 text-muted-foreground hover:text-foreground">
            <Folder className="size-4" />{t.chooseFolder}
          </Button>
          <Button type="button" variant="outline" size="sm"
            onClick={() => fileInputRef.current?.click()}
            className="gap-2 text-muted-foreground hover:text-foreground">
            <Upload className="size-4" />{t.uploadMd}
          </Button>
          <RepoPicker
            t={t}
            repos={repos}
            activeId={activeRepoId}
            disabled={batchRunning}
            onOpen={openRepo}
            onRemove={removeRepo}
            onAdd={() => setAddRepoOpen(true)}
          />

          {(mdFiles.length > 0 || activeRepo) && (
            <>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {mdFiles.length} .md {t.files}
              </span>
              <div className="ml-auto flex items-center">
                {activeRepo && (
                  <Button type="button" variant="ghost" size="sm"
                    onClick={() => syncRepo(activeRepo.id)}
                    disabled={repoSyncing || batchRunning}
                    title={t.syncRepo}
                    className="size-7 p-0 text-subtle hover:text-foreground">
                    <RefreshCw className={cn("size-3.5", repoSyncing && "animate-spin")} />
                  </Button>
                )}
                <Button type="button" variant="ghost" size="sm"
                  onClick={clearFolder}
                  disabled={batchRunning}
                  title={t.clearList}
                  className="size-7 p-0 text-subtle hover:text-foreground">
                  <X className="size-3.5" />
                </Button>
              </div>
            </>
          )}
        </div>

        {/* where the list comes from, when it's a repo */}
        {activeRepo && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono text-subtle">
              <span className="text-muted-foreground">{shortRepoUrl(activeRepo.url)}</span>
              <BranchPicker
                t={t}
                repo={activeRepo}
                disabled={repoSyncing || batchRunning}
                onSwitch={branch => switchBranch(activeRepo.id, branch)}
              />
              {activeRepo.path && <span>/{activeRepo.path}</span>}
              {activeRepo.syncedAt && (
                <span>· {t.updatedAt} {formatTime(activeRepo.syncedAt)}{activeRepo.commit ? ` · ${activeRepo.commit}` : ""}</span>
              )}
            </div>
            {repoError && (
              <div className="flex items-start gap-2 text-[11.5px] leading-relaxed text-destructive">
                <CircleAlert className="size-3.5 shrink-0 mt-0.5" />
                <span className="break-words min-w-0">{repoError}</span>
              </div>
            )}
            {mdFiles.length === 0 && !repoError && !repoSyncing && (
              <div className="text-xs text-subtle">{t.noMdFiles}</div>
            )}
          </div>
        )}

        <AddRepoDialog
          t={t}
          open={addRepoOpen}
          onOpenChange={setAddRepoOpen}
          onAdded={onRepoAdded}
        />

        {/* file list (left column once side-by-side) + form (right column) */}
        <div className={cn(sideBySide && "flex gap-4 items-start")}>
        {mdFiles.length > 0 && (
          <div className={cn(sideBySide ? "w-64 shrink-0" : "w-full", "space-y-3")}>
            <ul className={cn(PANEL, "divide-y divide-border")}>
              {/* select-all row */}
              <li>
                <div className={cn(PANEL_HEAD, "flex items-center gap-3 py-2")}>
                  <button type="button" onClick={toggleAll}
                    className="flex items-center gap-2 shrink-0 text-subtle hover:text-foreground transition-colors">
                    {allChecked
                      ? <CheckSquare className="size-4 text-foreground/75" />
                      : <Square className="size-4" />}
                    <span className="text-[11px] text-muted-foreground select-none">
                      {checkedCount > 0 ? `${checkedCount} ${t.selected}` : t.selectAll}
                    </span>
                  </button>

                  {checkedCount > 0 && !batchRunning && (
                    <div className="ml-auto flex items-center gap-1.5">
                      <Button type="button" size="sm"
                        className="h-7 gap-1.5 text-xs font-medium"
                        onClick={() => runBatch(true)}>
                        <ArrowRight className="size-3.5" />
                        {t.runN} {checkedCount}
                      </Button>
                      <Button type="button" size="sm" variant="secondary"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => runBatch(false)}>
                        <ArrowRight className="size-3.5" />
                        {t.withPreview}
                      </Button>
                    </div>
                  )}

                  {batchRunning && (
                    <div className="ml-auto flex items-center gap-2">
                      <Loader2 className="size-3.5 text-subtle animate-spin" />
                      <Button type="button" size="sm" variant="ghost"
                        className="h-7 text-xs text-destructive hover:text-destructive"
                        onClick={stopBatch}>
                        {t.stop}
                      </Button>
                    </div>
                  )}
                </div>
              </li>

              {mdFiles.map(f => (
                <li key={f.name} className="flex items-center">
                  <button type="button" onClick={() => toggleCheck(f.name)}
                    className="shrink-0 px-4 py-2.5 text-subtle hover:text-foreground transition-colors">
                    {checkedFiles.has(f.name)
                      ? <CheckSquare className="size-4 text-foreground/75" />
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
              <div className={PANEL}>
                <div className={cn(PANEL_HEAD, "flex items-center gap-2")}>
                  <span className={SECTION_LABEL}>{t.batchRun}</span>
                  {_batchStartedAt && (
                    <span className="ml-auto text-[11px] font-mono tabular-nums text-subtle">
                      {formatDuration((_batchFinishedAt ?? now) - _batchStartedAt)}
                    </span>
                  )}
                </div>
                <ul className="divide-y divide-border">
                  {batchItems.map((item, i) => (
                    <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                      <BatchStatusIcon status={item.status} />
                      {item.id
                        ? <Link href={`/run/${item.id}`}
                            className="flex-1 min-w-0 text-sm font-mono text-foreground/75 hover:text-foreground truncate transition-colors">
                            {item.file.name}
                          </Link>
                        : <span className="flex-1 min-w-0 text-sm font-mono text-subtle truncate">
                            {item.file.name}
                          </span>
                      }
                      <span className="shrink-0 text-[11px] font-mono tabular-nums text-faint">
                        {item.startedAt
                          ? formatDuration((item.finishedAt ?? (item.status === "running" ? now : item.startedAt)) - item.startedAt)
                          : ""}
                      </span>
                      {item.status !== "queued" && item.status !== "running" && item.status !== "skipped" && (
                        <span className={cn(
                          "shrink-0 text-[10.5px] font-semibold uppercase tracking-wide",
                          item.status === "passed" ? "text-success" :
                          item.status === "failed" || item.status === "error" ? "text-destructive" :
                          "text-subtle"
                        )}>
                          {item.status}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* form — hidden while batch files are checked, to avoid a second redundant Run pair */}
        {!batchMode && (
          <form ref={formRef} onSubmit={onSubmit} className={cn("space-y-3", sideBySide && "flex-1 min-w-0")}>
            <div className={cn(
              "relative rounded-xl border transition-all duration-200",
              focused ? "border-border-strong ring-3 ring-ring/15" : "border-border",
            )}>
              <Textarea
                ref={textareaRef}
                placeholder={t.placeholder}
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
                className={cn(
                  "min-h-[320px] font-mono text-[12.5px] leading-relaxed resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 rounded-xl p-4 overflow-y-auto",
                  textExpanded ? "max-h-[65vh]" : "max-h-[360px]",
                  textOverflowing && "pb-9",
                )}
              />
              {textOverflowing && (
                <button type="button"
                  onClick={() => setTextExpanded(v => !v)}
                  className="absolute bottom-2 right-3 flex items-center gap-1 rounded-md border border-border bg-background/80 backdrop-blur px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors">
                  {textExpanded
                    ? <><ChevronUp className="size-3.5" />{t.collapse}</>
                    : <><ChevronDown className="size-3.5" />{t.expand}</>}
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={!text.trim() || busy} size="lg" className="gap-2 font-medium">
                {busy ? t.running : <><ArrowRight className="size-4" />{t.run}</>}
              </Button>
              <Button type="button" disabled={!text.trim() || busy} size="lg" variant="secondary"
                onClick={() => startRun(false)} className="gap-2">
                {busy ? t.running : <><ArrowRight className="size-4" />{t.runPreview}</>}
              </Button>
              <Button type="button" variant="ghost" size="lg"
                onClick={() => setTextSaved(EXAMPLE)}
                className="ml-auto text-muted-foreground hover:text-foreground">
                <FileText className="size-4" />{t.example}
              </Button>
            </div>
          </form>
        )}
        </div>

        {/* attachments — shared by single and batch runs */}
        <AttachmentsPanel
          t={dict(lang).home}
          files={attachments}
          onPick={() => attachInputRef.current?.click()}
          onRemove={removeAttachment}
        />

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-4 py-3">
            <CircleAlert className="size-4 shrink-0 text-destructive mt-px" />
            <span className="text-xs leading-relaxed text-destructive">{error}</span>
          </div>
        )}
      </div>

      {/* history */}
      {history.length > 0 && (
        <div className={cn("w-full mt-12", containerMaxW)}>
          <div className={cn(SECTION_LABEL, "mb-3")}>{t.recentRuns}</div>
          <ul className="space-y-1.5">
            {history.map(run => (
              <li key={run.id}>
                <Link href={`/run/${run.id}`}
                  className="flex items-center gap-3 rounded-xl border border-border px-4 py-3 hover:bg-surface-hover transition-colors">
                  <RunStatusIcon status={run.status} />
                  <span className="flex-1 min-w-0 text-sm text-foreground/80 truncate">{run.title}</span>
                  <span className="shrink-0 text-[11px] text-subtle font-mono tabular-nums">
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

/**
 * Files the agent can hand to a file input during the run (photos, CSVs,
 * documents). They apply to both the single run and every run in a batch.
 */
function AttachmentsPanel({
  files,
  onPick,
  onRemove,
  t,
}: {
  files: File[];
  onPick: () => void;
  onRemove: (name: string) => void;
  t: ReturnType<typeof dict>["home"];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button type="button" variant="ghost" size="sm"
        onClick={onPick}
        className="gap-2 text-muted-foreground hover:text-foreground">
        <Paperclip className="size-3.5" />
        {files.length ? t.addFile : t.attach}
      </Button>

      {files.length === 0 ? (
        <span className="text-[11px] text-subtle">
          {t.attachHint}
        </span>
      ) : (
        files.map(f => (
          <span key={f.name}
            className="group inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface pl-2.5 pr-1 py-1">
            <span className="text-[11px] font-mono text-foreground/75 max-w-[180px] truncate">
              {f.name}
            </span>
            <span className="text-[10px] tabular-nums text-subtle">
              {formatSize(f.size)}
            </span>
            <button type="button" onClick={() => onRemove(f.name)}
              title={`${t.remove} ${f.name}`}
              className="rounded p-0.5 text-subtle hover:text-destructive transition-colors">
              <X className="size-3" />
            </button>
          </span>
        ))
      )}
    </div>
  );
}

/** "git@github.com:team/tests.git" / "https://github.com/team/tests.git" → "github.com/team/tests" */
function shortRepoUrl(url: string): string {
  return url
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^@/]+@([^:/]+):/, "$1/")
    .replace(/^[^@/]+@/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

/** Dropdown of saved repositories: switch, remove, connect a new one. */
function RepoPicker({
  t, repos, activeId, disabled, onOpen, onRemove, onAdd,
}: {
  t: HomeDict;
  repos: RepoInfo[];
  activeId: string | null;
  disabled: boolean;
  onOpen: (id: string) => void;
  onRemove: (repo: RepoInfo) => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = repos.find(r => r.id === activeId);

  useDismiss(rootRef, open, () => setOpen(false));

  return (
    <div ref={rootRef} className="relative min-w-0">
      <Button type="button" variant="outline" size="sm" disabled={disabled}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        className={cn("gap-2 max-w-56", active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
        <GitBranch className="size-4" />
        <span className="truncate">{active ? active.name : "Git"}</span>
        <ChevronDown className="size-3.5 opacity-60" />
      </Button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1.5 w-96 max-w-[calc(100vw-3rem)] rounded-xl border border-border bg-popover shadow-xl overflow-hidden">
          <div className={cn(PANEL_HEAD, SECTION_LABEL, "py-2")}>{t.gitRepos}</div>
          {repos.length === 0 ? (
            <div className="px-4 py-3 text-xs text-muted-foreground">{t.noRepos}</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto divide-y divide-border">
              {repos.map(r => (
                <li key={r.id} className="group flex items-center">
                  <button type="button"
                    onClick={() => { setOpen(false); onOpen(r.id); }}
                    className="flex-1 min-w-0 flex items-start gap-2.5 px-4 py-2.5 text-left hover:bg-surface-hover transition-colors">
                    <Check className={cn("size-3.5 mt-0.5 shrink-0", r.id === activeId ? "text-foreground/80" : "opacity-0")} />
                    <span className="min-w-0">
                      <span className="block text-sm text-foreground/85 truncate">{r.name}</span>
                      <span className="block text-[11px] font-mono text-subtle truncate">
                        {shortRepoUrl(r.url)}{r.branch ? ` · ${r.branch}` : ""}{r.path ? ` · /${r.path}` : ""}
                      </span>
                    </span>
                  </button>
                  <button type="button"
                    onClick={() => { setOpen(false); onRemove(r); }}
                    title={t.remove}
                    className="shrink-0 px-3 py-2.5 text-faint opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-destructive transition">
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button"
            onClick={() => { setOpen(false); onAdd(); }}
            className="w-full flex items-center gap-2 border-t border-border px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors">
            <Plus className="size-3.5" />{t.addRepo}
          </button>
        </div>
      )}
    </div>
  );
}

type BranchList = { branches: string[]; defaultBranch?: string };

/**
 * The repo's branch, clickable: lists the remote's branches (fetched when
 * opened — always current) with a filter, and switches on click.
 */
function BranchPicker({
  t, repo, disabled, onSwitch,
}: {
  t: HomeDict;
  repo: RepoInfo;
  disabled: boolean;
  onSwitch: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<BranchList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(rootRef, open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setList(null);
    setLoadError(null);
    setQuery("");
    apiJson<BranchList>(`/api/repos/${repo.id}/branches`)
      .then(l => { if (!stale) setList(l); })
      .catch(err => { if (!stale) setLoadError(err instanceof Error ? err.message : String(err)); });
    return () => { stale = true; };
  }, [open, repo.id]);

  const q = query.trim().toLowerCase();
  const shown = (list?.branches ?? []).filter(b => !q || b.toLowerCase().includes(q));

  return (
    <div ref={rootRef} className="relative">
      <button type="button" disabled={disabled}
        onClick={() => setOpen(v => !v)}
        title={t.switchBranch}
        className="inline-flex items-center gap-1 rounded-md px-1 -mx-1 text-muted-foreground hover:text-foreground hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-50 transition-colors">
        <GitBranch className="size-3" />
        <span className="max-w-48 truncate">{repo.branch ?? "—"}</span>
        <ChevronDown className="size-3 opacity-60" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1.5 w-80 max-w-[calc(100vw-3rem)] rounded-xl border border-border bg-popover shadow-xl overflow-hidden font-sans">
          <div className="p-2 border-b border-border">
            <Input value={query} onChange={e => setQuery(e.target.value)}
              placeholder={t.branchSearch} autoFocus spellCheck={false}
              onKeyDown={e => {
                if (e.key === "Enter" && shown[0]) { setOpen(false); if (shown[0] !== repo.branch) onSwitch(shown[0]); }
              }}
              className="h-7 font-mono text-[12px]" />
          </div>
          {loadError ? (
            <div className="flex items-start gap-2 px-3 py-2.5 text-[11.5px] leading-relaxed text-destructive">
              <CircleAlert className="size-3.5 shrink-0 mt-0.5" />
              <span className="break-words min-w-0">{loadError}</span>
            </div>
          ) : !list ? (
            <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />{t.branchesLoading}
            </div>
          ) : shown.length === 0 ? (
            <div className="px-3 py-2.5 text-xs text-muted-foreground">{t.noBranches}</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto py-1">
              {shown.map(b => (
                <li key={b}>
                  <button type="button"
                    onClick={() => { setOpen(false); if (b !== repo.branch) onSwitch(b); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-hover transition-colors">
                    <Check className={cn("size-3.5 shrink-0", b === repo.branch ? "text-foreground/80" : "opacity-0")} />
                    <span className="flex-1 min-w-0 truncate font-mono text-[12px] text-foreground/85">{b}</span>
                    {b === list.defaultBranch && (
                      <span className="shrink-0 rounded border border-border px-1.5 text-[10px] text-muted-foreground">{t.branchDefault}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Connect a repository: the server clones it right away, so errors show here. */
function AddRepoDialog({
  t, open, onOpenChange, onAdded,
}: {
  t: HomeDict;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (result: RepoFiles) => void;
}) {
  const empty = { url: "", branch: "", path: "", token: "", username: "" };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isHttps = /^https:\/\//i.test(form.url.trim()); // tokens only over https

  useEffect(() => {
    if (open) { setForm(empty); setError(null); setBusy(false); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.url.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiJson<RepoFiles>("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isHttps ? form : { ...form, token: "", username: "" }),
      });
      onAdded(result);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const field = (
    k: keyof typeof empty, label: string, hint: string,
    opts: { placeholder?: string; type?: string; optional?: boolean; autoFocus?: boolean } = {},
  ) => (
    <label className="block space-y-1">
      <span className="flex items-baseline justify-between gap-2 text-xs font-medium text-foreground/80">
        <span className="truncate">{label}</span>
        {opts.optional && <span className="shrink-0 text-[10.5px] font-normal text-subtle">{t.optional}</span>}
      </span>
      <Input value={form[k]} onChange={set(k)} type={opts.type ?? "text"}
        placeholder={opts.placeholder} autoFocus={opts.autoFocus}
        spellCheck={false} autoComplete="off" disabled={busy}
        className="font-mono text-[12.5px]" />
      <span className="block text-[11px] leading-snug text-subtle">{hint}</span>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <GitBranch className="size-4 shrink-0" />{t.addRepo}
            </DialogTitle>
            <DialogDescription className="text-xs">{t.repoUrlHint}</DialogDescription>
          </DialogHeader>

          {field("url", t.repoUrl, "", { placeholder: "git@github.com:team/tests.git", autoFocus: true })}
          <div className="grid grid-cols-2 gap-3">
            {field("branch", t.branch, t.branchHint, { placeholder: "main", optional: true })}
            {field("path", t.folder, t.folderHint, { placeholder: "tests/cases", optional: true })}
          </div>
          {isHttps && (
            <>
              {field("token", t.token, t.tokenHint, { type: "password", optional: true })}
              {field("username", t.username, t.usernameHint, { optional: true })}
            </>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-destructive">
              <CircleAlert className="size-3.5 shrink-0 mt-0.5" />
              <span className="break-words min-w-0">{error}</span>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={!form.url.trim() || busy} className="gap-2">
              {busy ? <><Loader2 className="size-3.5 animate-spin" />{t.connecting}</> : t.connect}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BatchStatusIcon({ status }: { status: "queued" | "skipped" | RunStatus }) {
  if (status === "running")
    return <Loader2 className="size-3.5 shrink-0 text-subtle animate-spin" />;
  if (status === "passed")
    return <Check className="size-3.5 shrink-0 text-success" strokeWidth={2.5} />;
  if (status === "failed" || status === "error")
    return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  if (status === "paused")
    return <span className="size-3.5 shrink-0 text-[10px] text-subtle font-mono">▐▐</span>;
  if (status === "skipped")
    return <span className="size-3.5 shrink-0 text-[10px] text-faint font-mono">—</span>;
  return <span className="size-3.5 shrink-0 rounded-sm border border-border-strong inline-block" />;
}

function RunStatusIcon({ status }: { status: RunStatus }) {
  if (status === "passed")
    return <Check className="size-3.5 shrink-0 text-success" strokeWidth={2.5} />;
  if (status === "failed" || status === "error")
    return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  return <Clock className="size-3.5 shrink-0 text-subtle" />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
