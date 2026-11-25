// A check of the reviewer itself: does the second opinion object when it should,
// and only then?
//
//   QPILOT_REVIEW_LOG=cases.jsonl npm run live      collect cases from real runs
//   node e2e/review-eval.mjs cases.jsonl             replay them through the reviewer
//
// Every case in the log is a pass the agent reported, with the records the
// reviewer was given. The agent was right in them (take the log from runs whose
// verdicts you know), so the reviewer should not object. Two variants are made
// of each case by editing the records:
//   planted  — what the evidence quotes is replaced with something else, so the
//              records now contradict the claim: the reviewer should object;
//   stripped — the lines the evidence quotes are removed, so the claim is no
//              longer shown by anything: an objection here is the ideal, and
//              the number says how often an unsupported pass gets through.
// It spends real model calls (three per case) and is not part of CI. Run it
// before and after a change to the reviewer; LIVE_SERVER points it at another build.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = process.env.LIVE_SERVER ?? join(ROOT, ".next", "standalone", "server.js");
if (!existsSync(SERVER)) throw new Error("Build the app first: npm run build");
const [file, out] = process.argv.slice(2);
if (!file) throw new Error("Usage: node e2e/review-eval.mjs <cases.jsonl> [details.jsonl]");

const cases = readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l).case).filter(Boolean);

// what the evidence quotes and the records really carry
// a quote opens after a space and closes before one: {"ok":true} in the evidence is not a quote
const QUOTED = /(?<=^|[\s(])"([^"\n]{3,80})"(?=$|[\s.,;:)])|“([^”\n]{3,80})”|«([^»\n]{3,80})»/g;
const quoted = (c) =>
  [...new Set([...(c.step.evidence ?? "").matchAll(QUOTED)].map((m) => m[1] ?? m[2] ?? m[3]))].filter(
    (q) => c.record.includes(q) || c.tree.includes(q),
  );
const everywhere = (c, fn) => ({ ...c, record: fn(c.record), tree: fn(c.tree) });
const other = (q) => (/\d/.test(q) ? q.replace(/\d/g, (d) => String((Number(d) + 1) % 10)) : "Error: operation failed");
const variants = (c) => {
  const quotes = quoted(c);
  if (quotes.length === 0) return [{ kind: "original", c }];
  return [
    { kind: "original", c },
    { kind: "planted", c: everywhere(c, (t) => quotes.reduce((s, q) => s.split(q).join(other(q)), t)) },
    { kind: "stripped", c: everywhere(c, (t) => t.split("\n").filter((l) => !quotes.some((q) => l.includes(q))).join("\n")) },
  ];
};

const port = await new Promise((resolve) => {
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const app = spawn("node", [SERVER], { env: { ...process.env, QPILOT_DEV: "1", QPILOT_REVIEW_LOG: "", PORT: String(port), HOSTNAME: "127.0.0.1" }, stdio: ["ignore", "ignore", "inherit"] });
const tally = {};
const details = [];
try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/runs`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const jobs = cases.flatMap((c, n) => variants(c).map((v) => ({ ...v, n })));
  let next = 0;
  // a few at a time: the reviewer's calls are short, the gateway is not fast
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        let res;
        let got;
        // the gateway limits the rate now and then: wait and ask again
        for (let attempt = 0; attempt < 4; attempt++) {
          res = await fetch(`${base}/api/dev/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job.c) });
          got = await res.json();
          if (res.ok && got.verdict) break;
          await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        }
        const verdict = res.ok ? (got.verdict ?? "no answer") : `error ${res.status}`;
        tally[job.kind] ??= {};
        tally[job.kind][verdict] = (tally[job.kind][verdict] ?? 0) + 1;
        details.push({ n: job.n, kind: job.kind, step: job.c.step.description.slice(0, 80), verdict, reason: got.reason ?? got.error, lowered: got.lowered });
      }
    }),
  );
} finally {
  app.kill();
}
if (out) writeFileSync(out, details.sort((a, b) => a.n - b.n || a.kind.localeCompare(b.kind)).map((d) => JSON.stringify(d)).join("\n") + "\n");

const row = (kind, want) => {
  const t = tally[kind] ?? {};
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  const objected = (t.contradicted ?? 0) + (t.unsupported ?? 0);
  console.log(`${kind.padEnd(9)} ${String(total).padStart(3)} cases · objected ${String(objected).padStart(3)} (${want}) · ${Object.entries(t).map(([k, v]) => `${k} ${v}`).join(", ")}`);
};
console.log(`${cases.length} passes from ${file}`);
row("original", "should be 0");
row("planted", "should be all");
row("stripped", "the more the better");
for (const d of details.filter((d) => (d.kind === "original") === (d.verdict === "contradicted" || d.verdict === "unsupported"))) {
  console.log(`  ${d.kind === "original" ? "false objection" : "missed"} · ${d.kind} #${d.n} "${d.step}": ${d.verdict}${d.reason ? ` — ${String(d.reason).slice(0, 160)}` : ""}`);
}
process.exit(0);
