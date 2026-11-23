"use client";

// The requests a verdict rests on, shown the way the Network tab would: the
// line of the request, what it was sent after, and its body in full.

import { type RequestProof } from "@/lib/types";
import { type Dict } from "@/lib/i18n";
import { requestLine } from "@/lib/report";
import { cn } from "@/lib/utils";

export function RequestProofs({ requests, open, t }: { requests: RequestProof[]; open: boolean; t: Dict }) {
  return (
    <details open={open} className="px-4 pb-3 -mt-1 text-[11px]">
      <summary className="cursor-pointer select-none text-subtle">
        {t.proofRequests}: {requests.length}
      </summary>
      <div className="mt-2 space-y-2">
        {requests.map((r, i) => {
          const bad = !!r.failed || (r.status ?? 0) >= 400;
          return (
            <div key={i} className="rounded-lg border border-border bg-surface overflow-hidden">
              <div className={cn("px-3 py-2 font-mono break-all", bad ? "text-destructive" : "text-foreground/80")}>
                {requestLine(r)}
              </div>
              <div className="px-3 pb-2 -mt-1 text-subtle">
                {t.proofSentAfter}: <span className="font-mono">{r.after}</span>
              </div>
              <Body label={t.proofRequestBody} text={r.requestBody} empty={t.proofNoBody} />
              {r.responseBody && <Body label={t.proofResponseBody} text={r.responseBody} empty={t.proofNoBody} />}
            </div>
          );
        })}
      </div>
    </details>
  );
}

function Body({ label, text, empty }: { label: string; text?: string; empty: string }) {
  return (
    <div className="border-t border-border">
      <div className="px-3 pt-1.5 text-[10px] uppercase tracking-wider text-faint">{label}</div>
      {text ? (
        <pre className="px-3 pb-2 pt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
          {text}
        </pre>
      ) : (
        <div className="px-3 pb-2 pt-1 text-faint">{empty}</div>
      )}
    </div>
  );
}
