// End-to-end check of the agent without a real model: the built server, a real
// Chrome, a page with a known bug, and a scripted model (see model.mjs).
//
//   npm run build && npm run e2e
//
// It answers one question: does a run still go the way it should — tools act on
// the page, verdicts land on the right steps, secrets stay out of the report, a
// model that cannot see is given the text-only agent, and a pass the second
// opinion objects to ends up as a warn?

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ref, startModel } from "./model.mjs";
import { startSite } from "./site.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, ".next", "standalone", "server.js");
const PASSWORD = "s3cret-Passw0rd";

const TEXT_TOOLS = [
  "set_plan", "navigate", "snapshot", "click", "fill", "select", "hover", "press", "dismiss",
  "clear_session", "wait_for", "wait", "scroll_to", "scroll", "upload_file", "switch_tab", "handle_dialog", "note",
  "mock_request", "clear_mocks", "set_offline", "get_requests", "get_console", "ask_user",
  "report_step", "finish",
];
// with eyes, four more — each next to its text counterpart
const VISION_TOOLS = TEXT_TOOLS.flatMap((t) =>
  t === "snapshot" ? [t, "look", "measure"] : t === "click" ? [t, "click_at"] : t === "hover" ? [t, "hover_at"] : [t],
);

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
async function follow(base, id, leaveWhenWaiting = false, answer) {
  const answered = new Set();
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
    if (run?.status === "waiting" && leaveWhenWaiting) break;
    // a person at the run page, typing what the agent asked for
    if (run?.status === "waiting" && run.pending && answer !== undefined && !answered.has(run.pending.id)) {
      answered.add(run.pending.id);
      await fetch(`${base}/api/run/${id}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questionId: run.pending.id, answer }),
      });
    }
  }
  return { run, events };
}

/**
 * One run of the app against a scripted model: its own server, its own settings
 * directory. `env` is added to the server's environment, `review` answers the
 * second-opinion questions (see model.mjs). `home` keeps the settings directory
 * from one run to the next (it is then the caller's to remove); `probe(base)`
 * is called while the server is still up, and what it returns comes back as `probed`.
 * `abandon` leaves the run as soon as it asks the user something: the server is
 * then killed with the run still going. `answer` is what the user replies to
 * every question the agent asks.
 */
async function runWith(script, testCase, env = {}, review, { home: kept, probe, abandon, answer } = {}) {
  const model = await startModel(script, { review });
  const home = kept ?? mkdtempSync(join(tmpdir(), "qpilot-e2e-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ provider: "custom", baseURL: model.url, apiKey: "e2e-key-0000000000", model: "scripted" }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const app = spawn("node", [SERVER], {
    env: { ...process.env, ...env, QPILOT_HOME: home, PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    await waitFor(`${base}/api/runs`);
    const started = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ testCase }),
    });
    assert.equal(started.status, 200, "the run starts");
    const { run, events } = await follow(base, (await started.json()).id, abandon, answer);
    assert.ok(!/^(Script error|The script ran out)/.test(run.summary ?? ""), run.summary);
    // fetched now: the server is gone once this function returns
    const shots = {};
    for (const step of run.steps.filter((s) => s.screenshot)) {
      const res = await fetch(base + step.screenshot);
      shots[step.num] = { type: res.headers.get("content-type"), bytes: (await res.arrayBuffer()).byteLength };
    }
    const probed = probe ? await probe(base) : undefined;
    return { run, events, model, shots, probed };
  } finally {
    // the server may still be writing into its directory: wait until it is gone
    const gone = once(app, "exit");
    // SIGKILL when the run is abandoned: the server gets no chance to tidy up
    app.kill(abandon ? "SIGKILL" : undefined);
    await gone;
    model.close();
    if (!kept) rmSync(home, { recursive: true, force: true });
  }
}

const toolResults = (request) => request.messages.filter((m) => m.role === "tool").map((m) => String(m.content));

assert.ok(existsSync(SERVER), "Build the app first: npm run build");

let failed = false;
const site = await startSite();
const SWITCH = /switch "Ad labelling"/;

try {
  // ── 1. a whole run, with a model that can see ────────────────────────────────
  // (QPILOT_VISION=1 skips the "can you see?" question: a scripted model cannot answer it)
  {
    const { run, events, model, shots } = await runWith(
      [
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
        (_tree, call) => [call("get_requests", { find: "/api/save" }), call("get_console"), call("look", { why: "find the blue pad" })],
        // the pad is a canvas at (600, 300), 200×60: only the screenshot tells where it is
        (_tree, call) => [call("click_at", { x: 700, y: 330, name: "the blue pad" })],
        (_tree, call) => [
          call("report_step", { num: 3, expected: "Saved is shown", evidence: `Saved; the password ${PASSWORD} was sent`, status: "pass" }),
          call("finish", { status: "passed", summary: "Step 2 failed: a click next to the switch toggles it." }),
        ],
      ],
      `Switches\nURL: ${site.url}\n1. Open the form.\n2. Click next to the switch.\n3. Save.`,
      { QPILOT_VISION: "1" },
    );

    const errors = events.filter((e) => e.kind === "error" || (e.kind === "observation" && e.text?.startsWith("Error")));
    assert.deepEqual(errors.map((e) => e.text), [], "no tool reported an error");

    // verdicts: on the right steps, and the run is failed whatever finish() claimed
    assert.deepEqual(run.steps.map((s) => s.status), ["pass", "fail", "pass"], "verdict of every step");
    assert.equal(run.status, "failed", "a failed step fails the run, even when the model says passed");
    assert.equal(run.steps[1].expected, "its state does not change");
    assert.equal(run.steps[1].evidence, "it became checked", "refs are stripped from the report");
    assert.equal(run.steps[0].description, "Open the form — the switches are visible", "the card keeps the plan's wording");

    // the browser really did it: a toggle from the click next to the switch, a save,
    // and a click on the canvas found by sight
    assert.deepEqual(site.seen, ["toggle=1:true", "save", "canvas"], "what the page saw");

    // a failed step has a screenshot, a passed one does not
    assert.ok(run.steps[1].screenshot, "the failed step has a screenshot");
    assert.equal(shots[2]?.type, "image/jpeg");
    assert.ok(shots[2].bytes > 1000, "the screenshot is a real image");
    assert.equal(run.steps[0].screenshot, undefined);

    // every pass got a second opinion, the fail did not; a confirmed pass stays as it was
    assert.deepEqual(
      model.reviews.map((r) => r.messages[1].content.match(/Step under review: (\d+)/)?.[1]),
      ["1", "3"],
      "passes are reviewed, fails are not",
    );
    assert.equal(run.steps[0].reviewer, undefined);

    // what was typed into the password field never reaches events or the report
    const shown = JSON.stringify({ run, events });
    assert.ok(!shown.includes(PASSWORD), "the password is masked everywhere a person can read it");
    assert.ok(shown.includes("••••••"), "…and shown as a mask");

    // the request log saw the save, and says which action caused it
    const requestLog = toolResults(model.requests.at(-1)).find((c) => c.includes("matching request"));
    assert.match(requestLog, /POST .*\/api\/save → 200/, "the real save is in the request log");
    assert.match(requestLog, /sent after: click "Save"/, "…with the action that caused it");
    assert.match(requestLog, /"password":"•••"/, "…and its password masked for the model too");

    // look: the model gets the screenshot as an image, events do not carry it
    const afterLook = model.requests.find((r) => r.messages.some((m) => Array.isArray(m.content)));
    const picture = afterLook?.messages.findLast((m) => Array.isArray(m.content)).content.find((p) => p.type === "image_url");
    assert.match(picture?.image_url.url ?? "", /^data:image\/jpeg;base64,/, "look hands the model a screenshot");
    assert.ok(!shown.includes("base64"), "the screenshot is not copied into the run's events");
    assert.equal(run.vision, true);

    // what a model with eyes is given
    assert.deepEqual(model.requests[0].tools.map((t) => t.function.name), VISION_TOOLS, "tools offered with vision");
    assert.match(model.requests[0].messages[0].content, /EYES/, "the prompt explains when to look");

    console.log(`✓ full run — ${events.filter((e) => e.kind === "action").length} tool calls, ${model.requests.length} model calls`);
  }

  // ── 2. a model that cannot see gets the text-only agent ──────────────────────
  {
    const { run, model } = await runWith(
      [(_tree, call) => [call("finish", { status: "passed", summary: "Nothing to do." })]],
      "Nothing",
    );
    assert.equal(model.visionChecks.length, 1, "the agent asks once whether the model can see");
    assert.equal(model.visionChecks[0].messages[0].content.some((p) => p.type === "image_url"), true);
    assert.deepEqual(model.requests[0].tools.map((t) => t.function.name), TEXT_TOOLS, "no vision tools for a model that cannot see");
    assert.doesNotMatch(model.requests[0].messages[0].content, /EYES|click_at/, "…and nothing about looking in the prompt");
    assert.notEqual(run.vision, true);
    console.log("✓ a model that cannot see is given the text-only tools and prompt");
  }

  // ── 3. the second opinion objects to a pass ──────────────────────────────────
  {
    const { run, model, shots } = await runWith(
      [
        (_tree, call) => [call("set_plan", { groups: [{ steps: ["Open the form — the form is shown", "Save — Saved is shown"] }] })],
        (_tree, call) => [call("navigate", { url: site.url })],
        (tree, call) => [
          call("report_step", { num: 1, expected: "the form is shown", evidence: "heading Banner form", status: "pass" }),
          call("click", { ref: ref(tree, /button "Save"/), name: "Save" }),
        ],
        (_tree, call) => [
          call("report_step", { num: 2, expected: "Saved is shown", evidence: "status: Saved", status: "pass" }),
          call("finish", { status: "passed", summary: "All good." }),
        ],
      ],
      `Form\nURL: ${site.url}\n1. Open the form.\n2. Save.`,
      { QPILOT_VISION: "0" },
      (body) =>
        body.messages[1].content.includes("Step under review: 2)")
          ? 'Here is my answer:\n```json\n{"verdict":"contradicted","reason":"The page tree shows no Saved [ref=e9]."}\n```'
          : '{"verdict":"cannot_tell","reason":"Not enough."}',
    );

    assert.deepEqual(run.steps.map((s) => s.status), ["pass", "warn"], "an objection turns the pass into a warn, doubt does not");
    assert.equal(run.steps[1].reviewer, "The page tree shows no Saved.", "the reason is on the step, without refs");
    assert.equal(run.steps[1].evidence, "status: Saved", "the agent's own evidence stays");
    assert.equal(shots[2]?.type, "image/jpeg", "the disputed step gets the screenshot taken when it was reported");
    assert.equal(run.status, "passed", "a warn does not fail the run");

    // what the reviewer was given: the step, the claim, the tool results and the page — no refs, no tools
    const question = model.reviews[1].messages[1].content;
    assert.match(question, /Agent's evidence: status: Saved/);
    assert.match(question, /click \{.*"name":"Save"\}\n→ OK: clicked Save/, "the tool results of the step are in the records");
    assert.doesNotMatch(question.split("Records")[1].split("The page tree as")[0], /Page snapshot/, "…without a page tree per action");
    assert.match(question, /status: Saved/, "the page as the agent last saw it");
    assert.doesNotMatch(question, /\[ref=e\d/);
    assert.equal(model.reviews[1].tools, undefined);
    console.log("✓ a pass the second opinion objects to becomes a warn with the reason");
  }

  // 41 actions on one step: one more than the framework allows
  const wander = () => (_tree, call) => Array.from({ length: 41 }, () => call("clear_mocks"));
  const onceMore = (_tree, call) => [call("clear_mocks")];

  // ── 4. a step the agent cannot finish is closed for it, the run goes on ──────
  {
    const { run, model, shots } = await runWith(
      [
        (_tree, call) => [call("set_plan", { groups: [{ steps: ["Wander about", "Open the form — the form is shown"] }] })],
        wander(),
        onceMore,
        (_tree, call) => [call("report_step", { num: 1, evidence: "done after all", status: "pass" }), call("navigate", { url: site.url })],
        (_tree, call) => [
          call("report_step", { num: 2, expected: "the form is shown", evidence: "heading Banner form", status: "pass" }),
          call("finish", { status: "passed", summary: "Done." }),
        ],
      ],
      "Wander\n1. Wander about.\n2. Open the form.",
      { QPILOT_VISION: "0" },
    );

    assert.deepEqual(run.steps.map((s) => s.status), ["fail", "pass"], "the step is closed as fail, the next one is still run");
    assert.match(run.steps[0].evidence, /40 actions/, "the card says why it was closed");
    assert.equal(shots[1]?.type, "image/jpeg", "…with a screenshot of the moment");
    assert.equal(run.status, "failed");
    const told = toolResults(model.requests[2]);
    assert.equal(told.filter((c) => c.includes("OK: removed")).length, 40, "40 actions ran");
    assert.match(told.at(-1), /not executed\. You have used 40 actions on step 1\. Call report_step for step 1 now/, "the 41st did not: the model is asked for its own verdict first");
    assert.match(toolResults(model.requests[3]).at(-1), /not executed\. Step 1 was closed by the framework as fail.*Go on with step 2/s, "it went on acting instead, so the step is closed for it");
    assert.match(toolResults(model.requests[4]).find((c) => c.includes("already reported")) ?? "", /step 1 is already reported as fail/, "the agent cannot overrule it afterwards");
    console.log("✓ a step that eats 40 actions is closed as fail and the run goes on");
  }

  // ── 4b. …but a verdict the agent gives when asked is its own ────────────────
  {
    const { run } = await runWith(
      [
        (_tree, call) => [call("set_plan", { groups: [{ steps: ["Wander about"] }] })],
        wander(),
        (_tree, call) => [
          call("report_step", { num: 1, expected: "it works", evidence: "tried 40 times, the page never answered", status: "warn" }),
          call("finish", { status: "failed", summary: "Done." }),
        ],
      ],
      "Wander\n1. Wander about.",
      { QPILOT_VISION: "0" },
    );
    assert.deepEqual(run.steps.map((s) => [s.status, s.evidence]), [["warn", "tried 40 times, the page never answered"]], "the agent's own words are on the card, not the framework's");
    console.log("✓ asked for a verdict at the limit, the agent gives its own");
  }

  // ── 5. three such steps in a row end the run ─────────────────────────────────
  {
    const { run, model } = await runWith(
      [
        (_tree, call) => [call("set_plan", { groups: [{ steps: ["One", "Two", "Three", "Four"] }] })],
        wander(), onceMore,
        wander(), onceMore,
        wander(), onceMore,
      ],
      "Lost\n1. One.\n2. Two.\n3. Three.\n4. Four.",
      { QPILOT_VISION: "0" },
    );

    assert.deepEqual(run.steps.map((s) => s.status), ["fail", "fail", "fail", "skipped"], "three steps closed, the rest not attempted");
    assert.match(run.summary, /3 steps in a row/);
    assert.equal(model.requests.length, 7, "no model call after the third");
    console.log("✓ three steps closed in a row stop the run");
  }

  // ── 6. a list in a panel scrolls under the pointer; a list nobody sees does not ─
  {
    const { model } = await runWith(
      [
        (_tree, call) => [call("set_plan", { groups: [{ steps: ["Scroll the panel — it scrolls"] }] })],
        (_tree, call) => [call("navigate", { url: site.url + "panel" })],
        (tree, call) => [call("scroll", { ref: ref(tree, /button "Notice 1"/), y: 300 })],
        (tree, call) => [call("scroll", { ref: ref(tree, /button "Buried 1"/), y: 300 })],
        (_tree, call) => [
          call("report_step", { num: 1, expected: "it scrolls", evidence: "the panel moved by 300px", status: "pass" }),
          call("finish", { status: "passed", summary: "Done." }),
        ],
      ],
      "Panel\n1. Scroll the panel.",
      { QPILOT_VISION: "0" },
    );
    const results = toolResults(model.requests.at(-1));
    const visible = results.find((c) => c.includes("scrolled <aside> block"));
    assert.match(visible ?? "", /by \(0, 300\)px.*The element moved 300px on screen/s, "the panel list scrolls, and the result says the item moved on screen");
    assert.match(results.find((c) => c.startsWith("Not scrolled")) ?? "", /<div#cover> is on top of it/, "a list under a cover is not scrolled, and the result says what covers it");
    assert.ok(site.seen.includes("list-scrolled"), "the page saw the panel scroll");
    assert.ok(!site.seen.includes("buried-scrolled"), "…and the hidden list was left alone");
    console.log("✓ scrolling moves the list under the pointer and refuses one that is not on screen");
  }

  // ── 7. a page bigger than the budget: what is on screen comes first ─────────
  {
    const { model } = await runWith(
      [
        (_tree, call) => [call("set_plan", { groups: [{ steps: ["Open the bell — the panel opens"] }] })],
        (_tree, call) => [call("navigate", { url: site.url + "big" })],
        (tree, call) => [call("click", { ref: ref(tree, /menu-communication/) })],
        (_tree, call) => [call("snapshot", { near: "Notices" })],
        (_tree, call) => [
          call("report_step", { num: 1, expected: "the panel opens", evidence: "Fresh notice 1 is listed", status: "pass" }),
          call("finish", { status: "passed", summary: "Done." }),
        ],
      ],
      "Big\n1. Open the bell.",
      { QPILOT_VISION: "0" },
    );
    const results = toolResults(model.requests.at(-1));
    const split = (c) => c.split("OFF SCREEN");
    const opened = results.find((c) => c.startsWith("OK: navigated")) ?? "";
    assert.equal(split(opened).length, 2, "a big page comes in two parts");
    assert.match(split(opened)[0], /button \[ref=e\d+\] \(no name; data-testid=menu-communication[^)]*, at \d+,\d+\)/, "the header at the end of the DOM is in the on-screen part, with its hint and its place on screen");
    assert.doesNotMatch(split(opened)[0], /Report line 400|Old notice 1/, "what is down the page is not in the on-screen part");
    assert.match(split(opened)[1], /Report line 30/, "…the rest follows in page order");
    const clicked = results.find((c) => /^OK: clicked/.test(c)) ?? "";
    assert.match(clicked.split("Page snapshot")[0], /\+ .*Fresh notice 1/, "the opened panel is listed under Changes although it is past the cut");
    assert.match(split(clicked)[0], /Fresh notice 1/, "…and is shown in the on-screen part");
    const near = results.find((c) => c.includes('scoped to the block around "Notices"')) ?? "";
    assert.match(near, /Fresh notice 1/, "near= picks the block that is on screen");
    assert.doesNotMatch(near, /Old notice 1/, "…not its namesake down the page");
    console.log("✓ a page bigger than the budget shows what is on screen first");
  }

  // ── 8. a toast that is gone before the next look is still reported ──────────
  {
    const { run, events, model } = await runWith(
      [
        (_tree, call) => [call("set_plan", { groups: [{ steps: ["Save — saved"] }] })],
        (_tree, call) => [call("navigate", { url: site.url + "toast" })],
        (tree, call) => [call("click", { ref: ref(tree, /button "Save"/) })],
        (_tree, call) => [call("wait", { ms: 3000 })],
        (tree, call) => [call("click", { ref: ref(tree, /button "Check"/) })],
        (_tree, call) => [call("wait", { ms: 3000 })],
        (_tree, call) => [
          call("report_step", { num: 1, expected: "saved", evidence: "Could not save: the limit is exceeded", status: "fail" }),
          call("finish", { status: "failed", summary: "Done." }),
        ],
      ],
      "Toast\n1. Save.",
      { QPILOT_VISION: "0" },
    );
    const results = toolResults(model.requests.at(-1));
    const saved = results.find((c) => c.startsWith("OK: clicked") && c.includes("Could not save")) ?? "";
    assert.match(saved.split("Page snapshot")[1] ?? "", /Could not save: the limit is exceeded/, "the page is read once the toast has faded in, not while it is still transparent");
    const waited = results.find((c) => c.includes("Could not save") && c.includes("vanished on its own")) ?? "";
    assert.match(waited, /^NOTE: Appeared on the page and vanished on its own: "Could not save: the limit is exceeded"/, "the vanished toast is handed to the model");
    const plain = results.find((c) => c.includes("This name is taken") && c.includes("vanished on its own")) ?? "";
    assert.match(plain, /^NOTE: Appeared on the page and vanished on its own: "This name is taken"/, "so is a plain line of the page that came and went");
    assert.ok(!results.some((c) => /vanished on its own: "Stays here"/.test(c)), "a re-render with the same words is not a vanishing");
    assert.doesNotMatch(waited.split("Page snapshot")[1] ?? "", /Could not save/, "…although the page no longer shows it");
    assert.ok(events.some((e) => e.info?.type === "flash" && e.info.message.includes("Could not save")), "the log has it too");
    assert.ok(run.steps[0].screenshot, "the failed step has a screenshot");
    console.log("✓ a message that vanished before the next look is reported");
  }

  // ── 9. a form that refuses in silence: the agent is told why, and is not let press a third time ─
  {
    const savesBefore = site.seen.filter((s) => s === "save").length;
    const { run, model } = await runWith(
      [
        (_tree, call) => [call("set_plan", { groups: [{ steps: ["Save the record — Saved is shown"] }] })],
        (_tree, call) => [call("navigate", { url: site.url + "form" })],
        (tree, call) => [call("click", { ref: ref(tree, /button "Save"/), name: "Save" })],
        (tree, call) => [call("click", { ref: ref(tree, /button "Save"/), name: "Save" })],
        (tree, call) => [call("click", { ref: ref(tree, /button "Save"/), name: "Save again" })],
        (tree, call) => [
          call("fill", { ref: ref(tree, /textbox "Title/), value: "Record", name: "Title" }),
          call("click", { ref: ref(tree, /button "Save"/), name: "Save" }),
        ],
        (_tree, call) => [
          call("report_step", { num: 1, expected: "Saved is shown", evidence: "status: Saved; the Title was empty and had to be filled first", status: "pass" }),
          call("finish", { status: "passed", summary: "Done." }),
        ],
      ],
      "Form\n1. Save the record.",
      { QPILOT_VISION: "0" },
    );
    const last = model.requests.at(-1);
    const results = toolResults(last);
    const silent = results.filter((c) => c.startsWith("OK: clicked Save\nAfter this action: no request was sent and the page did not change (keyboard focus aside) — it had no effect"));
    assert.equal(silent.length, 2, "a click that did nothing says so: no request, no change");
    assert.doesNotMatch(silent[0], /ON SCREEN NOW/, "a page that is all on screen is given as one tree");
    assert.match(silent[0], /Fields that look required but are empty or invalid.*"Title \*" — marked required \(\*\) and empty/, "…and names the field the form is waiting for");
    assert.match(results.find((c) => c.includes("This exact action has been done 2 times")) ?? "", /^Error: not executed/, "the third identical press is not made");
    assert.match(results.find((c) => c.includes("/api/save → 200")) ?? "", /After this action: 1 request\(s\) sent:\n  POST [^\n]*\/api\/save → 200/, "a click that did send a request says which and how it was answered");
    assert.equal(site.seen.filter((s) => s === "save").length - savesBefore, 1, "the record was saved once");
    // where the run stands is told every turn, with what was tried and what came of it
    const state = model.requests[5].messages.at(-1);
    assert.equal(state.role, "user");
    assert.match(state.content, /^\[STATE/);
    assert.match(state.content, /Step 1 of 1: "Save the record — Saved is shown"/);
    assert.match(state.content, /1\. OK: navigated[^\n]*\n\s+2\. OK: clicked Save → no request sent, page unchanged; 1 field\(s\) look unfilled\n\s+3\. OK: clicked Save → no request sent, page unchanged/, "the ledger lists the actions of the step with their outcomes");
    assert.deepEqual(run.steps.map((s) => s.status), ["pass"]);
    console.log("✓ a silent form: the outcome, the blocking field and the ledger reach the model; a third identical press is refused");
  }

  // ── 10. a long history: old page trees go, what the actions led to stays ─────
  {
    const again = (_tree, call) => [call("navigate", { url: site.url + "big" })];
    const { run, model } = await runWith(
      [
        (_tree, call) => [call("set_plan", { groups: [{ steps: ["Open the page — it opens"] }] })],
        again, again, again, again, again,
        // a verdict in the same turn as the action it judges is turned down — and
        // the finish that follows it must not close the run with the step unreported
        (_tree, call) => [
          call("navigate", { url: site.url + "big" }),
          call("report_step", { num: 1, expected: "it opens", evidence: "heading Dashboard", status: "pass" }),
          call("finish", { status: "passed", summary: "Done." }),
        ],
        (_tree, call) => [
          call("report_step", { num: 1, expected: "it opens", evidence: "heading Dashboard", status: "pass", not_checked: ["Kenya", "Uganda"] }),
          call("finish", { status: "passed", summary: "Done." }),
        ],
      ],
      "Long\n1. Open the page.",
      { QPILOT_VISION: "0" },
    );
    assert.deepEqual([run.steps[0].status, run.steps[0].evidence], ["warn", "heading Dashboard Not checked: Kenya, Uganda."], "a pass that left items unchecked is recorded as a warn that names them");
    assert.ok(run.steps[0].screenshot, "…with a screenshot, like any warn");
    assert.match(toolResults(model.requests.at(-1)).find((c) => c.includes("Report that step first")) ?? "", /^Error: not executed\. A verdict in this turn was not recorded/, "a finish right after a refused verdict is not run");
    const results = toolResults(model.requests.at(-1));
    const first = results.find((c) => c.startsWith("OK: navigated"));
    assert.match(first, /After this action: \d+ request\(s\) sent/, "an old result still says what the action led to");
    assert.match(first, /page tree that came with this is no longer kept/);
    assert.doesNotMatch(first, /Page snapshot/, "…without the page tree it carried");
    assert.match(results.findLast((c) => c.startsWith("OK: navigated")), /Page snapshot/, "the latest result has its tree");
    console.log("✓ a long history keeps the outcomes of old actions and drops only their page trees");
  }

  // ── 11. a sign-in made on one run is there on the next ───────────────────────
  {
    const home = mkdtempSync(join(tmpdir(), "qpilot-e2e-"));
    const file = join(home, "session.json");
    const logins = () => site.seen.filter((s) => s === "login").length;
    const plan = (_tree, call) => [call("set_plan", { groups: [{ steps: ["Open the account — Welcome is shown"] }] })];
    const open = (_tree, call) => [call("navigate", { url: site.url + "account" })];
    const done = (_tree, call) => [
      call("report_step", { num: 1, expected: "Welcome is shown", evidence: "heading Welcome, tester", status: "pass" }),
      call("finish", { status: "passed", summary: "Done." }),
    ];
    const text = "Account\n1. Open the account.";
    try {
      // the first run has to sign in
      const first = await runWith(
        [plan, open, (tree, call) => [
          call("fill", { ref: ref(tree, /textbox "Code"/), value: "1234", name: "Code" }),
          call("click", { ref: ref(tree, /button "Sign in"/), name: "Sign in" }),
        ], done],
        text, { QPILOT_VISION: "0" }, undefined, { home },
      );
      assert.equal(logins(), 1, "the first run signed in");
      assert.doesNotMatch(first.model.requests[0].messages[1].content, /Sign-ins saved/, "nothing is said about saved sign-ins when there are none");
      assert.match(toolResults(first.model.requests.at(-1)).at(-1), /token from an earlier visit: no/);
      assert.ok(existsSync(file), "the sign-in is written down when the run ends");
      assert.equal(statSync(file).mode & 0o777, 0o600, "…in a file only its owner can read");
      assert.ok(JSON.parse(readFileSync(file, "utf-8")).cookies.some((c) => c.name === "sid"), "…the session cookie among it, though it has no expiry date");

      // the second run starts where the first one ended
      const second = await runWith([plan, open, done], text, { QPILOT_VISION: "0" }, undefined, {
        home,
        probe: (base) => fetch(`${base}/api/sessions`).then((r) => r.json()),
      });
      const opened = toolResults(second.model.requests.at(-1)).find((c) => c.startsWith("OK: navigated"));
      assert.match(opened, /heading "Welcome, tester"/, "the account opens without a sign-in");
      assert.match(opened, /token from an earlier visit: yes/, "site storage is back too, not only cookies");
      assert.equal(logins(), 1, "nobody signed in a second time");
      assert.match(second.model.requests[0].messages[1].content, /Sign-ins saved from earlier runs are loaded/, "the model is told it may already be signed in");
      assert.ok(second.events.some((e) => e.info?.type === "session"), "the log says the run started with saved sign-ins");
      assert.deepEqual(second.probed, { enabled: true, path: file, sites: ["127.0.0.1"] }, "Settings is given the site names and nothing else");

      // a test case about signing in starts from a signed-out browser
      const third = await runWith(
        [plan, open, (_tree, call) => [call("clear_session")], done],
        text, { QPILOT_VISION: "0" }, undefined,
        { home, probe: (base) => fetch(`${base}/api/sessions`, { method: "DELETE" }).then((r) => r.json()) },
      );
      assert.match(toolResults(third.model.requests.at(-1)).find((c) => c.startsWith("OK: signed out")) ?? "", /heading "Sign in"/, "clear_session signs out: the sign-in form is back");
      assert.equal(third.probed.sites.length, 0, "Forget in Settings removes what is saved");
      assert.ok(!existsSync(file), "…the file with it");

      // QPILOT_SESSIONS=0: nothing is kept
      await runWith(
        [plan, open, (tree, call) => [
          call("fill", { ref: ref(tree, /textbox "Code"/), value: "1234", name: "Code" }),
          call("click", { ref: ref(tree, /button "Sign in"/), name: "Sign in" }),
        ], done],
        text, { QPILOT_VISION: "0", QPILOT_SESSIONS: "0" }, undefined, { home },
      );
      assert.ok(!existsSync(file), "with QPILOT_SESSIONS=0 a run leaves nothing behind");

      // a run that never ends — it asks something and the server is killed — has kept its sign-in all the same
      const signIn = (tree, call) => [
        call("fill", { ref: ref(tree, /textbox "Code"/), value: "1234", name: "Code" }),
        call("click", { ref: ref(tree, /button "Sign in"/), name: "Sign in" }),
      ];
      const before = logins();
      const cut = await runWith(
        [plan, open, signIn, (_tree, call) => [call("ask_user", { prompt: "What next?" })]],
        text, { QPILOT_VISION: "0" }, undefined, { home, abandon: true },
      );
      assert.equal(cut.run.status, "waiting", "the run was left waiting for an answer and killed");
      assert.ok(JSON.parse(readFileSync(file, "utf-8")).cookies.some((c) => c.name === "sid"), "the sign-in was written down the moment it was made, not at the end of the run");
      const after = await runWith([plan, open, done], text, { QPILOT_VISION: "0" }, undefined, { home });
      assert.match(toolResults(after.model.requests.at(-1)).find((c) => c.startsWith("OK: navigated")), /heading "Welcome, tester"/, "…and the next run is signed in");
      assert.equal(logins(), before + 1, "one sign-in for the two runs");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    console.log("✓ a sign-in is kept between runs — even from a run that never finished — cleared on request, and never kept when turned off");
  }

  // ── 12. a code typed one character per box is not readable in the log ────────
  {
    const digits = (label, code) => (tree, call) =>
      [...code].map((d, i) => call("fill", { ref: ref(tree, new RegExp(`textbox "${label} ${i + 1}"`)), value: d, name: `${label} ${i + 1}` }));
    const { run, events, model } = await runWith(
      [
        (_tree, call) => [call("set_plan", { groups: [{ steps: ["Type both codes — they are accepted"] }] })],
        (_tree, call) => [call("navigate", { url: site.url + "otp" })],
        digits("Digit", "7391"),
        (_tree, call) => [call("ask_user", { prompt: "Enter the backup code", secret: true })],
        digits("Part", "4826"),
        (_tree, call) => [
          call("report_step", { num: 1, expected: "they are accepted", evidence: "typed 7391 and then 4826", status: "pass" }),
          call("finish", { status: "passed", summary: "Done." }),
        ],
      ],
      "Code\n1. Type both codes.",
      { QPILOT_VISION: "0" }, undefined, { answer: "4826" },
    );
    const fills = events.filter((e) => e.kind === "action" && e.toolName === "fill");
    assert.equal(fills.length, 8);
    assert.deepEqual([...new Set(fills.map((e) => e.toolInput.value))], ["••••••"], "every character of a code is masked in the log: in boxes shaped like a code, and when it spells a secret the user gave");
    const said = events.filter((e) => e.kind === "observation").map((e) => e.text).join("\n");
    assert.doesNotMatch(said, /filled "\d"/, "…in what the tools reported as well");
    assert.equal(run.steps[0].evidence, "typed •••••• and then ••••••", "the whole codes are masked where the agent quotes them");
    assert.match(toolResults(model.requests.at(-1)).join("\n"), /OK: filled "7" into Digit 1/, "the model itself is told what it typed");
    console.log("✓ a code typed one character per box is masked in the log");
  }
} catch (err) {
  failed = true;
  console.error(`✗ e2e failed: ${err.message}`);
  if (err.actual !== undefined) console.error("  actual:  ", JSON.stringify(err.actual)?.slice(0, 600), "\n  expected:", JSON.stringify(err.expected)?.slice(0, 600));
} finally {
  site.close();
}
process.exit(failed ? 1 : 0);
