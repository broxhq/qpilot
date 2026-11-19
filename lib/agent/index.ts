// The agent loop: ask the model, run the tools it calls, repeat until finish.

import Anthropic from "@anthropic-ai/sdk";
import { chromium, type Browser } from "playwright";
import { cleanupUploads } from "../attachments";
import { dict } from "../i18n";
import { addStats, checkPause, getFiles, getRun, pushEvent, saveScreenshot } from "../store";
import { NetworkMonitor } from "../network";
import { snapshot } from "./snapshot";
import { MODEL_TIMEOUT_MS, resolveProvider } from "../provider";
import { type ToolContext } from "./context";
import { PAGE_ACTIONS, executeTool } from "./handlers";
import { callModel, compactHistory, dropScreenshots } from "./model";
import { captureEvidence, wirePage, withNotices } from "./page";
import { NUDGE } from "./prompt";
import { isSecretField, redact, redactDeep, stripRefs } from "./redact";
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

// Actions on a single step before the agent is told to wrap it up.
const STEP_ACTION_BUDGET = 15;

// Actions on a single step before the framework closes it as fail and moves the
// agent on: one lost step instead of a run that never gets to the rest.
const STEP_ACTION_LIMIT = 40;

// That many steps closed by the framework in a row: the agent has lost its way
// or the page under test is unusable — going on would only spend model calls.
const MAX_CUT_OFF_IN_A_ROW = 3;

const MAX_EMPTY_TURNS = 3;

/**
 * Closes the step the agent is on as fail, on the framework's behalf, and moves
 * on to the next queued one. Returns what to tell the model, or null when there
 * is no such step in the plan to close.
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
  const step = {
    num,
    description: planned.description,
    status: "fail" as const,
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
    `Step ${num} was closed by the framework as fail: ${spent} actions without a verdict. Do not report it and do not go back to it. ` +
    (upcoming ? `Go on with step ${upcoming.num}: "${upcoming.description}".` : "All steps are reported — call finish.")
  );
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
): Promise<void> {
  let browser: Browser | null = null;

  const wakeLock = spawnWakeLock();

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
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      // Dev/staging/corp environments routinely use self-signed or internal-CA
      // certs; skip the browser's SSL warning page so navigate just works.
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    const files = getFiles(runId);
    const ctx: ToolContext = {
      runId,
      page,
      context,
      net: new NetworkMonitor(context),
      reviewer: new Reviewer(cfg, client, testCase),
      step: { current: 1 },
      files,
      vision: await canSee(cfg, client, browser),
      incoming: null,
      lastTree: null,
      lastFull: null,
      wantTree: true,
      actionStarted: Date.now(),
      dialogPolicy: null,
      notices: [],
      secrets: new Set(),
    };
    wirePage(ctx, page);
    const thisRun = getRun(runId);
    if (thisRun) thisRun.vision = ctx.vision;
    // tabs the page opens itself (target=_blank, window.open): the agent is moved
    // to the newest one when the action that opened it returns — see adoptNewTab
    context.on("page", (opened) => {
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

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content:
          "Test case(s):\n\n```\n" +
          testCase +
          "\n```" +
          attachmentNote +
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
    // the plan arrives with the first turn, so the cap is read anew every iteration
    const iterationLimit = () =>
      Math.max(BASE_ITERATIONS, (getRun(runId)?.steps.length ?? 0) * STEP_ACTION_LIMIT);

    for (let iter = 0; iter < iterationLimit(); iter++) {
      await checkPause(runId);
      const trimmed = compactHistory(messages);
      const callStarted = Date.now();
      let response: Anthropic.Message;
      try {
        response = await callModel(cfg, client, trimmed, ctx.vision);
      } catch (err) {
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
      // set when the framework closed the step during this turn: what is left of
      // the turn was meant for that step and is not run
      let cutOff = "";

      for (const [index, b] of toolUseBlocks.entries()) {
        const name = b.name;
        const input = (b.input ?? {}) as Record<string, unknown>;
        ctx.wantTree = index === lastPageAction;
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
        if (name === "report_step" && actedThisTurn) {
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
        const countsAsAction = name !== "report_step" && name !== "set_plan" && name !== "finish";
        if (countsAsAction && actionsOnStep >= STEP_ACTION_LIMIT) {
          const closed = await cutOffStep(ctx, actionsOnStep);
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
              `You have spent ${actionsOnStep} actions on step ${ctx.step.current}. Do only what the step asks. If its expected result is not there by now, report the step as fail (or warn) with what you observed and go on — do not keep trying. At ${STEP_ACTION_LIMIT} actions the step is closed as fail without your verdict.`,
            );
          }
        }

        // a value typed into a password field must not show up in the log
        if (name === "fill" && typeof input.value === "string" && input.value) {
          if (await isSecretField(ctx.page, input)) ctx.secrets.add(input.value);
        }

        // set_plan is a run-level event, not tied to any specific step
        const stepNum = name === "set_plan" ? undefined : ctx.step.current;
        pushEvent(runId, {
          ts: Date.now(),
          kind: "action",
          toolName: name,
          toolInput: redactDeep(ctx, input),
          stepNum,
        });

        // time waiting for a human answer is not the browser's
        const toolStarted = name === "ask_user" ? 0 : Date.now();
        try {
          const ret = await executeTool(name, input, ctx);
          if (toolStarted) addStats(runId, { browserMs: Date.now() - toolStarted });
          const text = withNotices(ctx, ret.content);
          ctx.reviewer.record(name, input, text);
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
            text: redact(ctx, ret.observation ?? ret.content),
            stepNum,
          });
          if (ret.finished) finished = true;
          if (name === "navigate" || name === "ask_user") progressedThisTurn = true;
          // a verdict of the agent's own ends a series of steps closed for it
          if (name === "report_step" && ret.content.startsWith("OK:")) cutOffInARow = 0;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.reviewer.record(name, input, `Error: ${message}`);
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
            text: redact(ctx, `Error: ${message}`),
            stepNum,
          });
        }
      }

      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      }

      if (finished) break;

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
      // unique signatures, the agent is repeating itself — stop.
      if (ctx.step.current > lastStep || progressedThisTurn) {
        lastStep = ctx.step.current;
        sigsSinceProgress = [];
      } else if (
        sigsSinceProgress.length >= STUCK_WINDOW &&
        new Set(sigsSinceProgress).size <= STUCK_DISTINCT
      ) {
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

    await ctx.reviewer.settle();
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
    await browser?.close().catch(() => {});
    wakeLock?.kill();
    // uploaded files only exist for the duration of the run
    await cleanupUploads(runId);
  }
}
