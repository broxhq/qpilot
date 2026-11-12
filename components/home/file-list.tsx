"use client";

// The chosen folder: its test cases, which of them are ticked, and the batch
// that runs the ticked ones.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckSquare, Eye, Loader2, Square } from "lucide-react";
import { type Dict } from "@/lib/i18n";
import { openFile, runBatch, stopBatch, toggleAll, toggleChecked, type HomeState } from "@/lib/home-state";
import { cn, formatDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { BatchStatusIcon } from "@/components/home/status-icons";

const PANEL = "rounded-xl border border-border overflow-hidden";
const PANEL_HEAD = "px-4 py-2 bg-surface";

export function FileList({ home, t }: { home: HomeState; t: Dict["home"] }) {
  const { files, checked, selected, batch } = home;
  const allChecked = checked.length === files.length;

  return (
    <div className="w-64 shrink-0 space-y-3">
      <ul className={cn(PANEL, "divide-y divide-border")}>
        <li className={cn(PANEL_HEAD, "flex items-center")}>
          <button type="button" onClick={toggleAll}
            className="flex items-center gap-2 text-subtle hover:text-foreground transition-colors">
            {allChecked
              ? <CheckSquare className="size-4 text-foreground/75" />
              : <Square className="size-4" />}
            <span className="text-[11px] text-muted-foreground select-none">
              {checked.length > 0 ? `${checked.length} ${t.selected}` : t.selectAll}
            </span>
          </button>
        </li>

        {files.map((f) => (
          <li key={f.name} className="flex items-center">
            <button type="button" onClick={() => toggleChecked(f.name)}
              className="shrink-0 px-4 py-2.5 text-subtle hover:text-foreground transition-colors">
              {checked.includes(f.name)
                ? <CheckSquare className="size-4 text-foreground/75" />
                : <Square className="size-4" />}
            </button>
            <button type="button" onClick={() => openFile(f)} title={f.name}
              className={cn(
                "flex-1 min-w-0 truncate py-2.5 pr-4 text-left text-sm font-mono transition-colors",
                selected === f.name ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}>
              {f.name}
            </button>
          </li>
        ))}

        {(checked.length > 0 || batch.running) && (
          <li className={cn(PANEL_HEAD, "flex items-center gap-1.5")}>
            {batch.running ? (
              <>
                <Loader2 className="size-3.5 text-subtle animate-spin" />
                <Button type="button" size="sm" variant="ghost" onClick={stopBatch}
                  className="ml-auto h-7 text-xs text-destructive hover:text-destructive">
                  {t.stop}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" size="sm" onClick={() => runBatch(true)}
                  className="h-7 gap-1.5 text-xs font-medium">
                  <ArrowRight className="size-3.5" />{t.runN} {checked.length}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => runBatch(false)}
                  className="h-7 gap-1.5 text-xs">
                  <Eye className="size-3.5" />{t.withPreview}
                </Button>
              </>
            )}
          </li>
        )}
      </ul>

      {batch.items.length > 0 && <BatchProgress batch={batch} t={t} />}
    </div>
  );
}

function BatchProgress({ batch, t }: { batch: HomeState["batch"]; t: Dict["home"] }) {
  // the clock only ticks while something is running
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!batch.running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [batch.running]);

  return (
    <div className={PANEL}>
      <div className={cn(PANEL_HEAD, "flex items-center")}>
        <span className="text-[10.5px] font-semibold uppercase tracking-widest text-subtle">{t.batchRun}</span>
        {batch.startedAt && (
          <span className="ml-auto text-[11px] font-mono tabular-nums text-subtle">
            {formatDuration((batch.finishedAt ?? now) - batch.startedAt)}
          </span>
        )}
      </div>
      <ul className="divide-y divide-border">
        {batch.items.map((item) => (
          <li key={item.name} className="flex items-center gap-3 px-4 py-2.5">
            <BatchStatusIcon status={item.status} />
            {item.id ? (
              <Link href={`/run/${item.id}`} title={item.name}
                className="flex-1 min-w-0 truncate text-sm font-mono text-foreground/75 hover:text-foreground transition-colors">
                {item.name}
              </Link>
            ) : (
              <span className="flex-1 min-w-0 truncate text-sm font-mono text-subtle">{item.name}</span>
            )}
            {item.startedAt && (
              <span className="shrink-0 text-[11px] font-mono tabular-nums text-faint">
                {formatDuration((item.finishedAt ?? (item.status === "running" ? now : item.startedAt)) - item.startedAt)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
