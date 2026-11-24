// The same pages as the e2e run, but with the real model from your settings.
//
//   npm run build && npm run live            all cases, three runs each
//   npm run live -- form toast               only these
//   npm run live -- --runs 1                 a quick look: one run each
//
// e2e proves the framework does what it should with a model that follows a
// script. It says nothing about how a real model reads a page and decides. This
// runs a handful of small cases whose right verdict is known — one per way the
// agent has gone wrong on real sites — and prints what the model did with each:
// the verdict against the expected one, the evidence, how many actions and model
// calls it took. Run it before and after a change to the prompt or the tools,
// and with a second model to tell what is the model and what is the framework.
//
// Every case is run several times (--runs, three by default): a model answers a
// little differently each time, and one run of eight cases cannot tell a change
// that helped from luck. What counts is how many cases were right EVERY time;
// "right at least once" is printed next to it to show how much is luck.
//
// It uses ~/.qpilot/config.json (or the QPILOT_* variables), spends real model
// calls, and is not part of CI.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSite } from "./site.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// LIVE_SERVER=<path to another build's server.js> runs the same cases against
// that build — an older commit, to see what a change did.
const SERVER = process.env.LIVE_SERVER ?? join(ROOT, ".next", "standalone", "server.js");
if (!existsSync(SERVER)) throw new Error("Build the app first: npm run build");

// expect: the right status of each step; says: what the evidence must mention
const CASES = {
  form: {
    about: "a form that refuses in silence until a required field is filled",
    text: (url) => `Records\nURL: ${url}form\n1. Press Save.\n   Expected result: the record is saved, the status shows "Saved".`,
    expect: ["pass"],
    says: [/saved/i],
  },
  unmarked: {
    about: "the same form with nothing on the page to say which field is required",
    text: (url) => `Records\nURL: ${url}unmarked\n1. Press Save.\n   Expected result: the record is saved, the status shows "Saved".`,
    expect: ["pass"],
    says: [/saved/i],
  },
  toast: {
    about: "an error shown only by a toast that is gone in two seconds",
    text: (url) => `Records\nURL: ${url}toast\n1. Press Save.\n   Expected result: the record is saved without errors.`,
    expect: ["fail"],
    says: [/limit is exceeded/i],
  },
  countries: {
    about: "a step about every item, where only the last item is wrong",
    text: (url) => `Prices\nURL: ${url}countries\n1. Open every country tab in turn.\n   Expected result: each country shows a price in USD.`,
    expect: ["fail"],
    says: [/tanzania/i],
  },
  bell: {
    about: "an unnamed icon in a header that sits at the end of the DOM, and a namesake block down the page",
    text: (url) => `Notices\nURL: ${url}big\n1. Open the notices panel with the bell icon in the header (the second icon).\n   Expected result: the panel opens and lists fresh notices.`,
    expect: ["pass"],
    says: [/fresh notice/i],
  },
  events: {
    about: "an analytics event sent as a beacon, in a batch — and one that is not sent at all",
    text: (url) => `Analytics\nURL: ${url}events\n1. Press "Open notices".\n   Expected result: the event Supplier_Notice_S is sent with the parameters idSupplier and tabName.\n2. Look at the same requests again.\n   Expected result: the event Supplier_Notice_Scroll was sent too.`,
    expect: ["pass", "fail"],
    says: [/Supplier_Notice_S/, /tabName|idSupplier/],
  },
  crowded: {
    about: "an unnamed icon in a header at the end of the DOM, on a screen that holds more than the budget",
    text: (url) => `Header\nURL: ${url}crowded\n1. Find the bell icon in the header: it is the second icon, it has no caption.\n   Expected result: the header has two icons.`,
    expect: ["pass"],
    says: [/icon|button|иконк/i],
  },
  switches: {
    about: "a real defect: a click next to a switch toggles it",
    text: (url) => `Switches\nURL: ${url}\n1. Click 400 px to the right of the "Ad labelling" switch.\n   Expected result: the state of the switch does not change.`,
    expect: ["fail"],
    says: [/check|on|включ/i],
  },
};

const freePort = () =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
}

async function follow(base, id) {
  const res = await fetch(`${base}/api/run/${id}/stream`);
  const events = [];
  let run;
  let buffer = "";
  for await (const chunk of res.body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      if (!frame.startsWith("data:")) continue;
      const data = JSON.parse(frame.slice(5));
      run = data.run;
      events.push(...(data.events ?? []), ...(data.event ? [data.event] : []));
      // a case here never needs a person: an agent that asks has gone wrong
      if (run?.status === "waiting") return { run, events, asked: true };
    }
    if (run && !["running", "waiting", "paused"].includes(run.status)) break;
  }
  return { run, events };
}

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const RUNS = Math.max(1, Number(runsAt >= 0 ? args[runsAt + 1] : 3) || 3);
const wanted = args.filter((a, i) => !a.startsWith("-") && !(runsAt >= 0 && i === runsAt + 1));
const names = wanted.length ? wanted : Object.keys(CASES);
for (const n of names) if (!CASES[n]) throw new Error(`No case "${n}". There are: ${Object.keys(CASES).join(", ")}`);

const site = await startSite();
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
// these pages need no sign-in, and a test site must not end up among your saved sign-ins
const app = spawn("node", [SERVER], { env: { QPILOT_SESSIONS: "0", ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1" }, stdio: ["ignore", "ignore", "inherit"] });
let wrong = 0;
const tally = [];
try {
  await waitFor(`${base}/api/runs`);
  for (const name of names) {
    const c = CASES[name];
    console.log(`\n${name} — ${c.about}`);
    console.log(`  expected: ${c.expect.join(", ")}`);
    let right = 0;
    for (let n = 1; n <= RUNS; n++) {
      const started = Date.now();
      const res = await fetch(`${base}/api/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ testCase: c.text(site.url) }) });
      if (!res.ok) throw new Error(`The run did not start: ${res.status} ${await res.text()}`);
      const { run, events, asked } = await follow(base, (await res.json()).id);
      const got = run.steps.map((s) => s.status);
      const evidence = run.steps.map((s) => s.evidence ?? "").join(" ");
      const verdict = JSON.stringify(got) === JSON.stringify(c.expect);
      const reason = c.says.every((re) => re.test(evidence));
      const ok = !asked && verdict && reason;
      // a right verdict for the wrong reason is not a right run: say which it was
      const why = ok ? "" : asked ? "asked the user and was stopped" : !verdict ? "wrong verdict" : "right verdict, wrong reason";
      if (ok) right++;
      else wrong++;
      const actions = events.filter((e) => e.kind === "action").map((e) => e.toolName);
      // calls the framework turned down: a guard at work, worth seeing even in a run that came out right
      const refused = events.filter((e) => e.kind === "observation" && e.text?.startsWith("Error")).map((e) => e.text.split(/[.:]\s/)[1] ?? "");
      console.log(`  ${ok ? "✓" : "✗"} run ${n}: ${got.join(", ") || "(no steps)"}${why ? ` — ${why}` : ""} · ${actions.length} tool calls, ${run.stats?.calls ?? "?"} model calls, ${Math.round((Date.now() - started) / 1000)} s${refused.length ? ` · refused: ${refused.join("; ").slice(0, 120)}` : ""}`);
      // the details of a run are worth reading only when it went wrong, or once per case
      if (!ok || n === 1) {
        for (const s of run.steps) console.log(`      ${s.num}. [${s.status}] ${s.evidence ?? ""}${s.reviewer ? `\n         reviewer: ${s.reviewer}` : ""}`);
        if (run.status === "error" || !run.steps.length) console.log(`      run: ${run.status} — ${run.summary ?? events.findLast((e) => e.kind === "error")?.text ?? ""}`);
        console.log(`      tools: ${actions.join(" ")}`);
      }
      if (!ok) {
        const thoughts = events.filter((e) => e.kind === "thought").map((e) => e.text.replace(/\s+/g, " ").slice(0, 200));
        if (thoughts.length) console.log(`      said: ${thoughts.join(" | ")}`);
      }
    }
    tally.push({ name, right });
    console.log(`  ${right} of ${RUNS} runs right`);
  }
} finally {
  app.kill();
  site.close();
}
const every = tally.filter((t) => t.right === RUNS).length;
const once = tally.filter((t) => t.right > 0).length;
console.log(`\n${names.length} cases × ${RUNS} runs`);
console.log(`right every time:   ${every} of ${names.length}${every < names.length ? ` (not: ${tally.filter((t) => t.right < RUNS).map((t) => `${t.name} ${t.right}/${RUNS}`).join(", ")})` : ""}`);
console.log(`right at least once: ${once} of ${names.length}`);
console.log(`runs right:          ${tally.reduce((n, t) => n + t.right, 0)} of ${names.length * RUNS}`);
process.exit(wrong ? 1 : 0);
