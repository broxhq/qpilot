"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, CircleAlert, Folder, Settings as SettingsIcon, X } from "lucide-react";
import { updateFavicon, resetFavicon } from "@/lib/favicon";
import {
  addAttachments, clearFolder, removeAttachment, restoreDraft, setFolder, setText, startRun, useHome,
} from "@/lib/home-state";
import { dict, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AttachmentsPanel } from "@/components/home/attachments-panel";
import { CaseEditor } from "@/components/home/case-editor";
import { FileList } from "@/components/home/file-list";
import { RecentRuns, type RunSummary } from "@/components/home/recent-runs";

export default function Home() {
  const router = useRouter();
  const home = useHome();
  const folderInput = useRef<HTMLInputElement>(null);
  const attachInput = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  // no test case yet on this page, so the browser locale is the only signal.
  // set after mount to keep server and client markup identical.
  const [lang, setLang] = useState<Lang>("en");
  const t = dict(lang).home;

  const batchRunning = home.batch.running;
  const batchItems = home.batch.items;

  useEffect(() => {
    if (navigator.language?.toLowerCase().startsWith("ru")) setLang("ru");
    restoreDraft();
    // no model configured yet (first launch) — start in Settings
    fetch("/api/settings").then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (s && !s.configured) router.replace("/settings?welcome=1");
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // the list of recent runs: on open, and again when a batch has finished
  useEffect(() => {
    if (batchRunning) return;
    fetch("/api/runs").then((r) => (r.ok ? r.json() : [])).then(setRuns).catch(() => {});
  }, [batchRunning]);

  // favicon: spins while a batch runs, then shows how it ended
  useEffect(() => {
    if (batchRunning) updateFavicon("running");
    else if (batchItems.length > 0) {
      const failed = batchItems.some((it) => it.status === "failed" || it.status === "error");
      const passed = batchItems.every((it) => it.status === "passed");
      updateFavicon(failed ? "failed" : passed ? "passed" : "default");
    }
    return () => { resetFavicon(); };
  }, [batchRunning, batchItems]);

  async function run(headless: boolean) {
    if (!home.text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      router.push(`/run/${await startRun(home.text, headless)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const hasFolder = home.files.length > 0;

  return (
    <main className="flex flex-col items-center min-h-screen px-6 pt-20 pb-24">
      <Link href="/settings" title={t.settings}
        className="absolute right-4 top-4 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-surface-hover transition-colors sm:right-6 sm:top-6">
        <SettingsIcon className="size-3.5" />
        <span className="hidden sm:inline">{t.settings}</span>
      </Link>

      <div className="flex items-center justify-center size-11 rounded-2xl border border-border bg-surface-hover mb-6 shadow-lg">
        <Bot className="size-5 text-foreground/80" />
      </div>
      <h1 className="text-3xl font-semibold tracking-tight mb-2">qpilot</h1>
      <p className="text-sm text-muted-foreground mb-10">{t.tagline}</p>

      <div className={cn("w-full", hasFolder ? "max-w-4xl" : "max-w-2xl")}>
        <div className="space-y-3">
          <input ref={folderInput} type="file" multiple className="hidden"
            // @ts-expect-error — non-standard but supported by Chrome/Edge/Safari
            webkitdirectory=""
            onChange={(e) => { setFolder(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <input ref={attachInput} type="file" multiple className="hidden"
            onChange={(e) => { setError(addAttachments(Array.from(e.target.files ?? []))); e.target.value = ""; }} />

          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm"
              onClick={() => folderInput.current?.click()}
              className="gap-2 text-muted-foreground hover:text-foreground">
              <Folder className="size-4" />{t.chooseFolder}
            </Button>
            {hasFolder && (
              <>
                <span className="text-xs text-muted-foreground">{home.files.length} .md {t.files}</span>
                <Button type="button" variant="ghost" size="sm" onClick={clearFolder} title={t.clearList}
                  className="size-7 p-0 text-subtle hover:text-foreground">
                  <X className="size-3.5" />
                </Button>
              </>
            )}
          </div>

          <div className="flex items-start gap-4">
            {hasFolder && <FileList home={home} t={t} />}
            <CaseEditor text={home.text} busy={busy} onChange={setText} onRun={run} t={t} />
          </div>

          <AttachmentsPanel t={t} files={home.attachments}
            onPick={() => attachInput.current?.click()} onRemove={removeAttachment} />

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/[0.06] px-4 py-3">
              <CircleAlert className="size-4 shrink-0 text-destructive mt-px" />
              <span className="text-xs leading-relaxed text-destructive">{error}</span>
            </div>
          )}
        </div>

        <RecentRuns runs={runs} title={t.recentRuns} />
      </div>
    </main>
  );
}
