"use client";

// Shown once a run has finished.

import { Star } from "lucide-react";

export function StarCta() {
  return (
    <a
      href="https://github.com/broxhq/qpilot"
      target="_blank"
      rel="noreferrer"
      className="group mt-6 flex items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-3 transition-colors hover:border-warning/30 hover:bg-warning/[0.03]"
    >
      <Star className="size-4 shrink-0 text-subtle transition-colors group-hover:text-warning group-hover:fill-warning" />
      <div className="min-w-0">
        <div className="text-sm text-foreground/80">
          Did qpilot save you time?{" "}
          <span className="text-foreground/95 group-hover:text-warning transition-colors">
            Star it on GitHub
          </span>
        </div>
        <div className="text-xs text-subtle">
          A ⭐ helps more people find it — takes two seconds.
        </div>
      </div>
    </a>
  );
}
