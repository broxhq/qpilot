// Acting on the page and reading it back: element lookup, tabs, dialogs, the
// result every page action returns.

import { type Browser, type Locator, type Page } from "playwright";
import { pushEvent } from "../store";
import { snapshot } from "../tools";
import { type RunEvent } from "../types";
import { REF_RE, type ToolContext, type ToolResult } from "./context";

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
export function note(ctx: ToolContext, text: string, info: NonNullable<RunEvent["info"]>): void {
  ctx.notices.push(text);
  pushEvent(ctx.runId, { ts: Date.now(), kind: "info", text, info, stepNum: ctx.step.current });
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

export const MAX_CHANGE_LINES = 40;

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
    return "Changes since the previous page tree: NONE — the page looks exactly as before.";
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
