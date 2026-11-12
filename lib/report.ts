import type { Dict } from "./i18n";
import { groupSteps } from "./steps";
import type { Run, StepResult } from "./types";
import { formatDuration } from "./utils";

// The run as something a tester can take away: Markdown for pasting into a
// ticket, and a self-contained HTML file (screenshots inlined) for attaching.
// Both are built in the browser from the Run the page already has.

const MARK: Record<string, string> = {
  pass: "✅",
  fail: "❌",
  warn: "⚠️",
  skipped: "⏭",
  queued: "⏳",
};

function counts(run: Run, t: Dict): string {
  const n = (status: string) => run.steps.filter((s) => s.status === status).length;
  const parts = [`${n("pass")} ${t.passedCount}`];
  if (n("warn")) parts.push(`${n("warn")} ${t.warnCount}`);
  if (n("fail")) parts.push(`${n("fail")} ${t.failedCount}`);
  return `${run.steps.length} ${t.steps}: ${parts.join(", ")}`;
}

const statusLabel = (run: Run, t: Dict) => t.status[run.status]?.label ?? run.status;

export function reportMarkdown(run: Run, elapsedMs: number, t: Dict): string {
  const out: string[] = [
    `# ${run.title}`,
    "",
    `**${t.reportResult}:** ${statusLabel(run, t).toUpperCase()} — ${counts(run, t)}`,
    `**${t.reportDuration}:** ${formatDuration(elapsedMs)} · ${new Date(run.createdAt).toLocaleString()}`,
  ];
  for (const g of groupSteps(run.steps)) {
    out.push("");
    if (g.title) out.push(`## ${g.title}`, "");
    g.steps.forEach((s, i) => {
      const status = (t.stepStatus[s.status] ?? s.status).toUpperCase();
      out.push(`${i + 1}. ${MARK[s.status] ?? ""} **${status}** — ${s.description}`);
      const failed = s.status === "fail" || s.status === "warn";
      if (failed && s.expected) out.push(`   - ${t.expected}: ${s.expected}`);
      if (s.evidence) out.push(failed ? `   - ${t.actual}: ${s.evidence}` : `   - ${s.evidence}`);
      if (s.mockUnverified) out.push(`   - ⚠ ${t.mockUnverified}`);
      if (s.consoleErrors?.length) {
        out.push(`   - ${t.consoleErrors}: ${s.consoleErrors.join(" | ")}`);
      }
    });
  }
  if (run.summary) out.push("", `**${t.summary}:** ${run.summary}`);
  return out.join("\n");
}

const esc = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const COLOR: Record<string, string> = {
  pass: "#15803d",
  fail: "#b91c1c",
  warn: "#b45309",
  skipped: "#6b7280",
  queued: "#6b7280",
};

/** `shots` maps a step number to a data: URL of its screenshot. */
export function reportHtml(
  run: Run,
  elapsedMs: number,
  t: Dict,
  shots: Record<number, string>,
): string {
  const runColor = run.status === "passed" ? COLOR.pass : COLOR.fail;

  const stepHtml = (s: StepResult, displayNum: number) => {
    const failed = s.status === "fail" || s.status === "warn";
    const rows: string[] = [];
    if (failed && s.expected) rows.push(`<dt>${esc(t.expected)}</dt><dd>${esc(s.expected)}</dd>`);
    if (failed && s.evidence) {
      rows.push(
        `<dt>${esc(t.actual)}</dt><dd style="color:${COLOR[s.status]}">${esc(s.evidence)}</dd>`,
      );
    }
    const passNote =
      (!failed && s.evidence ? `<p class="ev">${esc(s.evidence)}</p>` : "") +
      (s.mockUnverified ? `<p class="ev" style="color:${COLOR.warn}">⚠ ${esc(t.mockUnverified)}</p>` : "");
    if (s.consoleErrors?.length) {
      rows.push(
        `<dt>${esc(t.consoleErrors)}</dt><dd>${s.consoleErrors.map(esc).join("<br>")}</dd>`,
      );
    }
    const shot = shots[s.num]
      ? `<img src="${shots[s.num]}" alt="${esc(t.reportScreenshot)} ${displayNum}">`
      : "";
    return `<li class="step" style="border-left-color:${COLOR[s.status] ?? "#6b7280"}">
  <div class="head"><span class="badge" style="color:${COLOR[s.status] ?? "#6b7280"}">${esc(
    (t.stepStatus[s.status] ?? s.status).toUpperCase(),
  )}</span><span class="num">${String(displayNum).padStart(2, "0")}</span>${esc(s.description)}</div>
  ${passNote}${rows.length ? `<dl>${rows.join("")}</dl>` : ""}
  ${shot}
</li>`;
  };

  const groupsHtml = groupSteps(run.steps)
    .map(
      (g) =>
        `${g.title ? `<h2>${esc(g.title)}</h2>` : ""}<ol>${g.steps
          .map((s, i) => stepHtml(s, i + 1))
          .join("")}</ol>`,
    )
    .join("");

  return `<!doctype html>
<html lang="${run.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(run.title)} — ${esc(t.reportTitle)}</title>
<style>
  body { font: 14px/1.55 -apple-system, "Segoe UI", Roboto, sans-serif; color: #111827; background: #fff; max-width: 860px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 20px; margin: 0 0 6px; overflow-wrap: anywhere; }
  h2 { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; margin: 28px 0 8px; }
  .meta { color: #4b5563; font-size: 13px; }
  .verdict { font-weight: 700; }
  ol { list-style: none; margin: 0; padding: 0; }
  .step { border: 1px solid #e5e7eb; border-left-width: 3px; border-radius: 8px; padding: 10px 14px; margin: 8px 0; break-inside: avoid; }
  .head { overflow-wrap: anywhere; }
  .badge { font-size: 11px; font-weight: 700; letter-spacing: .06em; margin-right: 8px; }
  .num { color: #9ca3af; font-family: ui-monospace, Menlo, monospace; font-size: 12px; margin-right: 8px; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; margin: 8px 0 0; font-size: 12.5px; }
  dt { color: #6b7280; }
  .ev { margin: 6px 0 0; font: 12.5px/1.5 ui-monospace, Menlo, monospace; color: #374151; overflow-wrap: anywhere; }
  dd { margin: 0; font-family: ui-monospace, Menlo, monospace; overflow-wrap: anywhere; }
  img { display: block; max-width: 100%; margin-top: 10px; border: 1px solid #e5e7eb; border-radius: 6px; }
  .summary, pre { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 14px; margin-top: 20px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.5 ui-monospace, Menlo, monospace; color: #374151; }
</style>
</head>
<body>
<h1>${esc(run.title)}</h1>
<p class="meta"><span class="verdict" style="color:${runColor}">${esc(
    statusLabel(run, t).toUpperCase(),
  )}</span> — ${esc(counts(run, t))} · ${esc(t.reportDuration)}: ${esc(
    formatDuration(elapsedMs),
  )} · ${esc(new Date(run.createdAt).toLocaleString())}</p>
${groupsHtml}
${run.summary ? `<div class="summary"><h2 style="margin-top:0">${esc(t.summary)}</h2>${esc(run.summary)}</div>` : ""}
<h2>${esc(t.testCase)}</h2>
<pre>${esc(run.testCase)}</pre>
</body>
</html>`;
}
