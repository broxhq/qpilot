import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { cleanupUploads, type StoredFile } from "./attachments";
import {
  addStats,
  askQuestion,
  checkPause,
  getFiles,
  getRun,
  pushEvent,
  saveScreenshot,
  setPlan,
} from "./store";
import { NetworkMonitor } from "./network";
import { TOOLS, findAnchor, snapshot } from "./tools";
import type { PlanGroup, RunEvent } from "./types";
import {
  MODEL_TIMEOUT_MS,
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
// Tools that act on the page and return its tree through actionResult.
const PAGE_ACTIONS = new Set([
  "navigate", "click", "fill", "select", "hover", "press", "scroll", "scroll_to",
  "dismiss", "wait", "wait_for", "upload_file", "switch_tab",
]);
// Actions on a single step before the agent is told to wrap it up.
const STEP_ACTION_BUDGET = 15;
const CONTEXT_BUDGET_CHARS = 64_000;
const KEEP_RECENT_TOOL_MSGS = 3;
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 30_000;

type ReportStatus = "pass" | "fail" | "warn";

// Every line here is sent with every model call and the model is the slow part
// of a run, so the prompt is kept to rules that change behaviour. Tool-specific
// details live in the tool descriptions (lib/tools.ts).
const SYSTEM = `You are a QA agent. You execute a manual test case in a real browser with tools and give a verdict for every step. Answer with tool calls; if you need to reason, one short sentence at most.

FLOW
1. set_plan first: one group per test case, steps in the tester's words (action + expected result). Preconditions (login, opening a section) are not steps.
2. navigate to the URL from the test case (the browser starts on about:blank) and do the preconditions.
3. For each step, in order: do what it says → read the page tree returned by the action → report_step.
4. finish after the last step.

SPEED — every turn is a slow round trip, so pack turns
- Every action (navigate, click, fill, select, hover, press, scroll, wait_for, upload_file…) returns the fresh page tree. Never call snapshot just to look at the page after an action.
- Put independent calls in ONE turn: all fills of a form plus its submit click; report_step for the step you have just verified plus the first action(s) of the next step; the last report_step plus finish.
- Only the LAST page action of a turn returns the page tree, so put last the action whose result you need to read.
- report_step is about results you have ALREADY seen: never in the same turn after an action of that step.

VERDICTS
- pass only when the expected result is literally in what you received. Otherwise fail. warn = done, but the outcome is unclear.
- report_step: num from the plan; expected = the step's expected result copied from the test case; evidence = what you saw, quoting the page verbatim, one or two sentences; status last, decided from that evidence. Never write refs (e12) in any text.
- Every result lists "Changes since the previous page tree" (− was, + is now). Use it for "changed / did not change" checks and quote the changed lines as evidence; "NONE" means the action changed nothing.
- A failed step does not end the run: go on with the next step. Only a failed precondition ends it.
- Each step is reported exactly once. A failed step is reported as fail at once — do not try variations to turn it into a pass.
- A precondition fails (cannot log in, the page does not load) → report step 1 as fail and finish.
- Write plan steps, evidence and the summary in the language of the test case; quotes keep the page's wording.

SCOPE — do exactly what the step says and nothing else
- No extra checks, no exploring, no cleanup. Do not undo what a step did (a switch you toggled stays toggled) unless the test case says so.
- Follow the wording literally: "click 400 px to the right of X" is a click with dx=400, not a click on X.
- A step cannot be done as written → report fail (or warn) and say why. Do not substitute another action.
- Never repeat a submitting action (save, create, send, pay, delete, confirm): one click per step. If the page then shows an error or nothing at all, report fail with the page's message — the request may have gone through, and a retry creates a duplicate.
- A step says to remember a value or to compare with an earlier state → save it with note BEFORE the page changes. Old page trees are dropped from your context.

ELEMENTS
- click/fill/select/hover need a ref from the MOST RECENT page tree; older refs are stale. Refs inside an iframe look like f1e2 — use them as shown.
- The tree is the WHOLE page, not just the visible part: scrolling never adds elements. To find a control in a named block, or when the tree is truncated, use snapshot(near="block title"). Scroll only for lazy-loaded content.
- <select> → select. Something that opens on hover (bell, avatar menu, tooltip, submenu) → hover, not click. An icon-only control has no name: the tree shows it as "(no name; class=…, icon=…, data-testid=…)" — pick the one whose hints fit (bell, notif…), never just the first unnamed button.
- After hover or click, check that it worked: the result must list the opened panel under "Changes". "NONE" means nothing opened — you hit the wrong element; try the next candidate. Do not report a step about a panel you did not see open.
- A panel opened by hover stays open only while the pointer is on it. Until you are done with it, act only inside it: click, hover and scroll with refs taken from inside the panel. dismiss, or an action on an element outside it, closes it.
- Lists that load more on scroll: scroll(ref of an item INSIDE the list, y) and repeat until the result says "bottom reached" — the next page is requested only near the bottom, and the list then grows. One scroll that did not reach the bottom proves nothing.
- "intercepts pointer events" means an overlay covers the target: dismiss, then retry.
- The page still shows the old state, a loader or a spinner → wait_for(a text the new state must show, timeout_s up to 60). It is a failure only after wait_for times out.
- A new tab: you are moved to it automatically; switch_tab(index) goes back. Native dialogs are accepted (OK) automatically and their text is at the top of the result; to press Cancel or type into a prompt call handle_dialog BEFORE the action.

FILES
- A step needs a file → upload_file with the name of an attached file. You cannot see file contents: never say you read or checked them; quote what the page shows after the upload.

NETWORK — only when the test case asks to mock, break, slow down or inspect requests
- mock_request BEFORE the action that sends the request. Body: the one from the test case; otherwise let the real request happen once, read it with get_requests and reuse its field names — that is preparation, not the step: afterwards set the mock, repeat the step's action and judge the step by the mocked page. To change a few fields use patch. Invent a body only when the real request cannot be made. Read what mock_request returns: it names missing or wrong fields — fix them.
- Mocks persist: clear_mocks when the test case no longer needs them. set_offline(true) → check → set_offline(false).
- "The request was sent / with this body / returned this status" → get_requests(find=endpoint or method name). Each request says after which of your actions it was sent: only requests sent after the step's own action count. The same request sent earlier (after navigate, by another widget on the page) proves nothing about the step. Quote method, URL, status and "sent after" as evidence. A mock that matched 0 requests has a wrong URL — fix it, do not report pass.

ask_user — only for a value the test case does not give and you cannot know (login, phone, OTP, captcha). secret=true for passwords and codes. One value per question.`;

const NUDGE =
  "You answered with text and no tool call. Go on with the test case using tool calls only; when every step is reported, call finish.";
const MAX_EMPTY_TURNS = 3;

interface ToolContext {
  runId: string;
  /** The active tab. Replaced when an action opens a new tab or switch_tab is called. */
  page: Page;
  context: BrowserContext;
  net: NetworkMonitor;
  step: { current: number };
  files: StoredFile[];
  /** A tab opened by the page that the agent hasn't been moved to yet. */
  incoming: Page | null;
  /** The page tree the model saw last — the next result says what changed against it. */
  lastTree: string | null;
  /** false for all but the last page action of a turn: only that one returns the page tree. */
  wantTree: boolean;
  /** When the current tool call started — settling waits only for requests sent after it. */
  actionStarted: number;
  /** One-shot answer for the next native dialog, set by handle_dialog. */
  dialogPolicy: { action: "accept" | "dismiss"; text?: string } | null;
  /** Things that happened on their own (dialog, new tab) — prepended to the next tool result. */
  notices: string[];
  /** Values typed into password fields or given as secret answers — masked in everything the UI shows. */
  secrets: Set<string>;
}

interface ToolResult {
  content: string;
  observation?: string;
  finished?: boolean;
}

// Playwright prefixes refs of elements inside a (same-origin) iframe with the
// iframe's frame sequence, e.g. "f1e2" — plain "e12" is only the main frame.
const REF_RE = /^(?:f\d+)?e\d+$/;

async function locate(
  page: Page,
  input: Record<string, unknown>,
): Promise<Locator> {
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (!REF_RE.test(ref)) {
    throw new Error("provide a ref from the latest snapshot (e.g. e12 or f1e2 for an element inside an iframe)");
  }
  const loc = page.locator(`aria-ref=${ref}`);
  if ((await loc.count()) === 0) {
    throw new Error(`ref ${ref} not found — take a fresh snapshot`);
  }
  return loc;
}

// Models copy refs out of the snapshot in every form: [ref=e12], [e12], (e12), "row e12".
const stripRefs = (t: string): string =>
  t
    .replace(/\s*[[(](?:ref=)?(?:f\d+)?e\d+[\])]/g, "")
    .replace(/(^|\s)(?:ref=)?(?:f\d+)?e\d{1,6}(?=[\s.,;:)]|$)/g, "");

const SECRET_MASK = "••••••";

/** Mask known secrets in text that goes to events / the UI (never in what the model receives). */
function redact(ctx: ToolContext, text: string): string {
  let out = text;
  for (const secret of ctx.secrets) {
    if (secret.length >= 3) out = out.split(secret).join(SECRET_MASK);
  }
  return out;
}

function redactDeep(ctx: ToolContext, v: unknown): unknown {
  if (ctx.secrets.size === 0) return v;
  if (typeof v === "string") return redact(ctx, v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(ctx, x));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactDeep(ctx, x)]),
    );
  }
  return v;
}

/** Is `fill` about to type into a password / one-time-code field? */
async function isSecretField(page: Page, input: Record<string, unknown>): Promise<boolean> {
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (!REF_RE.test(ref)) return false;
  return page
    .locator(`aria-ref=${ref}`)
    .evaluate(
      (el) =>
        el instanceof HTMLInputElement &&
        (el.type === "password" ||
          /one-time-code|current-password|new-password|cc-csc/.test(el.autocomplete)),
      undefined,
      { timeout: 1000 },
    )
    .catch(() => false);
}

/** Events that aren't tied to a tool call (a dialog, a new tab) — visible in the step log. */
function note(ctx: ToolContext, text: string, info: NonNullable<RunEvent["info"]>): void {
  ctx.notices.push(text);
  pushEvent(ctx.runId, { ts: Date.now(), kind: "info", text, info, stepNum: ctx.step.current });
}

function tabsLine(ctx: ToolContext): string {
  const pages = ctx.context.pages();
  if (pages.length < 2) return "";
  return (
    "Tabs: " +
    pages
      .map((p, i) => `${i + 1}) ${p.url() || "about:blank"}${p === ctx.page ? " [active]" : ""}`)
      .join("  ") +
    " — switch_tab(index) to change"
  );
}

/** Move the agent to a tab the page has just opened (target=_blank, window.open). */
async function adoptNewTab(ctx: ToolContext): Promise<void> {
  const fresh = ctx.incoming;
  if (!fresh) return;
  ctx.incoming = null;
  if (fresh.isClosed()) return;
  await fresh.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  ctx.page = fresh;
  note(ctx, `A new browser tab opened (${fresh.url()}) — it is now the active tab.`, {
    type: "newTab",
    url: fresh.url(),
  });
}

/** Dialogs, console errors and "tab closed" are per page: call for every tab of the run. */
function wirePage(ctx: ToolContext, page: Page): void {
  ctx.net.wirePage(page);

  // Without a handler Playwright dismisses every dialog, so "Delete? → OK"
  // would silently cancel. Accept by default, like a tester moving on.
  page.on("dialog", async (dialog) => {
    const policy = dialog.type() === "beforeunload" ? null : ctx.dialogPolicy;
    if (dialog.type() !== "beforeunload") ctx.dialogPolicy = null;
    const action = policy?.action ?? "accept";
    try {
      if (action === "dismiss") await dialog.dismiss();
      else await dialog.accept(dialog.type() === "prompt" ? policy?.text : undefined);
    } catch {
      return; // page went away with the dialog open
    }
    if (dialog.type() === "beforeunload") return;
    const typed = dialog.type() === "prompt" && action === "accept" && policy?.text ? ` with "${policy.text}"` : "";
    note(
      ctx,
      `Browser ${dialog.type()} dialog: "${dialog.message()}" — ${action === "accept" ? `accepted (OK)${typed}` : "dismissed (Cancel)"}.`,
      { type: "dialog", dialog: dialog.type(), message: dialog.message(), accepted: action === "accept" },
    );
  });

  page.on("close", () => {
    if (ctx.page !== page) return;
    const rest = ctx.context.pages().filter((p) => p !== page && !p.isClosed());
    const next = rest[rest.length - 1];
    if (!next) return;
    ctx.page = next;
    note(ctx, `The active tab was closed — switched back to ${next.url()}.`, {
      type: "tabClosed",
      url: next.url(),
    });
  });
}

// Wraps click/fill: when an overlay intercepts the click ("intercepts pointer
// events"), return a short directive instead of Playwright's wall of log text —
// otherwise the model keeps repeating the same failing click.
// Return a fresh snapshot in the SAME result as the action — this removes the
// separate snapshot call after every action and roughly halves iterations per
// step. Only the short observation goes to events/SSE; the tree goes to the model.
async function actionResult(ctx: ToolContext, msg: string): Promise<ToolResult> {
  await adoptNewTab(ctx);
  // let the page answer before reading it: a snapshot taken right after a click
  // shows the old page or a loader, and the model takes that for a failure
  await ctx.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  if (!ctx.wantTree) {
    // not the last action of the turn: the next one follows at once, and reading
    // the page here would cost a snapshot nobody looks at
    await ctx.net.waitForQuiet(ctx.actionStarted, 1200);
    return { content: `${msg}\n(the page tree comes with the last action of this turn)`, observation: msg };
  }
  await ctx.net.waitForQuiet(ctx.actionStarted, 4000);
  const tree = await snapshot(ctx.page).catch(() => "");
  const tabs = tabsLine(ctx);
  const changes = tree ? describeChanges(ctx.lastTree, tree) : "";
  if (tree) ctx.lastTree = tree;
  const body = [msg, tabs, changes, tree].filter(Boolean).join("\n\n");
  return { content: body, observation: msg };
}

const MAX_CHANGE_LINES = 40;

/**
 * What the action changed on the page, as removed (−) and added (+) lines of the
 * page tree. Spotting that one "[checked]" went missing among hundreds of lines
 * is exactly where a model slips, and "did the state change?" is what most
 * steps ask — so the comparison is done here and handed over ready.
 */
function describeChanges(before: string | null, after: string): string {
  if (before === null) return "";
  const norm = (t: string) =>
    t
      .split("\n")
      .map((l) => l.replace(/\s*\[ref=[^\]]+\]/g, "").trim())
      .filter((l) => l && !l.startsWith("Page snapshot"));
  const a = norm(before);
  const b = norm(after);
  if (a[0] !== b[0]) return `Page changed: ${a[0]} → ${b[0]}`; // the "URL: …" line
  const count = (lines: string[]) => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  const removed: string[] = [];
  const added: string[] = [];
  for (const [l, n] of ca) for (let i = cb.get(l) ?? 0; i < n; i++) removed.push(l);
  for (const [l, n] of cb) for (let i = ca.get(l) ?? 0; i < n; i++) added.push(l);
  if (removed.length === 0 && added.length === 0) {
    return "Changes since the previous page tree: NONE — the page looks exactly as before.";
  }
  const lines = [...removed.map((l) => `− ${l}`), ...added.map((l) => `+ ${l}`)];
  const shown = lines.slice(0, MAX_CHANGE_LINES);
  const more = lines.length > shown.length ? `\n… and ${lines.length - shown.length} more changed lines` : "";
  return `Changes since the previous page tree (− was, + is now):\n${shown.join("\n")}${more}`;
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

/**
 * Runs IN THE BROWSER. A point inside the visible part of the nearest scrollable
 * ancestor of the element — where a person would rest the pointer to scroll that
 * block. The element itself may be scrolled out of view, so its own position is
 * no use. null when the block is the page itself.
 */
function pointInScrollBlock(el: Element): { x: number; y: number } | null {
  let n: Element | null = el;
  while (n && n !== document.body && n !== document.documentElement) {
    const st = getComputedStyle(n);
    const scrollsY = /(auto|scroll|overlay)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 1;
    const scrollsX = /(auto|scroll|overlay)/.test(st.overflowX) && n.scrollWidth > n.clientWidth + 1;
    if (scrollsY || scrollsX) {
      const r = n.getBoundingClientRect();
      const left = Math.max(r.left, 0);
      const top = Math.max(r.top, 0);
      const right = Math.min(r.right, window.innerWidth);
      const bottom = Math.min(r.bottom, window.innerHeight);
      if (right - left < 4 || bottom - top < 4) return null;
      return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
    }
    n = n.parentElement;
  }
  return null;
}

/** Turn the mouse wheel in small steps, like a hand on a touchpad, so scroll handlers see a real scroll. */
async function wheel(page: Page, dx: number, dy: number): Promise<void> {
  const steps = Math.min(40, Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 120)));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(dx / steps, dy / steps);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(250); // smooth scrolling and scroll handlers
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
  if (r.kind === "container" && r.posY < r.maxY - 2 && reqY > 0) {
    parts.push("Not at the bottom yet — a list that loads more on scroll does so only near its bottom.");
  }
  parts.push("Scrolling does not change the page tree by itself; it changes only if new content was loaded.");
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
        timeout: 60000, // slow networks and VPNs: 20s was not enough for a first load
      });
      return actionResult(ctx, `OK: navigated to ${input.url}`);

    case "snapshot": {
      const tree = await snapshot(
        page,
        typeof input.near === "string" ? input.near : undefined,
      );
      if (typeof input.near !== "string") ctx.lastTree = tree;
      // don't push the full tree to events/SSE — the UI doesn't render it anyway
      return { content: tree, observation: `Page read (${tree.length} chars)` };
    }

    case "click": {
      const loc = await locate(page, input);
      const dx = Number(input.dx) || 0;
      const dy = Number(input.dy) || 0;
      if (dx !== 0 || dy !== 0) {
        // a click NEXT TO the element: a raw mouse click at a point, so it lands
        // on whatever is there — which is the whole point of the check
        await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
        const box = await loc.boundingBox();
        if (!box) throw new Error(`${input.ref} is not visible — cannot click next to it`);
        const x = Math.round(box.x + box.width / 2 + dx);
        const y = Math.round(box.y + box.height / 2 + dy);
        const view = page.viewportSize() ?? { width: 1440, height: 900 };
        if (x < 0 || y < 0 || x >= view.width || y >= view.height) {
          return {
            content: `Error: the point (${x}, ${y}) is outside the ${view.width}×${view.height} viewport. The element's centre is at (${Math.round(box.x + box.width / 2)}, ${Math.round(box.y + box.height / 2)}) — use a smaller offset.`,
          };
        }
        await page.mouse.click(x, y);
        await page.waitForTimeout(150).catch(() => {});
        return actionResult(
          ctx,
          `OK: clicked at (${x}, ${y}) — ${dx}px right / ${dy}px down from the centre of ${input.name ?? input.ref}`,
        );
      }
      await clickWithHint(() => loc.click({ timeout: 5000 }));
      // a click that opens a new tab resolves before the tab is announced
      await page.waitForTimeout(150).catch(() => {});
      return actionResult(ctx, `OK: clicked ${input.name ?? input.ref}`);
    }

    case "fill": {
      const loc = await locate(page, input);
      await clickWithHint(() => loc.fill(String(input.value), { timeout: 5000 }));
      return actionResult(ctx, `OK: filled "${input.value}" into ${input.name ?? input.ref}`);
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
      return actionResult(ctx, `OK: selected "${val}" in ${input.name ?? input.ref}`);
    }

    case "hover": {
      const loc = await locate(page, input);
      await loc.hover({ timeout: 5000 });
      // some hover handlers wait for the pointer to move again or to rest ("hover
      // intent"): one more small move inside the element, then stay still
      const hb = await loc.boundingBox().catch(() => null);
      if (hb) {
        await page.mouse.move(hb.x + hb.width / 2 + 1, hb.y + hb.height / 2 + 1).catch(() => {});
      }
      // panels that open on hover usually do so after a short delay or animation
      await page.waitForTimeout(600).catch(() => {});
      return actionResult(ctx, `OK: hovered ${input.name ?? input.ref}`);
    }

    case "scroll_to": {
      const ref = typeof input.ref === "string" ? input.ref.trim() : "";
      const text = String(input.text ?? "");
      let loc: Locator;
      let label: string;
      if (REF_RE.test(ref)) {
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
      return actionResult(ctx, `OK: scrolled to ${label}`);
    }

    case "scroll": {
      const x = Number(input.x) || 0;
      const y = Number(input.y) || 0;
      const ref = typeof input.ref === "string" ? input.ref.trim() : "";

      let res: ScrollResult;
      if (REF_RE.test(ref)) {
        const loc = page.locator(`aria-ref=${ref}`);
        if ((await loc.count()) === 0) {
          return { content: `ref ${ref} not found — take a fresh snapshot` };
        }
        // Scroll the way a person does: pointer over the block, then the wheel.
        // A programmatic scrollBy leaves the pointer where it was, so a panel
        // that is open only while hovered closes under the agent, and lists
        // that react to the wheel never load their next page.
        const before = await loc.evaluate(scrollNearest, { x: 0, y: 0 });
        const spot = await loc.evaluate(pointInScrollBlock);
        if (spot) {
          await page.mouse.move(spot.x, spot.y);
          await wheel(page, x, y);
        }
        const after = await loc.evaluate(scrollNearest, { x: 0, y: 0 }).catch(() => before);
        res = { ...after, movedX: after.posX - before.posX, movedY: after.posY - before.posY };
        if (res.movedX === 0 && res.movedY === 0 && (x !== 0 || y !== 0)) {
          // the wheel moved nothing (something else was under the pointer): scroll the block directly
          res = await loc.evaluate(scrollNearest, { x, y });
        }
      } else {
        res = await page.evaluate(scrollNearest, { x, y });
      }
      return actionResult(ctx, describeScroll(res, x, y));
    }

    case "press":
      await page.keyboard.press(String(input.key));
      await page.waitForTimeout(150).catch(() => {});
      return actionResult(ctx, `OK: pressed ${input.key}`);

    case "dismiss":
      // click an empty viewport corner = click-outside: closes dropdowns/popovers
      await page.mouse.click(5, 5);
      await page.waitForTimeout(150);
      return actionResult(ctx, "OK: clicked empty area to close any open overlay");

    case "wait_for": {
      const text = String(input.text ?? "").trim();
      if (!text) return { content: "Error: text is required — what should appear on the page." };
      const gone = input.gone === true;
      const seconds = Math.min(Math.max(Number(input.timeout_s) || 30, 1), 90);
      const started = Date.now();
      const target = page.getByText(text, { exact: false }).first();
      const ok = await target
        .waitFor({ state: gone ? "hidden" : "visible", timeout: seconds * 1000 })
        .then(() => true, () => false);
      const took = Math.round((Date.now() - started) / 1000);
      return actionResult(
        ctx,
        ok
          ? `OK: "${text}" ${gone ? "disappeared" : "appeared"} after ${took}s`
          : `TIMEOUT: "${text}" ${gone ? "is still there" : "did not appear"} after ${seconds}s — the page shown below is its current state`,
      );
    }

    case "wait": {
      const ms = Math.min(Number(input.ms) || 0, 10000);
      await page.waitForTimeout(ms);
      return actionResult(ctx, `OK: waited ${ms}ms`);
    }

    case "upload_file": {
      const files = ctx.files;
      if (files.length === 0) {
        return { content: "Error: no files are attached to this run — nothing to upload." };
      }
      const wanted = String(input.file ?? "").trim().toLowerCase();
      const file =
        files.find((f) => f.name.toLowerCase() === wanted) ??
        files.find((f) => f.name.toLowerCase().includes(wanted) && wanted.length > 2);
      if (!file) {
        return {
          content: `No attached file matches "${input.file}". Attached files: ${files
            .map((f) => f.name)
            .join(", ")}`,
        };
      }

      const ref = typeof input.ref === "string" ? input.ref.trim() : "";
      if (REF_RE.test(ref)) {
        const loc = page.locator(`aria-ref=${ref}`);
        if ((await loc.count()) === 0) {
          return { content: `ref ${ref} not found — take a fresh snapshot` };
        }
        const isFileInput = await loc
          .evaluate((el) => el instanceof HTMLInputElement && el.type === "file")
          .catch(() => false);
        if (isFileInput) {
          await loc.setInputFiles(file.path, { timeout: 5000 });
        } else {
          // a visible button/dropzone: clicking it opens the OS file dialog,
          // which Playwright intercepts as a filechooser event
          const [chooser] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 5000 }),
            loc.click({ timeout: 5000 }),
          ]);
          await chooser.setFiles(file.path);
        }
      } else {
        // No ref: real file inputs are usually hidden behind a styled button, so
        // they never show up in the snapshot and have no ref — find them by CSS.
        const inputs = page.locator('input[type="file"]');
        const total = await inputs.count();
        if (total === 0) {
          return {
            content:
              "No file input found on the page. If uploading starts from a button that opens the file dialog, call upload_file again with ref of that button.",
          };
        }
        let target = inputs.first();
        if (total > 1) {
          // several inputs — prefer the only visible one, else ask for a ref
          const visible: number[] = [];
          for (let i = 0; i < total; i++) {
            if (await inputs.nth(i).isVisible().catch(() => false)) visible.push(i);
          }
          if (visible.length !== 1) {
            return {
              content: `The page has ${total} file inputs and none is unambiguous. Call upload_file again with ref of the upload button/dropzone for the field you need.`,
            };
          }
          target = inputs.nth(visible[0]);
        }
        await target.setInputFiles(file.path, { timeout: 5000 });
      }

      return actionResult(
        ctx,
        `OK: attached ${file.name} to ${input.name ?? (ref || "the upload field")}`,
      );
    }

    case "note": {
      const text = String(input.text ?? "").trim();
      return { content: text ? "OK: noted — it stays in your context." : "Error: text is required." };
    }

    case "switch_tab": {
      const pages = ctx.context.pages();
      const target = pages[Number(input.index) - 1];
      if (!target) {
        return { content: `No tab ${input.index}. ${tabsLine(ctx) || "Only one tab is open."}` };
      }
      ctx.page = target;
      await target.bringToFront().catch(() => {});
      return actionResult(ctx, `OK: switched to tab ${input.index} (${target.url()})`);
    }

    case "handle_dialog": {
      const action = input.action === "dismiss" ? "dismiss" : "accept";
      const text = typeof input.text === "string" ? input.text : undefined;
      ctx.dialogPolicy = { action, text };
      return {
        content: `OK: the next dialog will be ${action === "dismiss" ? "dismissed (Cancel)" : `accepted (OK)${text ? ` with "${text}"` : ""}`}. Now do the action that opens it.`,
      };
    }

    case "mock_request": {
      const url = String(input.url ?? "").trim();
      if (!url) return { content: "Error: url is required — part of the request URL to intercept." };
      // models pass JSON either as a string or as an object — accept both
      const body =
        input.body === undefined || input.body === null
          ? undefined
          : typeof input.body === "string"
            ? input.body
            : JSON.stringify(input.body);
      let patch: unknown = input.patch;
      if (typeof patch === "string") {
        try {
          patch = JSON.parse(patch);
        } catch {
          return { content: "Error: patch must be JSON (an object or a list)." };
        }
      }
      const summary = await ctx.net.addMock({
        url,
        method: typeof input.method === "string" ? input.method : undefined,
        status: Number.isFinite(Number(input.status)) && input.status !== undefined ? Number(input.status) : undefined,
        body,
        contentType: typeof input.content_type === "string" ? input.content_type : undefined,
        patch: patch ?? undefined,
        abort: input.abort === true,
        delayMs: Number(input.delay_ms) || undefined,
      });
      return { content: `OK: ${summary}`, observation: `OK: ${summary.split("\n")[0]}` };
    }

    case "clear_mocks": {
      const report = ctx.net.describeMocks();
      const n = await ctx.net.clearMocks();
      return { content: `OK: removed ${n} mock(s).\n${report}`, observation: `Removed ${n} mock(s)` };
    }

    case "set_offline": {
      const offline = input.offline !== false;
      await ctx.context.setOffline(offline);
      return { content: `OK: the browser is now ${offline ? "OFFLINE — requests will fail" : "online"}.` };
    }

    case "get_requests": {
      const list = ctx.net.requests({
        find: String(input.find ?? input.url ?? "").trim() || undefined,
        method: typeof input.method === "string" ? input.method : undefined,
        failedOnly: input.failed_only === true,
        limit: Number(input.limit) || undefined,
      });
      const mocks = ctx.net.describeMocks();
      return {
        content: mocks === "No active mocks." ? list : `${list}\n\nActive mocks:\n${mocks}`,
        observation: list.split("\n")[0],
      };
    }

    case "get_console": {
      const errors = ctx.net.allConsoleErrors();
      return {
        content: errors.length
          ? `${errors.length} console error(s):\n${errors.map((e) => `- ${e}`).join("\n")}`
          : "No console errors so far.",
        observation: `${errors.length} console error(s)`,
      };
    }

    case "ask_user": {
      const prompt = String(input.prompt ?? "");
      const secret = Boolean(input.secret);
      const answer = await askQuestion(runId, prompt, secret);
      if (secret && answer) ctx.secrets.add(answer);
      return {
        content: answer,
        observation: secret ? "User entered a secret value" : `User replied: ${answer}`,
      };
    }

    case "report_step": {
      const status = input.status as ReportStatus;
      // The model sometimes sends no num, a null or a number outside the plan.
      // Taken at face value that step lands outside the plan as a stray card and
      // every later event loses its step, so fall back to the next unreported one.
      const plan = getRun(runId)?.steps ?? [];
      let num = Number(input.num);
      if (!Number.isInteger(num) || (plan.length > 0 && !plan.some((s) => s.num === num))) {
        num = ctx.step.current;
      }
      const planned = plan.find((s) => s.num === num);
      if (plan.length > 0 && !planned) {
        return {
          content: `Error: the plan has ${plan.length} steps and all of them are reported. Call finish.`,
        };
      }
      if (planned && planned.status !== "queued") {
        const next = plan.find((s) => s.status === "queued");
        return {
          content: `Error: step ${num} is already reported as ${planned.status} — each step is reported exactly once. ${next ? `Go on with step ${next.num}: "${next.description}".` : "All steps are reported — call finish."}`,
        };
      }
      // JPEG goes to the store and is served via a separate GET — never inlined in events/SSE
      let screenshot: string | undefined;
      if (status === "fail" || status === "warn") {
        const buf = await captureEvidence(page);
        if (buf) {
          saveScreenshot(runId, num, buf);
          screenshot = `/api/run/${runId}/shot/${num}`;
        }
      }
      const clean = (v: unknown) => redact(ctx, stripRefs(String(v))).trim();
      // console errors since the previous step: a note for the reader, not a verdict —
      // third-party scripts make most consoles noisy, so they never change the status
      const consoleErrors = ctx.net.takeConsoleErrors().slice(0, 5).map((e) => redact(ctx, e));
      const step = {
        num,
        // the card keeps the tester's wording from the plan unless the model says the step went differently
        description:
          (input.description ? clean(input.description).replace(/^\s*\d+[.)]\s*/, "") : "") ||
          planned?.description ||
          `Step ${num}`,
        status,
        expected: input.expected ? clean(input.expected) : undefined,
        evidence: input.evidence ? clean(input.evidence) : undefined,
        screenshot,
        consoleErrors: consoleErrors.length ? consoleErrors : undefined,
        // a made-up response body whose shape was never compared to a real one
        // answered a request on this step — the reader should know before trusting a fail
        mockUnverified: ctx.net.takeUnverifiedMockHits() > 0 || undefined,
      };
      pushEvent(runId, { ts: Date.now(), kind: "step", step, stepNum: num });
      // the next step to work on is the first one still queued, not blindly num + 1
      const upcoming = plan.find((s) => s.num !== num && s.status === "queued");
      ctx.step.current = upcoming?.num ?? num + 1;
      return {
        content: `OK: step ${step.num} = ${step.status}. ${upcoming ? `Next: step ${upcoming.num} — "${upcoming.description}".` : "That was the last step — call finish."}`,
      };
    }

    case "finish": {
      const status = (input.status as string) === "passed" ? "passed" : "failed";
      pushEvent(runId, {
        ts: Date.now(),
        kind: "done",
        status,
        summary: redact(ctx, stripRefs(String(input.summary ?? ""))),
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
      return c.length < 400 ? b : { ...b, content: `[…old tool output (page snapshot or request list), ${c.length} chars omitted]` };
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

/** Put what happened on its own (dialog, new tab) in front of the tool result, where the model reads first. */
function withNotices(ctx: ToolContext, content: string): string {
  if (ctx.notices.length === 0) return content;
  const notes = ctx.notices.splice(0).map((n) => `NOTE: ${n}`).join("\n");
  return `${notes}\n\n${content}`;
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
