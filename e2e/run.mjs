// End-to-end check of the agent without a real model: the built server, a real
// Chrome, a page with a known bug, and a scripted model (see model.mjs).
//
//   npm run build && npm run e2e
//
// It answers one question: does a run still go the way it should — tools act on
// the page, verdicts land on the right steps, secrets stay out of the report?

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ref, startModel } from "./model.mjs";
import { startSite } from "./site.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, ".next", "standalone", "server.js");
const PASSWORD = "s3cret-Passw0rd";

const TOOL_NAMES = [
  "set_plan", "navigate", "snapshot", "click", "fill", "select", "hover", "press", "dismiss",
  "wait_for", "wait", "scroll_to", "scroll", "upload_file", "switch_tab", "handle_dialog", "note",
  "mock_request", "clear_mocks", "set_offline", "get_requests", "get_console", "ask_user",
  "report_step", "finish",
];

const freePort = () =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function waitFor(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up`);
}

/** Follows the run's event stream to the end; returns the final run and all events. */
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
    }
    if (run && !["running", "waiting", "paused"].includes(run.status)) break;
  }
  return { run, events };
}

assert.ok(existsSync(SERVER), "Build the app first: npm run build");

const site = await startSite();
const SWITCH = /switch "Ad labelling"/;

// The test case the scripted model "executes": three steps, the second must fail.
const model = await startModel([
  (_tree, call) => [call("set_plan", { groups: [{ title: "Switches", steps: [
    "Open the form — the switches are visible",
    "Click 400 px to the right of the switch — its state does not change",
    "Type the password and save — Saved is shown",
  ] }] })],
  (_tree, call) => [call("navigate", { url: site.url })],
  (tree, call) => [
    call("report_step", { num: 1, expected: "the switches are visible", evidence: 'switch "Ad labelling" is on the page', status: "pass" }),
    call("note", { text: "Ad labelling is off before the click" }),
    call("click", { ref: ref(tree, SWITCH), dx: 400, name: "right of Ad labelling" }),
  ],
  (tree, call) => [
    call("report_step", { num: 2, expected: "its state does not change", evidence: `it became checked [${ref(tree, SWITCH)}]`, status: "fail" }),
    call("mock_request", { url: "/api/save", status: 500, body: "{}" }),
    call("clear_mocks"),
    call("hover", { ref: ref(tree, SWITCH), name: "Ad labelling" }),
    call("press", { key: "Escape" }),
    call("fill", { ref: ref(tree, /textbox "Password"/), value: PASSWORD, name: "Password" }),
    call("click", { ref: ref(tree, /button "Save"/), name: "Save" }),
  ],
  (_tree, call) => [call("get_requests", { find: "/api/save" }), call("get_console")],
  (_tree, call) => [
    call("report_step", { num: 3, expected: "Saved is shown", evidence: `Saved; the password ${PASSWORD} was sent`, status: "pass" }),
    call("finish", { status: "passed", summary: "Step 2 failed: a click next to the switch toggles it." }),
  ],
]);

// the app under test, with its own settings directory pointing at the scripted model
const home = mkdtempSync(join(tmpdir(), "qpilot-e2e-"));
writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "custom", baseURL: model.url, apiKey: "e2e-key-0000000000", model: "scripted" }));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const app = spawn("node", [SERVER], {
  env: { ...process.env, QPILOT_HOME: home, PORT: String(port), HOSTNAME: "127.0.0.1" },
  stdio: ["ignore", "ignore", "inherit"],
});

let failed = false;
try {
  await waitFor(`${base}/api/runs`);

  const started = await fetch(`${base}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ testCase: `Switches\nURL: ${site.url}\n1. Open the form.\n2. Click next to the switch.\n3. Save.` }),
  });
  assert.equal(started.status, 200, "the run starts");
  const { run, events } = await follow(base, (await started.json()).id);

  assert.ok(!/^(Script error|The script ran out)/.test(run.summary ?? ""), run.summary);

  const errors = events.filter((e) => e.kind === "error" || (e.kind === "observation" && e.text?.startsWith("Error")));
  assert.deepEqual(errors.map((e) => e.text), [], "no tool reported an error");

  // verdicts: on the right steps, and the run is failed whatever finish() claimed
  assert.deepEqual(run.steps.map((s) => s.status), ["pass", "fail", "pass"], "verdict of every step");
  assert.equal(run.status, "failed", "a failed step fails the run, even when the model says passed");
  assert.equal(run.steps[1].expected, "its state does not change");
  assert.equal(run.steps[1].evidence, "it became checked", "refs are stripped from the report");
  assert.equal(run.steps[0].description, "Open the form — the switches are visible", "the card keeps the plan's wording");

  // the browser really did it: one toggle from the click next to the switch, one save
  assert.deepEqual(site.seen, ["toggle=1:true", "save"], "what the page saw");

  // a failed step has a screenshot, a passed one does not
  assert.ok(run.steps[1].screenshot, "the failed step has a screenshot");
  const shot = await fetch(base + run.steps[1].screenshot);
  assert.equal(shot.headers.get("content-type"), "image/jpeg");
  assert.ok((await shot.arrayBuffer()).byteLength > 1000, "the screenshot is a real image");
  assert.equal(run.steps[0].screenshot, undefined);

  // what was typed into the password field never reaches events or the report
  const shown = JSON.stringify({ run, events });
  assert.ok(!shown.includes(PASSWORD), "the password is masked everywhere a person can read it");
  assert.ok(shown.includes("••••••"), "…and shown as a mask");

  // the request log saw the save, and says which action caused it
  const requestLog = model.requests.at(-1).messages.filter((m) => m.role === "tool").map((m) => String(m.content)).find((c) => c.includes("matching request"));
  assert.match(requestLog, /POST .*\/api\/save → 200/, "the real save is in the request log");
  assert.match(requestLog, /sent after: click "Save"/, "…with the action that caused it");
  assert.match(requestLog, /"password":"•••"/, "…and its password masked for the model too");

  // what the model is given: every tool, in the agreed order
  assert.deepEqual(model.requests[0].tools.map((t) => t.function.name), TOOL_NAMES, "tools offered to the model");
  assert.equal(model.requests[0].messages[0].role, "system");

  console.log(`✓ e2e passed — ${events.filter((e) => e.kind === "action").length} tool calls, ${model.requests.length} model calls`);
} catch (err) {
  failed = true;
  console.error(`✗ e2e failed: ${err.message}`);
  if (err.actual !== undefined) console.error("  actual:  ", JSON.stringify(err.actual), "\n  expected:", JSON.stringify(err.expected));
} finally {
  app.kill();
  site.close();
  model.close();
  rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
