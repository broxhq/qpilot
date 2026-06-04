import Anthropic from "@anthropic-ai/sdk";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { askQuestion, checkPause, pushEvent, setPlan } from "./store";
import { TOOLS, snapshot } from "./tools";
import type { PlanGroup } from "./types";

const MODEL = "claude-haiku-4-5-20251001";

const MAX_ITERATIONS = 80;
const CONTEXT_BUDGET_CHARS = 40_000;
const KEEP_RECENT_TOOL_MSGS = 4;

type ReportStatus = "pass" | "fail" | "warn";

const SYSTEM = `You are a QA agent. Execute the test case in the browser strictly using tools.

Order:
1. set_plan — first call. groups=[{title?,steps}], one group per TC. steps without leading numbers.
2. navigate to the URL from the test case. Browser starts at about:blank — no page until you navigate.
3. Preconditions (login, opening a section) — execute after navigate, do not include in plan, do not call report_step. If precondition fails — step 1 = fail, then finish immediately.
4. Each step: snapshot if state is unknown → action → snapshot → report_step(num=sequential).
5. Each step exactly once. finish — after the last step.

Statuses: pass | fail | warn.
Critical fail (login, form open, navigate without loading): finish immediately, do not report the rest.

DO NOT HALLUCINATE:
- pass only if the expected result is actually present in the snapshot.
- evidence — verbatim quote from the snapshot.
- No element → fail, do not invent.

Elements: ref=[eN] from snapshot is required for click/fill/select/hover. Stale after page change — take a new snapshot.
For <select> dropdowns use select, not click. Use scroll to reveal elements below the fold.
Do not write [ref=eN] in description/evidence.

ask_user: only for OTP/captcha (not from the test case). secret=true for passwords/codes. One value at a time.

TOOL CALLS ONLY. Do not write text.`;

const NUDGE =
  "You responded with text but did not call a tool. Continue executing the test case ONLY via tool calls (navigate/snapshot/click/fill/report_step). When all steps are done — call finish. Do not write plain text.";
const MAX_EMPTY_TURNS = 3;

interface ToolContext {
  runId: string;
  page: Page;
  step: { current: number };
}

interface ToolResult {
  content: string;
  observation?: string;
  finished?: boolean;
}

async function locate(
  page: Page,
  input: Record<string, unknown>,
): Promise<Locator> {
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (!/^e\d+$/.test(ref)) {
    throw new Error("provide a ref from the latest snapshot (e.g. e12)");
  }
  const loc = page.locator(`aria-ref=${ref}`);
  if ((await loc.count()) === 0) {
    throw new Error(`ref ${ref} not found — take a fresh snapshot`);
  }
  return loc;
}

const stripRefs = (t: string): string => t.replace(/\s*\[ref=e\d+\]/g, "");

async function captureEvidence(page: Page): Promise<string | undefined> {
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 55 });
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { page, runId } = ctx;

  switch (name) {
    case "set_plan": {
      let groups: PlanGroup[];
      if (Array.isArray(input.groups)) {
        groups = (input.groups as unknown[])
          .map((g) => {
            const obj = (g ?? {}) as { title?: unknown; steps?: unknown };
            return {
              title:
                typeof obj.title === "string" && obj.title.trim()
                  ? obj.title.trim()
                  : undefined,
              steps: Array.isArray(obj.steps)
                ? obj.steps.map(String).filter(Boolean)
                : [],
            };
          })
          .filter((g) => g.steps.length > 0);
      } else {
        const flat = Array.isArray(input.steps)
          ? input.steps.map(String).filter(Boolean)
          : [];
        groups = flat.length ? [{ steps: flat }] : [];
      }

      setPlan(runId, groups);
      ctx.step.current = 1;

      const lines: string[] = [];
      let n = 0;
      for (const g of groups) {
        if (g.title) lines.push(g.title);
        for (const s of g.steps) lines.push(`  ${++n}) ${s}`);
      }
      return { content: `OK: plan set (${n} steps):\n${lines.join("\n")}` };
    }

    case "navigate":
      await page.goto(String(input.url), {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      return { content: `OK: navigated to ${input.url}` };

    case "snapshot":
      return { content: await snapshot(page) };

    case "click": {
      const loc = await locate(page, input);
      await loc.click({ timeout: 5000 });
      return { content: `OK: clicked ${input.name ?? input.ref}` };
    }

    case "fill": {
      const loc = await locate(page, input);
      await loc.fill(String(input.value), { timeout: 5000 });
      return { content: `OK: filled "${input.value}" into ${input.name ?? input.ref}` };
    }

    case "select": {
      const loc = await locate(page, input);
      const val = String(input.value);
      // try by value first, fall back to visible label
      try {
        await loc.selectOption(val, { timeout: 5000 });
      } catch {
        await loc.selectOption({ label: val }, { timeout: 5000 });
      }
      return { content: `OK: selected "${val}" in ${input.name ?? input.ref}` };
    }

    case "hover": {
      const loc = await locate(page, input);
      await loc.hover({ timeout: 5000 });
      return { content: `OK: hovered ${input.name ?? input.ref}` };
    }

    case "scroll": {
      const x = Number(input.x) || 0;
      const y = Number(input.y) || 0;
      // page.mouse.wheel only works if mouse is over a scrollable element,
      // so use window.scrollBy which always works
      await page.evaluate(({ x, y }) => window.scrollBy(x, y), { x, y });
      return { content: `OK: scrolled by (${x}, ${y})` };
    }

    case "press":
      await page.keyboard.press(String(input.key));
      return { content: `OK: pressed ${input.key}` };

    case "wait": {
      const ms = Math.min(Number(input.ms) || 0, 5000);
      await page.waitForTimeout(ms);
      return { content: `OK: waited ${ms}ms` };
    }

    case "ask_user": {
      const prompt = String(input.prompt ?? "");
      const secret = Boolean(input.secret);
      const answer = await askQuestion(runId, prompt, secret);
      return {
        content: answer,
        observation: secret ? "User entered a secret value" : `User replied: ${answer}`,
      };
    }

    case "report_step": {
      const status = input.status as ReportStatus;
      const screenshot =
        status === "fail" || status === "warn"
          ? await captureEvidence(page)
          : undefined;
      const num = Number(input.num);
      const step = {
        num,
        description: stripRefs(String(input.description)).replace(/^\s*\d+[.)]\s*/, ""),
        status,
        evidence: input.evidence ? stripRefs(String(input.evidence)) : undefined,
        screenshot,
      };
      pushEvent(runId, { ts: Date.now(), kind: "step", step, stepNum: num });
      ctx.step.current = num + 1;
      return { content: `OK: step ${step.num} = ${step.status}` };
    }

    case "finish": {
      const status = (input.status as string) === "passed" ? "passed" : "failed";
      pushEvent(runId, {
        ts: Date.now(),
        kind: "done",
        status,
        summary: stripRefs(String(input.summary ?? "")),
      });
      return { content: "OK: run finished", finished: true };
    }

    default:
      return { content: `Unknown tool: ${name}` };
  }
}

function compactHistory(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const size = messages.reduce((n, m) => {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    return n + c.length;
  }, 0);
  if (size <= CONTEXT_BUDGET_CHARS) return messages;

  const positions: Array<[number, number]> = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m.role === "user" && Array.isArray(m.content)) {
      for (let bi = 0; bi < m.content.length; bi++) {
        if ((m.content[bi] as { type?: string })?.type === "tool_result")
          positions.push([mi, bi]);
      }
    }
  }

  const truncate = new Set(
    positions.slice(0, -KEEP_RECENT_TOOL_MSGS).map(([mi, bi]) => `${mi}-${bi}`),
  );

  return messages.map((m, mi) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const content = (m.content as Anthropic.ToolResultBlockParam[]).map((b, bi) => {
      if (!truncate.has(`${mi}-${bi}`) || b?.type !== "tool_result") return b;
      const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      return c.length < 400 ? b : { ...b, content: `[…old page snapshot, ${c.length} chars omitted]` };
    });
    return { ...m, content };
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callModel(
  client: Anthropic,
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages,
        tools: TOOLS,
        tool_choice: { type: "auto" },
      });
    } catch (err) {
      lastErr = err;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function runAgent(
  runId: string,
  testCase: string,
  apiKey: string,
): Promise<void> {
  let browser: Browser | null = null;

  const client = new Anthropic({ apiKey });

  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: process.env.HEADLESS !== "false",
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    const ctx: ToolContext = { runId, page, step: { current: 1 } };

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content:
          "Test case(s):\n\n```\n" +
          testCase +
          "\n```\n\nFirst call set_plan — break into groups by test case (groups=[{title, steps}]) to show the plan. Then open the starting URL via navigate (browser starts at about:blank), handle login if needed, and execute steps in order, calling report_step with the sequential num for each. If an OTP is needed — ask_user. Finish with finish.",
      },
    ];

    let emptyTurns = 0;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      await checkPause(runId);
      const trimmed = compactHistory(messages);
      const response = await callModel(client, trimmed);

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
          text: stripRefs(textContent),
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
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const b of toolUseBlocks) {
        const name = b.name;
        const input = (b.input ?? {}) as Record<string, unknown>;

        const stepNum = ctx.step.current;
        pushEvent(runId, {
          ts: Date.now(),
          kind: "action",
          toolName: name,
          toolInput: input,
          stepNum,
        });

        try {
          const ret = await executeTool(name, input, ctx);
          toolResults.push({
            type: "tool_result",
            tool_use_id: b.id,
            content: ret.content,
          });
          pushEvent(runId, {
            ts: Date.now(),
            kind: "observation",
            text: ret.observation ?? ret.content,
            stepNum,
          });
          if (ret.finished) finished = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toolResults.push({
            type: "tool_result",
            tool_use_id: b.id,
            content: `Error: ${message}`,
            is_error: true,
          });
          pushEvent(runId, {
            ts: Date.now(),
            kind: "observation",
            text: `Error: ${message}`,
            stepNum,
          });
        }
      }

      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      }

      if (finished) break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pushEvent(runId, { ts: Date.now(), kind: "error", text: message });
  } finally {
    await browser?.close().catch(() => {});
  }
}
