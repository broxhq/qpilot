import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { askQuestion, checkPause, getRun, pushEvent, saveScreenshot, setPlan } from "./store";
import { TOOLS, findAnchor, snapshot } from "./tools";
import type { PlanGroup } from "./types";
import {
  callOpenAICompatible,
  parseRetryAfter,
  resolveProvider,
  type ProviderConfig,
} from "./provider";

// Hard cap is just a backstop against runaway loops (each iteration is a paid
// model call). Real loops are caught earlier by the repetition guard: if the last
// STUCK_WINDOW actions since the last progress have <= STUCK_DISTINCT unique
// signatures, the agent is repeating itself (e.g. a blocked action it can't
// resolve). A legit complex step does many DIFFERENT actions, so it isn't flagged.
const MAX_ITERATIONS = 200;
const STUCK_WINDOW = 24;
const STUCK_DISTINCT = 4;
const CONTEXT_BUDGET_CHARS = 64_000;
const KEEP_RECENT_TOOL_MSGS = 3;
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 30_000;

type ReportStatus = "pass" | "fail" | "warn";

const SYSTEM = `You are a QA agent. Execute the test case in the browser strictly using tools.

Order:
1. set_plan — first call. groups=[{title?,steps}], one group per TC. steps without leading numbers.
2. navigate to the URL from the test case. Browser starts at about:blank — no page until you navigate.
3. Preconditions (login, opening a section) — execute after navigate, do not include in plan, do not call report_step. If precondition fails — step 1 = fail, then finish immediately.
4. Each step: act → read the snapshot returned BY that action → report_step(num=sequential).
5. Each step exactly once. finish — after the last step.

EFFICIENCY — you have a limited number of steps, do not waste them:
- navigate/click/fill/select/hover/press/scroll/scroll_to/wait/dismiss ALREADY return a fresh snapshot in their result. Do NOT call snapshot after them — just read what they returned.
- Call snapshot only for the FIRST page read, or to zoom into a block with near=.
- Batch independent actions in ONE turn: e.g. emit several fill calls together to fill a form, then report. Fewer round-trips = more budget for real work.

Statuses: pass | fail | warn.
Critical fail (login, form open, navigate without loading): finish immediately, do not report the rest.

DO NOT HALLUCINATE:
- pass only if the expected result is actually present in the snapshot.
- evidence — verbatim quote from the snapshot.
- No element → fail, do not invent.

Elements: ref=[eN] is required for click/fill/select/hover, taken from the MOST RECENT snapshot (including the one your last action returned). Older refs are stale.
For <select> dropdowns use select, not click.
If a click fails with "intercepts pointer events", an open overlay (dropdown/popover) is covering the target: call dismiss to click an empty corner (closes it), then snapshot and retry. Custom dropdowns usually ignore Escape.

Finding elements (IMPORTANT): the snapshot is the WHOLE loaded page, not just the visible part. Scrolling does NOT add elements to it — if a control exists it's already in the tree. So DO NOT scroll repeatedly to "find" a button.
- To act on a control in a named section (e.g. "Show all" in the "Top ads" block), call snapshot with near='Top ads' — it returns just that block's tree with refs, never truncated, and disambiguates duplicate labels (there can be many "Show all"). Then click the ref. This is the right tool for "do X in section Y".
- If a snapshot is truncated, use near=… to zoom in — never scroll to fix truncation.
- Scroll only to: trigger lazy-loaded / infinite-scroll content that isn't in the DOM yet, or position something for a screenshot.

Scrolling:
- scroll_to(text or ref) — auto-scrolls whatever container holds the target (page, inner div, or sideways) until it's visible.
- scroll(y, x?, ref?) for pixel scrolling. No ref = main window. To scroll a block INSIDE the page (list, panel, modal body with its own scrollbar), pass ref of ANY element inside that block — the scrollable container is found automatically. Use x for horizontal (carousels, wide tables).
- scroll returns position and limits (e.g. "Vertical 800/2400px") and flags edges/no-movement — read it: if the window didn't move, content is in an inner block, retry with a ref inside it.
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

// Wraps click/fill: when an overlay intercepts the click ("intercepts pointer
// events"), return a short directive instead of Playwright's wall of log text —
// otherwise the model keeps repeating the same failing click.
// Return a fresh snapshot in the SAME result as the action — this removes the
// separate snapshot call after every action and roughly halves iterations per
// step. Only the short observation goes to events/SSE; the tree goes to the model.
async function actionResult(page: Page, msg: string): Promise<ToolResult> {
  const tree = await snapshot(page).catch(() => "");
  return { content: tree ? `${msg}\n\n${tree}` : msg, observation: msg };
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

async function clickWithHint(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/intercepts pointer events/i.test(msg)) {
      const overlay = msg.match(/from <[^>]*class="([^"]+)"/)?.[1]?.split(/\s+/)[0];
      throw new Error(
        `Click blocked: an open overlay${overlay ? ` (${overlay})` : ""} is covering the target. ` +
          `Close it first — call dismiss (clicks an empty corner) or click the overlay's own trigger again, ` +
          `then take a fresh snapshot. Escape often doesn't work on custom dropdowns.`,
      );
    }
    throw err;
  }
}

async function captureEvidence(page: Page): Promise<Buffer | undefined> {
  try {
    return await page.screenshot({ type: "jpeg", quality: 55 });
  } catch {
    return undefined;
  }
}

type ScrollResult = {
  kind: "window" | "container";
  tag?: string;
  movedX: number;
  movedY: number;
  posY: number;
  maxY: number;
  posX: number;
  maxX: number;
};

// Runs IN THE BROWSER (serialized by Playwright). Args are normalized so the
// same function works for page.evaluate(fn, arg) → fn(arg) and
// locator.evaluate(fn, arg) → fn(el, arg). When an element is given, scrolls
// the nearest scrollable ancestor (the real scroll container is usually not the
// element itself); otherwise scrolls the main window.
function scrollNearest(
  a: Element | { x: number; y: number },
  b?: { x: number; y: number },
): ScrollResult {
  const el = (b === undefined ? null : a) as Element | null;
  const { x: dx, y: dy } = (b === undefined ? a : b) as { x: number; y: number };

  const findScrollable = (start: Element | null, axis: "x" | "y"): Element | null => {
    let n: Element | null = start;
    while (n && n !== document.body && n !== document.documentElement) {
      const s = getComputedStyle(n);
      const ov = axis === "x" ? s.overflowX : s.overflowY;
      const room =
        axis === "x"
          ? n.scrollWidth > n.clientWidth + 1
          : n.scrollHeight > n.clientHeight + 1;
      if (/(auto|scroll|overlay)/.test(ov) && room) return n;
      n = n.parentElement;
    }
    return null;
  };

  // Prefer the axis with the larger requested delta, fall back to the other.
  const axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
  const target = el
    ? findScrollable(el, axis) ?? findScrollable(el, axis === "y" ? "x" : "y")
    : null;

  if (!target) {
    const beforeX = window.scrollX;
    const beforeY = window.scrollY;
    window.scrollBy(dx, dy);
    const doc = document.documentElement;
    return {
      kind: "window",
      movedX: window.scrollX - beforeX,
      movedY: window.scrollY - beforeY,
      posY: Math.round(window.scrollY),
      maxY: Math.round(doc.scrollHeight - window.innerHeight),
      posX: Math.round(window.scrollX),
      maxX: Math.round(doc.scrollWidth - window.innerWidth),
    };
  }

  const beforeLeft = target.scrollLeft;
  const beforeTop = target.scrollTop;
  target.scrollBy(dx, dy);
  return {
    kind: "container",
    tag: target.tagName.toLowerCase(),
    movedX: target.scrollLeft - beforeLeft,
    movedY: target.scrollTop - beforeTop,
    posY: Math.round(target.scrollTop),
    maxY: Math.round(target.scrollHeight - target.clientHeight),
    posX: Math.round(target.scrollLeft),
    maxX: Math.round(target.scrollWidth - target.clientWidth),
  };
}

// Human/model-readable summary: how far it moved, current position vs. limit,
// and hints when nothing happened (likely an inner scroll container).
function describeScroll(r: ScrollResult, reqX: number, reqY: number): string {
  const where = r.kind === "window" ? "window" : `<${r.tag}> block`;
  const parts: string[] = [`OK: scrolled ${where} by (${r.movedX}, ${r.movedY})px.`];

  if (reqY !== 0 || r.movedY !== 0) {
    const edge =
      r.posY >= r.maxY - 2 ? " (bottom reached)" : r.posY <= 2 ? " (top)" : "";
    parts.push(`Vertical ${r.posY}/${r.maxY}px${edge}.`);
  }
  if (reqX !== 0 || r.movedX !== 0) {
    const edge =
      r.posX >= r.maxX - 2 ? " (rightmost)" : r.posX <= 2 ? " (leftmost)" : "";
    parts.push(`Horizontal ${r.posX}/${r.maxX}px${edge}.`);
  }
  if (r.movedX === 0 && r.movedY === 0) {
    parts.push(
      r.kind === "window" && (reqX !== 0 || reqY !== 0)
        ? "Window did not move — the content is likely inside a scrollable block; pass a ref of an element inside that block to scroll it."
        : "No movement — already at the edge in that direction.",
    );
  }
  parts.push("Take a snapshot to see new content.");
  return parts.join(" ");
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const { page, runId } = ctx;

  switch (name) {
    case "set_plan": {
      // tolerate sloppy formats: accept steps as a newline-separated string too
      const toSteps = (v: unknown): string[] =>
        Array.isArray(v)
          ? v.map((s) => String(s).trim()).filter(Boolean)
          : typeof v === "string"
            ? v.split("\n").map((s) => s.trim()).filter(Boolean)
            : [];

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
              steps: toSteps(obj.steps),
            };
          })
          .filter((g) => g.steps.length > 0);
      } else {
        const flat = toSteps(input.steps);
        groups = flat.length ? [{ steps: flat }] : [];
      }

      // reject an empty plan loudly — otherwise the UI shows no steps and
      // report_step would append them one by one
      if (groups.length === 0) {
        return {
          content:
            'Error: set_plan received no steps. Call set_plan again with groups=[{title:"TC-01...", steps:["step one", "step two", ...]}] — steps must be a non-empty array of strings.',
        };
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
      return actionResult(page, `OK: navigated to ${input.url}`);

    case "snapshot": {
      const tree = await snapshot(
        page,
        typeof input.near === "string" ? input.near : undefined,
      );
      // don't push the full tree to events/SSE — the UI doesn't render it anyway
      return { content: tree, observation: `Page read (${tree.length} chars)` };
    }

    case "click": {
      const loc = await locate(page, input);
      await clickWithHint(() => loc.click({ timeout: 5000 }));
      return actionResult(page, `OK: clicked ${input.name ?? input.ref}`);
    }

    case "fill": {
      const loc = await locate(page, input);
      await clickWithHint(() => loc.fill(String(input.value), { timeout: 5000 }));
      return actionResult(page, `OK: filled "${input.value}" into ${input.name ?? input.ref}`);
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
      return actionResult(page, `OK: selected "${val}" in ${input.name ?? input.ref}`);
    }

    case "hover": {
      const loc = await locate(page, input);
      await loc.hover({ timeout: 5000 });
      return actionResult(page, `OK: hovered ${input.name ?? input.ref}`);
    }

    case "scroll_to": {
      const ref = typeof input.ref === "string" ? input.ref.trim() : "";
      const text = String(input.text ?? "");
      let loc: Locator;
      let label: string;
      if (/^e\d+$/.test(ref)) {
        loc = page.locator(`aria-ref=${ref}`);
        label = `ref ${ref}`;
        if ((await loc.count()) === 0) {
          return { content: `ref ${ref} not found — take a fresh snapshot` };
        }
      } else if (text) {
        const anchor = await findAnchor(page, text);
        if (!anchor) {
          return { content: `Not found on page: "${text}" — try a shorter/unique substring, or it may not be loaded yet (scroll the page first to trigger lazy loading)` };
        }
        loc = anchor;
        label = `element containing "${text}"`;
      } else {
        return { content: "Provide either text or ref to scroll to." };
      }
      // scrollIntoViewIfNeeded walks up and scrolls every scrollable ancestor
      // (page, inner divs, horizontal) as needed to reveal the element.
      await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
      return actionResult(page, `OK: scrolled to ${label}`);
    }

    case "scroll": {
      const x = Number(input.x) || 0;
      const y = Number(input.y) || 0;
      const ref = typeof input.ref === "string" ? input.ref.trim() : "";

      let res: ScrollResult;
      if (/^e\d+$/.test(ref)) {
        const loc = page.locator(`aria-ref=${ref}`);
        if ((await loc.count()) === 0) {
          return { content: `ref ${ref} not found — take a fresh snapshot` };
        }
        // Find the nearest scrollable ancestor of the ref'd element and scroll it.
        res = await loc.evaluate(scrollNearest, { x, y });
      } else {
        res = await page.evaluate(scrollNearest, { x, y });
      }
      return actionResult(page, describeScroll(res, x, y));
    }

    case "press":
      await page.keyboard.press(String(input.key));
      return actionResult(page, `OK: pressed ${input.key}`);

    case "dismiss":
      // click an empty viewport corner = click-outside: closes dropdowns/popovers
      await page.mouse.click(5, 5);
      await page.waitForTimeout(150);
      return actionResult(page, "OK: clicked empty area to close any open overlay");

    case "wait": {
      const ms = Math.min(Number(input.ms) || 0, 5000);
      await page.waitForTimeout(ms);
      return actionResult(page, `OK: waited ${ms}ms`);
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
      const num = Number(input.num);
      // JPEG goes to the store and is served via a separate GET — never inlined in events/SSE
      let screenshot: string | undefined;
      if (status === "fail" || status === "warn") {
        const buf = await captureEvidence(page);
        if (buf) {
          saveScreenshot(runId, num, buf);
          screenshot = `/api/run/${runId}/shot/${num}`;
        }
      }
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

// Backoff before a retry. Prefer the server's Retry-After (present on 429 from
// most gateways); otherwise exponential 1→2→4→8s + jitter, capped.
// The Anthropic SDK exposes headers on err.headers; the custom path on err.retryAfterMs.
function retryDelayMs(err: unknown, attempt: number): number {
  const e = err as { retryAfterMs?: number; headers?: { get?: (k: string) => string | null } };
  const hinted =
    e?.retryAfterMs ?? parseRetryAfter(e?.headers?.get?.("retry-after") ?? null);
  if (typeof hinted === "number" && hinted > 0) {
    return Math.min(hinted, MAX_BACKOFF_MS);
  }
  const backoff = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return backoff + Math.floor(Math.random() * 500);
}

async function callModel(
  cfg: ProviderConfig,
  client: Anthropic | null,
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (cfg.kind === "anthropic") {
        return await client!.messages.create({
          model: cfg.model,
          max_tokens: 2048,
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          messages,
          tools: TOOLS,
          tool_choice: { type: "auto" },
        });
      }
      return await callOpenAICompatible(cfg, SYSTEM, messages, TOOLS);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      // retrying 4xx (except 429) is pointless: bad key/model/request
      if (status && status >= 400 && status < 500 && status !== 429) break;
      if (attempt === MAX_RETRIES - 1) break;
      await sleep(retryDelayMs(err, attempt));
    }
  }
  throw lastErr;
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
      ? new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL })
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
    // Loop detector: action signatures since the last progress milestone
    // (completed step / navigate / user answer). Repetition with low diversity
    // means the agent is stuck.
    let lastStep = ctx.step.current;
    let sigsSinceProgress: string[] = [];

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      await checkPause(runId);
      const trimmed = compactHistory(messages);
      const response = await callModel(cfg, client, trimmed);

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
      // milestones that count as progress besides report_step: a successful
      // navigate or a user answer. The long login/precondition phase (cert,
      // OTP, redirects) makes real headway without closing a step yet.
      let progressedThisTurn = false;
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const b of toolUseBlocks) {
        const name = b.name;
        const input = (b.input ?? {}) as Record<string, unknown>;

        sigsSinceProgress.push(actionSig(name, input));

        // set_plan is a run-level event, not tied to any specific step
        const stepNum = name === "set_plan" ? undefined : ctx.step.current;
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
          if (name === "navigate" || name === "ask_user") progressedThisTurn = true;
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
  }
}

function spawnWakeLock() {
  try {
    if (process.platform === "darwin") {
      return spawn("caffeinate", ["-i"], { stdio: "ignore" });
    }
    if (process.platform === "win32") {
      // Calls SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED) every 30s.
      // When the process is killed the OS automatically clears the requirement.
      const ps = `Add-Type -Name K -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; while($true){[W.K]::SetThreadExecutionState(0x80000003); Start-Sleep 30}`;
      return spawn("powershell", ["-NonInteractive", "-Command", ps], { stdio: "ignore" });
    }
    if (process.platform === "linux") {
      return spawn(
        "systemd-inhibit",
        ["--what=sleep:idle", "--who=qpilot", "--why=Running test", "--mode=block", "sleep", "infinity"],
        { stdio: "ignore" },
      );
    }
  } catch {
    // wake lock is best-effort — ignore if unavailable
  }
  return null;
}
