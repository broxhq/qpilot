// Status marks for batch items and recent runs.

import { Check, CircleAlert, Clock, Loader2, Square } from "lucide-react";
import { type RunStatus } from "@/lib/types";

export function BatchStatusIcon({ status }: { status: "queued" | "skipped" | RunStatus }) {
  if (status === "running")
    return <Loader2 className="size-3.5 shrink-0 text-subtle animate-spin" />;
  if (status === "passed")
    return <Check className="size-3.5 shrink-0 text-success" strokeWidth={2.5} />;
  if (status === "failed" || status === "error")
    return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  if (status === "paused")
    return <span className="size-3.5 shrink-0 text-[10px] text-subtle font-mono">▐▐</span>;
  if (status === "stopped")
    return <Square className="size-3 shrink-0 text-subtle" strokeWidth={2.5} />;
  if (status === "skipped")
    return <span className="size-3.5 shrink-0 text-[10px] text-faint font-mono">—</span>;
  return <span className="size-3.5 shrink-0 rounded-sm border border-border-strong inline-block" />;
}

export function RunStatusIcon({ status }: { status: RunStatus }) {
  if (status === "passed")
    return <Check className="size-3.5 shrink-0 text-success" strokeWidth={2.5} />;
  if (status === "failed" || status === "error")
    return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  if (status === "stopped")
    return <Square className="size-3 shrink-0 text-subtle" strokeWidth={2.5} />;
  return <Clock className="size-3.5 shrink-0 text-subtle" />;
}
