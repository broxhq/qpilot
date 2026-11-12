// The agent loop: ask the model, run the tools it calls, repeat until finish.

import Anthropic from "@anthropic-ai/sdk";
import { chromium, type Browser } from "playwright";
import { cleanupUploads } from "../attachments";
import { addStats, checkPause, getFiles, getRun, pushEvent } from "../store";
import { NetworkMonitor } from "../network";
import { snapshot } from "./snapshot";
import { MODEL_TIMEOUT_MS, resolveProvider } from "../provider";
import { type ToolContext } from "./context";
import { PAGE_ACTIONS, executeTool } from "./handlers";
import { callModel, compactHistory } from "./model";
import { wirePage, withNotices } from "./page";
import { NUDGE } from "./prompt";
import { isSecretField, redact, redactDeep, stripRefs } from "./redact";
import { spawnWakeLock } from "./wakelock";

// Hard cap is just a backstop against runaway loops (each iteration is a paid
// model call). Real loops are caught earlier by the repetition guard: if the last
// STUCK_WINDOW actions since the last progress have <= STUCK_DISTINCT unique
// signatures, the agent is repeating itself (e.g. a blocked action it can't
// resolve). A legit complex step does many DIFFERENT actions, so it isn't flagged.
const MAX_ITERATIONS = 200;

const STUCK_WINDOW = 24;

const STUCK_DISTINCT = 4;

// Actions on a single step before the agent is told to wrap it up.
const STEP_ACTION_BUDGET = 15;

const MAX_EMPTY_TURNS = 3;

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
      step: { current: 1 },
      files,
      incoming: null,
      lastTree: null,
      wantTree: true,
      actionStarted: Date.now(),
      dialogPolicy: null,
      notices: [],
      secrets: new Set(),
    };
    wirePage(ctx, page);
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

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      await checkPause(runId);
      const trimmed = compactHistory(messages);
      const callStarted = Date.now();
      const response = await callModel(cfg, client, trimmed);
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

      for (const [index, b] of toolUseBlocks.entries()) {
        const name = b.name;
        const input = (b.input ?? {}) as Record<string, unknown>;
        ctx.wantTree = index === lastPageAction;
        ctx.actionStarted = Date.now();

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
        if (PAGE_ACTIONS.has(name)) {
          actedThisTurn = true;
          const what = input.name ?? input.url ?? input.text ?? input.key ?? "";
          ctx.net.mark(`${name}${what ? ` "${String(what).slice(0, 60)}"` : ""}`);
        }

        sigsSinceProgress.push(actionSig(name, input));

        // A step that eats dozens of actions means the agent has wandered off
        // (extra checks, undoing its own clicks). Pull it back to the report.
        if (ctx.step.current !== budgetStep) {
          budgetStep = ctx.step.current;
          actionsOnStep = 0;
        }
        if (name !== "report_step" && name !== "set_plan" && name !== "finish") {
          actionsOnStep++;
          if (actionsOnStep === STEP_ACTION_BUDGET || (actionsOnStep > STEP_ACTION_BUDGET && actionsOnStep % 10 === 0)) {
            ctx.notices.push(
              `You have spent ${actionsOnStep} actions on step ${ctx.step.current}. Do only what the step asks. If its expected result is not there by now, report the step as fail (or warn) with what you observed and go on — do not keep trying.`,
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
          toolResults.push({
            type: "tool_result",
            tool_use_id: b.id,
            content: withNotices(ctx, ret.content),
          });
          pushEvent(runId, {
            ts: Date.now(),
            kind: "observation",
            text: redact(ctx, ret.observation ?? ret.content),
            stepNum,
          });
          if (ret.finished) finished = true;
          if (name === "navigate" || name === "ask_user") progressedThisTurn = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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
        pushEvent(runId, {
          ts: Date.now(),
          kind: "done",
          status: "failed",
          summary: `Stuck: repeating the same few actions without progress — the agent is likely looping on a blocked action it can't resolve.`,
        });
        break;
      }
    }

    // Loop exited by exhausting iterations (not via finish) — close the run
    // explicitly, else status stays running and logs hang in pending though the
    // browser is gone.
    const run = getRun(runId);
    if (run && (run.status === "running" || run.status === "waiting" || run.status === "paused")) {
      pushEvent(runId, {
        ts: Date.now(),
        kind: "done",
        status: "failed",
        summary: `Reached the ${MAX_ITERATIONS}-step limit before calling finish — the run is incomplete.`,
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
