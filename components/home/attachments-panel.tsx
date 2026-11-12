"use client";

// Files the agent can hand to an upload control during the run.

import { Paperclip, X } from "lucide-react";
import { dict } from "@/lib/i18n";
import { formatSize } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Files the agent can hand to a file input during the run (photos, CSVs,
 * documents). They apply to both the single run and every run in a batch.
 */
export function AttachmentsPanel({
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
