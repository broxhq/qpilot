// The agent loop: ask the model, run the tools it calls, repeat until finish.

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { cleanupUploads } from "../attachments";
import { dict } from "../i18n";
import { addStats, checkPause, getFiles, getRun, isStopped, onStop, pushEvent, saveScreenshot } from "../store";
import { NetworkMonitor } from "../network";
import { loadSession, saveSession } from "../sessions";
import { snapshot } from "./snapshot";
import { MODEL_TIMEOUT_MS, resolveProvider } from "../provider";
import { type ToolContext } from "./context";
import { PAGE_ACTIONS, executeTool } from "./handlers";
import { callModel, compactHistory, dropScreenshots, withState } from "./model";
import { captureEvidence, wirePage, withNotices } from "./page";
import { watchFlashes } from "./flash";
import { NUDGE } from "./prompt";
import { SECRET_MASK, isSecretField, redact, redactDeep, spells, stripRefs } from "./redact";
import { Reviewer } from "./reviewer";
import { canSee, forgetVision } from "./vision";
import { spawnWakeLock } from "./wakelock";

// A run is limited by progress, not by its length: a case of 50 steps is as
// legitimate as one of 5. What is limited is the work on ONE step — see
// STEP_ACTION_LIMIT — and how many steps in a row may end that way.
//
// The cap on model calls is only a backstop (each iteration is a paid call): it
// grows with the plan and is not meant to be reached. Loops are caught earlier
// by the repetition guard: if the last STUCK_WINDOW actions since the last
// progress have <= STUCK_DISTINCT unique signatures, the agent is repeating
// itself (e.g. a blocked action it can't resolve). A legit complex step does
// many DIFFERENT actions, so it isn't flagged.
const BASE_ITERATIONS = 200;

const STUCK_WINDOW = 24;

const STUCK_DISTINCT = 4;

// Actions on a single step before the agent is asked to take stock.
const STEP_ACTION_BUDGET = 15;

// Looking does not spend the step's allowance: reading the request journal, the
// console or the page again is how a tester works out why something did not
// happen, and it used to cost the same as a click.
const FREE = new Set(["set_plan", "report_step", "finish", "note", "ask_user", "get_requests", "get_console", "snapshot", "find", "look", "measure"]);

// Actions that are not run a third time when the same one has twice sent
// nothing and changed nothing.
const NO_EFFECT_GUARDED = new Set(["click", "click_at", "press", "fill", "select", "hover", "hover_at"]);
const NO_EFFECT_TRIES = 2;

// How much of the step's own history the model is shown every turn.
const LEDGER_LINES = 20;

// Actions on a single step before the framework closes it as fail and moves the
// agent on: one lost step instead of a run that never gets to the rest.
const STEP_ACTION_LIMIT = 40;

// That many steps closed by the framework in a row: the agent has lost its way
// or the page under test is unusable — going on would only spend model calls.
const MAX_CUT_OFF_IN_A_ROW = 3;

const MAX_EMPTY_TURNS = 3;

/**
 * Closes the step the agent is on, on the framework's behalf, and moves on to
 * the next queued one. The step is recorded as a warn, not a fail: the agent
 * did not get to a verdict, which says nothing about the product — a red step
 * would send the tester to file a bug that may not exist. The run still ends as
 * failed (see `cutOff` in the store). Returns what to tell the model, or null
 * when there is no such step in the plan to close.
 */
async function cutOffStep(ctx: ToolContext, spent: number): Promise<string | null> {
  const { runId } = ctx;
  const run = getRun(runId);
  const plan = run?.steps ?? [];
  const num = ctx.step.current;
  const planned = plan.find((s) => s.num === num && s.status === "queued");
  if (!planned) return null;

  let screenshot: string | undefined;
  const shot = await captureEvidence(ctx.page);
  if (shot) {
    saveScreenshot(runId, num, shot);
    screenshot = `/api/run/${runId}/shot/${num}`;
  }
  const consoleErrors = ctx.net.takeConsoleErrors().slice(0, 5).map((e) => redact(ctx, e));
  // the requests seen on this step are not evidence for the next one
  ctx.net.proof([], "");
  ctx.flashSeen = [];
  ctx.seenTexts = [];
  const step = {
    num,
    description: planned.description,
    status: "warn" as const,
    cutOff: true,
    evidence: dict(run?.language).stepCutOff.replace("{n}", String(spent)),
    screenshot,
    consoleErrors: consoleErrors.length ? consoleErrors : undefined,
  };
  pushEvent(runId, { ts: Date.now(), kind: "step", step, stepNum: num });
  // nothing to review, but the records of this step must not leak into the next one
  ctx.reviewer.review(ctx, step, undefined);

  const upcoming = plan.find((s) => s.num !== num && s.status === "queued");
  ctx.step.current = upcoming?.num ?? num + 1;
  return (
    `Step ${num} was closed by the framework as not verified (warn): ${spent} actions without a verdict. Do not report it and do not go back to it. ` +
    (upcoming ? `Go on with step ${upcoming.num}: "${upcoming.description}".` : "All steps are reported — call finish.")
  );
}

/** The same action on the same element with the same value. */
function exactSig(name: string, input: Record<string, unknown>): string {
  const target = input.ref ?? (input.x !== undefined ? `${input.x},${input.y}` : input.text ?? "");
  return `${name}:${target}:${input.value ?? input.key ?? ""}:${input.dx ?? ""},${input.dy ?? ""}`;
}

/** One line for the step ledger when the tool did not write its own. */
function ledgerLine(name: string, input: Record<string, unknown>, result: string): string {
  const what = input.name ?? input.text ?? input.find ?? input.near ?? input.url ?? input.ref ?? "";
  const first = result.split("\n").find((l) => l.trim() && !l.startsWith("NOTE:")) ?? "";
  return `${name}${what ? ` "${String(what).slice(0, 50)}"` : ""} → ${first.slice(0, 140)}`;
}

// Signature of a tool call for loop detection: tool + its semantic target +
// value. Different fields/values/labels => different signatures, so a varied
// (legit) step looks diverse; a repeated action collapses to one signature.
function actionSig(name: string, input: Record<string, unknown>): string {
  const target =
    input.name ?? input.near ?? input.text ?? input.ref ?? input.url ?? "";
  const value = input.value ?? input.key ?? "";
  return `${name}:${target}:${value}`;
}

export async function runAgent(
  runId: string,
  testCase: string,
  headless = true,
  /** The port the app is served on, so that the agent is not let into its own pages. */
  ownPort = "",
): Promise<void> {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  // the sites this run talked to: only their sign-ins are rewritten when it ends
  const touched = new Set<string>();
  // What the browser ends with is what the next run starts with — a sign-in made
  // on this run, or a sign-out. Done once, before the run is shown as finished.
  let persisted = false;
  const write = async () => {
    await context
      ?.storageState({ indexedDB: true })
      .then((state) => saveSession(state, touched))
      .catch(() => {});
  };
  const persist = async () => {
    if (persisted || !context) return;
    persisted = true;
    await write();
  };
  // A sign-in is kept as soon as it is made, not when the run ends: a run can be
  // stopped, hang on a question nobody answers, or die with the server, and the
  // code from the phone would have to be typed again. After every page action
  // the cookies and the address are compared with what was last written; only a
  // change is written down.
  let kept = "";
  const fingerprint = async (url: string) => {
    const cookies = await context?.cookies().catch(() => null);
    if (!cookies) return null;
    const hash = createHash("sha1");
    for (const line of cookies.map((c) => `${c.domain}\t${c.path}\t${c.name}\t${c.value}`).sort()) hash.update(line);
    return `${url}\n${hash.digest("hex")}`;
  };
  const checkpoint = async (url: string) => {
    if (persisted) return;
    const now = await fingerprint(url);
    if (now === null || now === kept) return;
    kept = now;
    await write();
  };

  const wakeLock = spawnWakeLock();
  // Stop: the model call in flight is dropped and the browser closed at once —
  // whatever the agent is in the middle of fails, and the loop sees why.
  const halted = new AbortController();
  onStop(runId, () => {
    halted.abort();
    void persist().finally(() => browser?.close().catch(() => {}));
  });
  const stopped = () => isStopped(runId);

  const cfg = resolveProvider();
  const client =
    cfg.kind === "anthropic"
      ? new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: MODEL_TIMEOUT_MS })
      : null;

  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless,
    });
    // sign-ins of earlier runs: without them every run starts at a login form
    const session = loadSession();
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      // Dev/staging/corp environments routinely use self-signed or internal-CA
      // certs; skip the browser's SSL warning page so navigate just works.
      ignoreHTTPSErrors: true,
      ...(session ? { storageState: session } : {}),
    });
    context.on("request", (req) => {
      try {
        const host = new URL(req.url()).hostname.toLowerCase();
        if (host) touched.add(host);
      } catch {}
    });
    // what was loaded is already on disk: not a change to write down
    kept = (await fingerprint("about:blank")) ?? "";
    if (session && (session.cookies.length || session.origins.length)) {
      pushEvent(runId, { ts: Date.now(), kind: "info", info: { type: "session" } });
    }
    const page = await context.newPage();
    const browserContext = context;

    const files = getFiles(runId);
    const ctx: ToolContext = {
      runId,
      page,
      context: browserContext,
      net: new NetworkMonitor(browserContext),
      reviewer: new Reviewer(cfg, client, testCase),
      step: { current: 1 },
      files,
      vision: await canSee(cfg, client, browser),
      incoming: null,
      lastTree: null,
      lastFull: null,
      wantTree: true,
      tool: "",
      actionStarted: Date.now(),
      dialogPolicy: null,
      ownPort,
      planQueried: false,
      checksQueried: null,
      flashSeen: [],
      seenTexts: [],
      notices: [],
      flashShot: null,
      persist,
      secrets: new Set(),
    };
    await watchFlashes(ctx);
    wirePage(ctx, page);
    const thisRun = getRun(runId);
    if (thisRun) thisRun.vision = ctx.vision;
    // tabs the page opens itself (target=_blank, window.open): the agent is moved
    // to the newest one when the action that opened it returns — see adoptNewTab
    browserContext.on("page", (opened) => {
      wirePage(ctx, opened);
      ctx.incoming = opened;
    });

    // the model is told the language outright: a rule in the system prompt alone
    // is not enough for some models, which drift to their default language
    const languageNote =
      getRun(runId)?.language === "ru"
        ? "The test case is written in Russian — write every step description, expected, evidence and the summary in Russian."
        : "Write every step description, expected, evidence and the summary in the language the test case above is written in — do not translate them into another language.";

    const attachmentNote = files.length
      ? "\n\nFiles attached to this run — you can ONLY upload them (upload_file, exact name); their contents are not available to you:\n" +
        files.map((f) => `- ${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)`).join("\n")
      : "";

    // said only when it is so: a model told about a saved sign-in that is not
    // there would skip a login it has to do
    const sessionNote = session
      ? "\n\nSign-ins saved from earlier runs are loaded into the browser, so a site may open already signed in. If it does, the login precondition is done: do not ask for a login or a code unless the page shows a sign-in form. If the test case itself checks signing in, call clear_session before you start."
      : "";

    // A test case copied from a test-management system often has no address in
    // it. Left to itself the agent guessed "localhost" and ended up reading this
    // app's own Settings page; the person who started the run knows the address.
    const addressNote = /https?:\/\/|www\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i.test(testCase)
      ? ""
      : "\n\nThe test case gives no address of the site under test. Ask the user for it with ask_user before you navigate anywhere — do not guess one.";

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content:
          "Test case(s):\n\n```\n" +
          testCase +
          "\n```" +
          attachmentNote +
          sessionNote +
          addressNote +
          "\n\n" +
          languageNote,
      },
    ];

    let emptyTurns = 0;
    // Loop detector: action signatures since the last progress milestone
    // (completed step / navigate / user answer). Repetition with low diversity
    // means the agent is stuck.
    let lastStep = ctx.step.current;
    let sigsSinceProgress: string[] = [];
    let budgetStep = ctx.step.current;
    let actionsOnStep = 0;
    let cutOffInARow = 0;
    // a code typed a character per field: what the last fills add up to
    let spelled = "";
    let cells = "";
    // what was done on the current step and what came of it, for the state note
    let ledger: string[] = [];
    let ledgerStep = ctx.step.current;
    // the last guarded action that had no effect, and how many times in a row
    const idle: { last: { sig: string; times: number } | null } = { last: null };
    // a step the model has been told to report now, and the turn it was told in
    let mustReport: { step: number; iter: number } | null = null;

    const stateNote = () => {
      const steps = getRun(runId)?.steps ?? [];
      const current = steps.find((s) => s.num === ctx.step.current && s.status === "queued");
      if (!current) return "";
      const shown = ledger.slice(-LEDGER_LINES);
      const earlier = ledger.length - shown.length;
      return [
        "[STATE — kept by the framework, always current]",
        `Step ${current.num} of ${steps.length}: "${current.description}"`,
        ledger.length
          ? `Done on this step so far (${actionsOnStep} of ${STEP_ACTION_LIMIT} actions used):\n` +
            (earlier > 0 ? `  … ${earlier} earlier\n` : "") +
            shown.map((l, i) => `  ${earlier + i + 1}. ${l}`).join("\n")
          : "Nothing done on this step yet.",
      ].join("\n");
    };
    const asksForVerdict = (step: number, why: string) =>
      `${why} Call report_step for step ${step} now and say what you did, what you observed and what stopped you: warn if the outcome is unclear, fail if the expected result is not there. Other calls will not be run, and if the step is not reported in your next turn the framework closes it as fail.`;
    // the plan arrives with the first turn, so the cap is read anew every iteration
    const iterationLimit = () =>
      Math.max(BASE_ITERATIONS, (getRun(runId)?.steps.length ?? 0) * STEP_ACTION_LIMIT);

    for (let iter = 0; iter < iterationLimit(); iter++) {
      await checkPause(runId);
      if (stopped()) break;
      if (ledgerStep !== ctx.step.current) {
        ledgerStep = ctx.step.current;
        ledger = [];
        idle.last = null;
      }
      const trimmed = withState(compactHistory(messages), stateNote());
      const callStarted = Date.now();
      let response: Anthropic.Message;
      try {
        response = await callModel(cfg, client, trimmed, ctx.vision, halted.signal);
      } catch (err) {
        if (stopped()) break;
        // The endpoint took the vision check but refuses a real screenshot: go on
        // by the page tree instead of failing the run.
        const status = (err as { status?: number }).status ?? 0;
        const refused = status >= 400 && status < 500 && ![401, 403, 429].includes(status);
        const withoutShots = dropScreenshots(
          messages,
          "[the screenshot could not be shown: this model does not accept images — go on by the page tree]",
        );
        if (!ctx.vision || !refused || withoutShots === messages) throw err;
        messages.splice(0, messages.length, ...withoutShots);
        ctx.vision = false;
        if (thisRun) thisRun.vision = false;
        forgetVision(cfg);
        continue;
      }
      addStats(runId, {
        calls: 1,
        modelMs: Date.now() - callStarted,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      });

      const textContent = response.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("");

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (textContent.trim()) {
        pushEvent(runId, {
          ts: Date.now(),
          kind: "thought",
          text: redact(ctx, stripRefs(textContent)),
          stepNum: ctx.step.current,
        });
      }

      messages.push({
        role: "assistant",
        content: response.content as Anthropic.MessageParam["content"],
      });

      if (toolUseBlocks.length === 0) {
        pushEvent(runId, {
          ts: Date.now(),
          kind: "observation",
          text:
            `[debug] no tool_calls · stop_reason=${response.stop_reason}` +
            ` · content=${JSON.stringify(textContent.slice(0, 200))}`,
        });

        emptyTurns++;
        if (emptyTurns >= MAX_EMPTY_TURNS) {
          await ctx.reviewer.settle();
          pushEvent(runId, {
            ts: Date.now(),
            kind: "done",
            status: "failed",
            summary:
              "Agent stopped calling tools. Last response: " +
              (textContent.slice(0, 300) || "(empty)"),
          });
          break;
        }
        messages.push({ role: "user", content: NUDGE });
        continue;
      }
      emptyTurns = 0;

      let finished = false;
      // milestones that count as progress besides report_step: a successful
      // navigate or a user answer. The long login/precondition phase (cert,
      // OTP, redirects) makes real headway without closing a step yet.
      let progressedThisTurn = false;
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      // Only the last page action of the turn reads the page back (see actionResult).
      const lastPageAction = toolUseBlocks.map((t) => PAGE_ACTIONS.has(t.name)).lastIndexOf(true);
      let actedThisTurn = false;
      // a verdict of this turn was turned down: a finish that follows it in the
      // same turn would close the run with that step unreported
      let verdictRefused = false;
      // set when the framework closed the step during this turn: what is left of
      // the turn was meant for that step and is not run
      let cutOff = "";

      for (const [index, b] of toolUseBlocks.entries()) {
        if (stopped()) break;
        const name = b.name;
        const input = (b.input ?? {}) as Record<string, unknown>;
        ctx.wantTree = index === lastPageAction;
        ctx.tool = name;
        ctx.actionStarted = Date.now();

        if (cutOff) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: b.id,
            content: `Error: not executed. ${cutOff}`,
            is_error: true,
          });
          continue;
        }

        // A verdict given in the same turn as the action it judges is a guess:
        // the model has not seen the result yet.
        if (name === "finish" && verdictRefused) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: b.id,
            content: "Error: not executed. A verdict in this turn was not recorded (see above). Report that step first, then call finish.",
            is_error: true,
          });
          continue;
        }
        if (name === "report_step" && actedThisTurn) {
          verdictRefused = true;
          toolResults.push({
            type: "tool_result",
            tool_use_id: b.id,
            content:
              "Error: not recorded. This turn also performed page actions whose result you have not seen yet. Read the page tree returned by the last action, then call report_step.",
            is_error: true,
          });
          continue;
        }
        // A step that eats dozens of actions means the agent has wandered off
        // (extra checks, undoing its own clicks). First pull it back to the
        // report; past the limit, close the step for it and move on.
        if (ctx.step.current !== budgetStep) {
          budgetStep = ctx.step.current;
          actionsOnStep = 0;
        }
        const countsAsAction = !FREE.has(name);
        // The step has to be reported now: the model was told so (the allowance
        // is used up, or it was going in circles). It gets one turn to give its
        // own verdict — it knows what it saw; a step closed for it says nothing.
        if (mustReport && mustReport.step !== ctx.step.current) mustReport = null;
        if (name !== "report_step" && (mustReport || (countsAsAction && actionsOnStep >= STEP_ACTION_LIMIT))) {
          if (!mustReport) mustReport = { step: ctx.step.current, iter };
          if (mustReport.iter === iter) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: b.id,
              content: `Error: not executed. ${asksForVerdict(mustReport.step, `You have used ${actionsOnStep} actions on step ${mustReport.step}.`)}`,
              is_error: true,
            });
            continue;
          }
          const closed = await cutOffStep(ctx, actionsOnStep);
          mustReport = null;
          if (closed) {
            cutOff = closed;
            cutOffInARow++;
            toolResults.push({
              type: "tool_result",
              tool_use_id: b.id,
              content: `Error: not executed. ${cutOff}`,
              is_error: true,
            });
            continue;
          }
        }

        // The same action has twice sent nothing and changed nothing: a third
        // press will not either. Say so instead of pressing, and ask for a cause.
        const exact = exactSig(name, input);
        if (NO_EFFECT_GUARDED.has(name) && idle.last?.sig === exact && idle.last.times >= NO_EFFECT_TRIES) {
          actionsOnStep++;
          ledger.push(`${name} ${JSON.stringify(input.name ?? input.ref ?? "")} → not run: the same action had no effect ${idle.last.times} times`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: b.id,
            content:
              `Error: not executed. This exact action has been done ${idle.last.times} times in a row and each time no request was sent and the page did not change — doing it again will not help. ` +
              "Work out what is holding it back before you act: a prerequisite that is missing (a required field left empty, a box not ticked, a dialog still open), the wrong control, or a defect of the product. " +
              "Write the cause in a sentence or two, then do something different: fill what is missing, use another control, read get_requests or get_console, or report the step.",
            is_error: true,
          });
          continue;
        }

        if (PAGE_ACTIONS.has(name)) {
          actedThisTurn = true;
          const what = input.name ?? input.url ?? input.text ?? input.key ?? "";
          ctx.net.mark(`${name}${what ? ` "${String(what).slice(0, 60)}"` : ""}`);
        }

        sigsSinceProgress.push(actionSig(name, input));

        if (countsAsAction) {
          actionsOnStep++;
          if (actionsOnStep === STEP_ACTION_BUDGET || (actionsOnStep > STEP_ACTION_BUDGET && actionsOnStep % 10 === 0)) {
            ctx.notices.push(
              `${actionsOnStep} of ${STEP_ACTION_LIMIT} actions are used on step ${ctx.step.current}. Take stock from the list of what you have done: if each action moved the step forward, go on; if you are repeating yourself, name what is in the way and either remove it or report the step with what you observed.`,
            );
          }
        }

        // What is typed into a password field must not show up in the log — and
        // neither must a code typed one character per field: each character is
        // too short to mask everywhere, so this very call is masked instead.
        let piece = "";
        if (name === "fill" && typeof input.value === "string" && input.value) {
          const value = input.value;
          const field = await isSecretField(ctx.page, input);
          if (field === "secret") ctx.secrets.add(value);
          spelled = field ? "" : spells(ctx.secrets, spelled, value);
          if (field === "cell" || spelled) piece = value;
          // the boxes of a code add up to a secret of their own: later mentions of the whole code are masked
          cells = field === "cell" ? cells + value : "";
          if (cells.length >= 4) ctx.secrets.add(cells);
        } else if (PAGE_ACTIONS.has(name)) {
          spelled = "";
          cells = "";
        }
        // the value as this call's own texts quote it
        const veil = (text: string) => (piece ? text.split(`"${piece}"`).join(`"${SECRET_MASK}"`) : text);

        // set_plan is a run-level event, not tied to any specific step
        const stepNum = name === "set_plan" ? undefined : ctx.step.current;
        pushEvent(runId, {
          ts: Date.now(),
          kind: "action",
          toolName: name,
          toolInput: redactDeep(ctx, piece ? { ...input, value: SECRET_MASK } : input),
          stepNum,
        });

        // time waiting for a human answer is not the browser's
        const toolStarted = name === "ask_user" ? 0 : Date.now();
        try {
          const ret = await executeTool(name, input, ctx);
          if (toolStarted) addStats(runId, { browserMs: Date.now() - toolStarted });
          const text = withNotices(ctx, ret.content);
          ctx.reviewer.record(name, input, text);
          if (!FREE.has(name) || name === "get_requests" || name === "get_console") {
            ledger.push(ret.brief ?? ledgerLine(name, input, ret.content));
          }
          if (NO_EFFECT_GUARDED.has(name) && ret.effect === false) {
            idle.last = { sig: exact, times: idle.last?.sig === exact ? idle.last.times + 1 : 1 };
          } else if (ret.effect === true || (PAGE_ACTIONS.has(name) && exact !== idle.last?.sig)) {
            // something did happen, or something else was done (a field filled
            // in the middle of a turn, whose effect is not read): a new situation
            idle.last = null;
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: b.id,
            content: ret.image
              ? [
                  { type: "text", text },
                  { type: "image", source: { type: "base64", media_type: "image/jpeg", data: ret.image.toString("base64") } },
                ]
              : text,
          });
          pushEvent(runId, {
            ts: Date.now(),
            kind: "observation",
            text: redact(ctx, veil(ret.observation ?? ret.content)),
            stepNum,
          });
          if (PAGE_ACTIONS.has(name)) await checkpoint(ctx.page.url());
          if (ret.finished) finished = true;
          if (name === "report_step" && ret.content.startsWith("Error")) verdictRefused = true;
          if (name === "navigate" || name === "ask_user") progressedThisTurn = true;
          // a verdict of the agent's own ends a series of steps closed for it
          if (name === "report_step" && ret.content.startsWith("OK:")) cutOffInARow = 0;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.reviewer.record(name, input, `Error: ${message}`);
          ledger.push(ledgerLine(name, input, `Error: ${message}`));
          // after a failed action the model needs to see the page: give it the
          // tree now instead of making it spend a turn on snapshot
          const tree =
            index === lastPageAction ? await snapshot(ctx.page).catch(() => "") : "";
          toolResults.push({
            type: "tool_result",
            tool_use_id: b.id,
            content: withNotices(ctx, tree ? `Error: ${message}\n\n${tree}` : `Error: ${message}`),
            is_error: true,
          });
          pushEvent(runId, {
            ts: Date.now(),
            kind: "observation",
            text: redact(ctx, veil(`Error: ${message}`)),
            stepNum,
          });
        }
      }

      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      }

      if (finished || stopped()) break;

      if (cutOffInARow >= MAX_CUT_OFF_IN_A_ROW) {
        await ctx.reviewer.settle();
        pushEvent(runId, {
          ts: Date.now(),
          kind: "done",
          status: "failed",
          summary: `Stopped: ${cutOffInARow} steps in a row were not completed within ${STEP_ACTION_LIMIT} actions each — the agent has lost its way or the page under test is not usable.`,
        });
        break;
      }

      // Repetition guard: progress (a completed step / navigate / user answer)
      // clears the buffer. Otherwise, if many actions pile up with very few
      // unique signatures, the agent is going in circles. That costs it the
      // step, not the run: it is told to report the step and sent on.
      const circling =
        sigsSinceProgress.length >= STUCK_WINDOW && new Set(sigsSinceProgress).size <= STUCK_DISTINCT;
      const open = (getRun(runId)?.steps ?? []).some((s) => s.num === ctx.step.current && s.status === "queued");
      if (ctx.step.current !== lastStep || progressedThisTurn) {
        lastStep = ctx.step.current;
        sigsSinceProgress = [];
      } else if (circling && open && !mustReport) {
        sigsSinceProgress = [];
        mustReport = { step: ctx.step.current, iter };
        const last = messages[messages.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) {
          last.content.push({
            type: "text",
            text: asksForVerdict(ctx.step.current, `The last ${STUCK_WINDOW} calls on step ${ctx.step.current} were the same few, over and over, without getting anywhere.`),
          });
        }
      } else if (circling && !open) {
        await ctx.reviewer.settle();
        pushEvent(runId, {
          ts: Date.now(),
          kind: "done",
          status: "failed",
          summary: `Stuck: repeating the same few actions without progress — the agent is likely looping on a blocked action it can't resolve.`,
        });
        break;
      }
    }

    // second opinions belong to a run that is still being judged
    if (!stopped()) await ctx.reviewer.settle();
    // Loop exited by exhausting iterations (not via finish) — close the run
    // explicitly, else status stays running and logs hang in pending though the
    // browser is gone.
    const run = getRun(runId);
    if (run && (run.status === "running" || run.status === "waiting" || run.status === "paused")) {
      pushEvent(runId, {
        ts: Date.now(),
        kind: "done",
        status: "failed",
        summary: `Reached the limit of ${iterationLimit()} model calls before calling finish — the run is incomplete.`,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushEvent(runId, { ts: Date.now(), kind: "error", text: message });
  } finally {
    // a run that did not end through finish (stopped, crashed) keeps its sign-ins too
    await persist();
    await browser?.close().catch(() => {});
    wakeLock?.kill();
    // uploaded files only exist for the duration of the run
    await cleanupUploads(runId);
  }
}
