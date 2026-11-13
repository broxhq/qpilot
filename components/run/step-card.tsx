"use client";

// A step of the plan: verdict, expected / actual, screenshot, log.

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { type RunEvent, type StepResult } from "@/lib/types";
import { type Dict } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { LogLine, isVisibleLog } from "@/components/run/log";

const STEP_ACCENT: Record<string, { border: string; badge: string; bg: string }> = {
  queued:  { border: "border-l-border-strong",       badge: "bg-surface-hover text-subtle",     bg: ""                      },
  pass:    { border: "border-l-success/60",     badge: "bg-success/10 text-success",              bg: ""                      },
  warn:    { border: "border-l-warning/60",     badge: "bg-warning/10 text-warning",              bg: ""                      },
  fail:    { border: "border-l-destructive/60", badge: "bg-destructive/10 text-destructive",      bg: "bg-destructive/[0.03]" },
  skipped: { border: "border-l-border-strong",        badge: "bg-surface text-faint",     bg: ""                      },
};

const ACTIVE_ACCENT = {
  border: "border-l-warning/80",
  badge: "bg-warning/10 text-warning",
  bg: "bg-warning/[0.03]",
};

export function StepCard({
  step,
  events,
  active,
  displayNum,
  t,
}: {
  step: StepResult;
  events: RunEvent[];
  active: boolean;
  displayNum?: number;
  t: Dict;
}) {
  const base = STEP_ACCENT[step.status] ?? STEP_ACCENT.queued;
  const a = active ? { ...base, ...ACTIVE_ACCENT } : base;
  const visible = events.filter(isVisibleLog);
  // the model's reasoning is noise for a tester reading the report — one click away
  const thoughtN = visible.filter((e) => e.kind === "thought").length;
  const [showThoughts, setShowThoughts] = useState(false);
  const logs = showThoughts ? visible : visible.filter((e) => e.kind !== "thought");
  const verdictFailed = step.status === "fail" || step.status === "warn";

  const autoOpen = active || step.status === "fail";
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => setOpen(autoOpen), [autoOpen]);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          "rounded-xl border border-border border-l-2 overflow-hidden transition-colors",
          a.border,
          a.bg,
        )}
      >
        <CollapsibleTrigger className="group w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface transition-colors">
          <Badge
            className={cn(
              "border-0 text-[9.5px] tracking-widest font-semibold shrink-0 gap-1 uppercase rounded-md px-1.5",
              a.badge,
            )}
          >
            {active ? (
              <>
                <Loader2 className="size-2.5 animate-spin" />
                {t.stepStatus.running}
              </>
            ) : (
              t.stepStatus[step.status] ?? step.status
            )}
          </Badge>
          <span className="flex-1 min-w-0 text-[13px] text-foreground/80">
            <span className="text-subtle mr-2 font-mono text-[11px]">
              {String(displayNum ?? step.num).padStart(2, "0")}
            </span>
            {step.description}
          </span>
          <ChevronRight className="size-3.5 text-faint shrink-0 group-data-open:hidden" />
          <ChevronDown className="size-3.5 text-faint shrink-0 hidden group-data-open:inline" />
        </CollapsibleTrigger>

        {verdictFailed && step.expected ? (
          <dl className="px-4 pb-3 -mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11.5px] leading-relaxed">
            <dt className="text-subtle">{t.expected}</dt>
            <dd className="font-mono text-foreground/80">{step.expected}</dd>
            {step.evidence && (
              <>
                <dt className="text-subtle">{t.actual}</dt>
                <dd className={cn("font-mono", step.status === "fail" ? "text-destructive" : "text-warning")}>
                  {step.evidence}
                </dd>
              </>
            )}
          </dl>
        ) : (
          step.evidence && (
            <div className="px-4 pb-3 -mt-0.5 text-[11.5px] text-muted-foreground leading-relaxed font-mono">
              {step.evidence}
            </div>
          )
        )}

        {step.reviewer && (
          <p className="px-4 pb-3 -mt-1 text-[11.5px] leading-relaxed text-warning">
            ⚠ {t.reviewerObjects}: <span className="font-mono">{step.reviewer}</span>
          </p>
        )}

        {step.mockUnverified && (
          <p className="px-4 pb-3 -mt-1 text-[11px] leading-relaxed text-warning/90">⚠ {t.mockUnverified}</p>
        )}

        {step.consoleErrors && step.consoleErrors.length > 0 && (
          <details className="px-4 pb-3 -mt-1 text-[11px] text-warning/90">
            <summary className="cursor-pointer select-none">
              {t.consoleErrors}: {step.consoleErrors.length}
            </summary>
            <ul className="mt-1.5 space-y-1 font-mono text-muted-foreground">
              {step.consoleErrors.map((e, i) => (
                <li key={i} className="break-words">{e}</li>
              ))}
            </ul>
          </details>
        )}

        <CollapsibleContent>
          <div className="px-4 pb-4 pt-3 space-y-3 border-t border-border">
            {step.screenshot && (
              <a
                href={step.screenshot}
                target="_blank"
                rel="noreferrer"
                className="block rounded-lg overflow-hidden border border-border hover:border-border-strong transition-colors"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={step.screenshot}
                  alt={`screenshot step ${step.num}`}
                  className="max-h-64 w-full object-contain bg-surface"
                />
              </a>
            )}
            {logs.length > 0 ? (
              <div className="space-y-0.5">
                {logs.map((e, i) => (
                  <LogLine key={i} event={e} t={t} />
                ))}
              </div>
            ) : (
              thoughtN === 0 && (
                <div className="text-[11px] text-faint">
                  {t.noEvents}
                </div>
              )
            )}
            {thoughtN > 0 && (
              <button
                type="button"
                onClick={() => setShowThoughts((v) => !v)}
                className="text-[11px] text-subtle hover:text-foreground transition-colors"
              >
                {showThoughts ? t.hideReasoning : `${t.showReasoning} (${thoughtN})`}
              </button>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
