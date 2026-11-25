// Acting on the page and reading it back: element lookup, tabs, dialogs, the
// result every page action returns.

import { type Locator, type Page } from "playwright";
import { pushEvent } from "../store";
import { readPage } from "./snapshot";
import { type RunEvent } from "../types";
import { REF_RE, type ToolContext, type ToolResult } from "./context";
import { pageText } from "./checks";

export async function locate(
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

/** Events that aren't tied to a tool call (a dialog, a new tab) — visible in the step log. */
export function note(ctx: ToolContext, text: string | null, info: NonNullable<RunEvent["info"]>): void {
  // null: the caller has put its own wording for the model into ctx.notices
  if (text !== null) ctx.notices.push(text);
  pushEvent(ctx.runId, { ts: Date.now(), kind: "info", text: text ?? undefined, info, stepNum: ctx.step.current });
}

export function tabsLine(ctx: ToolContext): string {
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
export async function adoptNewTab(ctx: ToolContext): Promise<void> {
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
export function wirePage(ctx: ToolContext, page: Page): void {
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

/**
 * Something has just been put into the page and is not visible yet (a toast
 * fading in): give it a moment, so that the page is read with it on screen.
 * On the real case the tree was taken 0.3 s after the response, the toast
 * became visible at 0.5 s, and the model was told "nothing changed".
 */
async function waitForAppearing(page: Page, maxMs = 1000): Promise<void> {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    const waiting = await page
      .evaluate(() => (window as unknown as { __qpilotPending?: () => number }).__qpilotPending?.() ?? 0)
      .catch(() => 0);
    if (!waiting) return;
    await page.waitForTimeout(120);
  }
}

// Tools after which "nothing happened" usually means a form refused to submit.
const SUBMITS = new Set(["click", "press", "click_at"]);

/**
 * Fields that would stop a form from being sent: invalid by the browser's own
 * rules, marked invalid or required by the page, or labelled with an asterisk
 * and left empty. A person sees the red border; the page tree has no such thing.
 * It is a reading of the markup, not a fact about the form's logic.
 */
async function blockingFields(page: Page): Promise<string[]> {
  return page
    .evaluate(() => {
      const out: string[] = [];
      const seen = new Set<Element>();
      const squash = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const isField = (el: Element | null | undefined): el is Field =>
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      // the text box of a custom dropdown is empty even when a value is chosen
      const picker = (el: Element) =>
        el.getAttribute("role") === "combobox" || el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-autocomplete") || (el as HTMLInputElement).readOnly === true;
      const empty = (el: Field) =>
        el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? !el.checked : !el.value.trim();
      const labelOf = (el: Element) => {
        const id = el.getAttribute("id");
        const own = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        return squash(
          el.getAttribute("aria-label") || own?.textContent || el.closest("label")?.textContent || el.getAttribute("placeholder") || el.getAttribute("name"),
        ).slice(0, 60);
      };
      const add = (el: Element, why: string, label?: string) => {
        if (seen.has(el) || !visible(el) || out.length >= 8) return;
        seen.add(el);
        out.push(`"${label || labelOf(el) || el.tagName.toLowerCase()}" — ${why}`);
      };
      for (const el of document.querySelectorAll("input, textarea, select")) {
        if (!isField(el) || el.disabled || (el as HTMLInputElement).type === "hidden") continue;
        if (!el.validity.valid) add(el, squash(el.validationMessage) || "invalid");
      }
      for (const el of document.querySelectorAll('[aria-invalid="true"]')) add(el, "marked invalid");
      for (const el of document.querySelectorAll('[required], [aria-required="true"]')) {
        if (isField(el) && !picker(el) && empty(el)) add(el, "required and empty");
      }
      for (const lab of document.querySelectorAll("label, legend")) {
        const text = squash(lab.textContent);
        if (!/\*$/.test(text) || text.length > 80) continue;
        const forId = lab.getAttribute("for");
        const ctl = (forId && document.getElementById(forId)) || lab.querySelector("input, textarea, select") || lab.parentElement?.querySelector("input, textarea, select");
        if (isField(ctl) && !ctl.disabled && !picker(ctl) && empty(ctl)) add(ctl, "marked required (*) and empty", text.slice(0, 60));
      }
      return out;
    })
    .catch(() => []);
}

/**
 * What the action led to, in the words a tester would use: which requests went
 * out and how they were answered, what the console said, and — when nothing
 * happened at all — what in the form may be holding it back. Without this the
 * model got "OK: clicked Save" and an unchanged tree, and pressed Save again.
 */
async function outcome(ctx: ToolContext, unchanged: boolean | null): Promise<{ text: string; brief: string; effect?: boolean }> {
  const since = ctx.net.sinceMark();
  const lines: string[] = [];
  let brief: string;
  if (since.total === 0) {
    brief = unchanged ? "no request sent, page unchanged" : unchanged === false ? "no request sent, page changed" : "no request sent";
    lines.push(
      unchanged
        ? "After this action: no request was sent and the page did not change (keyboard focus aside) — it had no effect."
        : "After this action: no request was sent.",
    );
  } else {
    const more = since.total > since.requests.length ? ` (+${since.total - since.requests.length} more — get_requests lists them)` : "";
    lines.push(`After this action: ${since.total} request(s) sent${more}:\n${since.requests.map((r) => `  ${r}`).join("\n")}`);
    brief = since.requests[0].replace(/^#\d+ (\S+ \S+ → \S+).*$/s, "$1") + (since.total > 1 ? ` (+${since.total - 1})` : "") + (unchanged ? ", page unchanged" : "");
  }
  if (since.consoleErrors.length) lines.push(`New console errors: ${since.consoleErrors.join(" | ")}`);
  // nothing but an analytics beacon went out: the form still did not submit
  if (since.calls === 0 && unchanged && SUBMITS.has(ctx.tool)) {
    const fields = await blockingFields(ctx.page);
    if (fields.length) {
      lines.push(`Fields that look required but are empty or invalid (read from the markup — the form may be waiting for them): ${fields.join("; ")}`);
      brief += `; ${fields.length} field(s) look unfilled`;
    }
  }
  return { text: lines.join("\n"), brief, effect: unchanged === null ? undefined : !(since.total === 0 && unchanged) };
}

// Return a fresh snapshot in the SAME result as the action — this removes the
// separate snapshot call after every action and roughly halves iterations per
// step. Only the short observation goes to events/SSE; the tree goes to the model.
export async function actionResult(ctx: ToolContext, msg: string): Promise<ToolResult> {
  await adoptNewTab(ctx);
  // let the page answer before reading it: a snapshot taken right after a click
  // shows the old page or a loader, and the model takes that for a failure
  await ctx.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
  if (!ctx.wantTree) {
    // not the last action of the turn: the next one follows at once, and reading
    // the page here would cost a snapshot nobody looks at
    await ctx.net.waitForQuiet(ctx.actionStarted, 1200);
    const done = await outcome(ctx, null);
    return {
      content: `${msg}\n${done.text}\n(the page tree comes with the last action of this turn)`,
      observation: msg,
      brief: `${msg} → ${done.brief}`,
    };
  }
  await ctx.net.waitForQuiet(ctx.actionStarted, 4000);
  await waitForAppearing(ctx.page);
  const read = await readPage(ctx.page).catch(() => null);
  const tree = read?.view ?? "";
  const tabs = tabsLine(ctx);
  const before = ctx.lastFull;
  const changes = read ? describeChanges(before, read.full) : "";
  if (read) {
    ctx.lastTree = read.view;
    ctx.lastFull = read.full;
  }
  // what the page said at this moment of the step, for checks made when it has moved on
  const said = await pageText(ctx);
  if (said) ctx.seenTexts = [...ctx.seenTexts.slice(-(MAX_SEEN_TEXTS - 1)), said.slice(0, MAX_SEEN_CHARS)];
  // a click moves keyboard focus to what was clicked; that alone is not the page answering
  const unchanged = read ? changes.startsWith(NO_CHANGES) || sameButFocus(before, read.full) : null;
  // the first look at a page has nothing to compare with: that is not "unchanged"
  const done = await outcome(ctx, changes ? unchanged : null);
  const body = [`${msg}\n${done.text}`, tabs, changes, tree].filter(Boolean).join("\n\n");
  return { content: body, observation: msg, brief: `${msg} → ${done.brief}`, effect: done.effect };
}

/** True when two page trees differ only in which element has keyboard focus. */
function sameButFocus(before: string | null, after: string): boolean {
  if (before === null) return false;
  const plain = (t: string) => t.replace(/\s*\[ref=[^\]]+\]/g, "").replace(/ \[active\]/g, "");
  return plain(before) === plain(after);
}

// the states of a step a check can look back at
const MAX_SEEN_TEXTS = 12;
const MAX_SEEN_CHARS = 30_000;

export const MAX_CHANGE_LINES = 40;
const NO_CHANGES = "Changes since the previous page tree: NONE";

/**
 * What the action changed on the page, as removed (−) and added (+) lines of the
 * page tree. Spotting that one "[checked]" went missing among hundreds of lines
 * is exactly where a model slips, and "did the state change?" is what most
 * steps ask — so the comparison is done here and handed over ready.
 */
export function describeChanges(before: string | null, after: string): string {
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
    return `${NO_CHANGES} — the page looks exactly as before.`;
  }
  const lines = [...removed.map((l) => `− ${l}`), ...added.map((l) => `+ ${l}`)];
  const shown = lines.slice(0, MAX_CHANGE_LINES);
  const more = lines.length > shown.length ? `\n… and ${lines.length - shown.length} more changed lines` : "";
  return `Changes since the previous page tree (− was, + is now):\n${shown.join("\n")}${more}`;
}

/** Put what happened on its own (dialog, new tab) in front of the tool result, where the model reads first. */
export function withNotices(ctx: ToolContext, content: string): string {
  if (ctx.notices.length === 0) return content;
  const notes = ctx.notices.splice(0).map((n) => `NOTE: ${n}`).join("\n");
  return `${notes}\n\n${content}`;
}

// Wraps click/fill: when an overlay intercepts the click ("intercepts pointer
// events"), return a short directive instead of Playwright's wall of log text —
// otherwise the model keeps repeating the same failing click.
export async function clickWithHint(action: () => Promise<void>): Promise<void> {
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

export async function captureEvidence(page: Page): Promise<Buffer | undefined> {
  try {
    return await page.screenshot({ type: "jpeg", quality: 55 });
  } catch {
    return undefined;
  }
}
