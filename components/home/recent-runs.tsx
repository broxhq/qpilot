// The last runs the server still remembers.

import Link from "next/link";
import { type RunStatus } from "@/lib/types";
import { RunStatusIcon } from "@/components/home/status-icons";

export interface RunSummary {
  id: string;
  createdAt: number;
  status: RunStatus;
  title: string;
}

export function RecentRuns({ runs, title }: { runs: RunSummary[]; title: string }) {
  if (runs.length === 0) return null;
  return (
    <section className="mt-12 w-full">
      <h2 className="mb-3 text-[10.5px] font-semibold uppercase tracking-widest text-subtle">{title}</h2>
      <ul className="space-y-1.5">
        {runs.map((run) => (
          <li key={run.id}>
            <Link href={`/run/${run.id}`}
              className="flex items-center gap-3 rounded-xl border border-border px-4 py-3 hover:bg-surface-hover transition-colors">
              <RunStatusIcon status={run.status} />
              <span className="flex-1 min-w-0 truncate text-sm text-foreground/80">{run.title}</span>
              <span className="shrink-0 text-[11px] text-subtle font-mono tabular-nums">{formatTime(run.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Time for today's runs, date and time for older ones. */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
