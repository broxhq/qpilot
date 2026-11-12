"use client";

// The big status line at the top of a run.

import { Check, CircleAlert, Loader2, Pause, X } from "lucide-react";
import { type Dict } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface StatusCfg {
  icon: React.ReactNode;
  color: string;
  bg: string;
  border: string;
  ring?: string;
}

// only the visuals live here — label and sub come from the run's language
const STATUS_CFG: Record<string, StatusCfg> = {
  running: {
    icon: <Loader2 className="size-4 animate-spin" />,
    color: "text-foreground/75",
    bg: "bg-surface-hover",
    border: "border-border",
  },
  waiting: {
    icon: <CircleAlert className="size-4" />,
    color: "text-warning",
    bg: "bg-warning/10",
    border: "border-warning/20",
  },
  paused: {
    icon: <Pause className="size-4" />,
    color: "text-foreground/75",
    bg: "bg-surface-hover",
    border: "border-border",
  },
  passed: {
    icon: <Check className="size-4" strokeWidth={2.5} />,
    color: "text-success",
    bg: "bg-success/10",
    border: "border-success/20",
  },
  failed: {
    icon: <X className="size-4" strokeWidth={2.5} />,
    color: "text-destructive",
    bg: "bg-destructive/10",
    border: "border-destructive/20",
  },
  error: {
    icon: <CircleAlert className="size-4" />,
    color: "text-destructive",
    bg: "bg-destructive/10",
    border: "border-destructive/20",
  },
};

export function BigStatus({ status, t }: { status: string; t: Dict }) {
  const v = STATUS_CFG[status] ?? STATUS_CFG.running;
  const text = t.status[status] ?? t.status.running;
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          "flex items-center justify-center size-9 rounded-xl border transition-colors",
          v.bg,
          v.border,
          v.color,
        )}
      >
        {v.icon}
      </div>
      <div>
        <div className={cn("text-sm font-semibold tracking-tight", v.color)}>
          {text.label}
        </div>
        <div className="text-xs text-muted-foreground">{text.sub}</div>
      </div>
    </div>
  );
}
