// What shows up on the page and vanishes on its own: a toast, an alert, an
// error line under a field, a "Saved" mark next to a button.
//
// "Save failed" slides in for three seconds and is gone before the model's next
// look: the tree is read after the page settles and the model takes ten seconds
// a turn, so it reported "nothing happened" and the screenshot showed a clean
// page. A person sees the toast because they are watching the whole time. So
// the page is watched from inside: the text is kept and a screenshot is taken
// the moment the message appears.

import { type Page } from "playwright";
import { type ToolContext } from "./context";
import { captureEvidence, note } from "./page";
import { redact } from "./redact";

export const FLASH_NOTE = "Appeared on the page and vanished on its own";
// a carousel or a ticker shows the same text again and again: say it twice on a step, then stop
const SAME_TEXT_TIMES = 2;
const MAX_UNREAD = 5;
const MAX_SHOTS = 6;
const SHOT_EVERY_MS = 700;

type Report = { kind: "appeared" | "vanished"; id: number; text: string };

/** Runs in every frame of the page before its own scripts. */
function watchInPage(): void {
  const w = window as unknown as {
    __qpilotFlash?: (r: Report) => void;
    __qpilotWatching?: boolean;
    __qpilotPending?: () => number;
  };
  if (w.__qpilotWatching) return;
  w.__qpilotWatching = true;

  const NAMED = /toast|snack|notif|alert|flash|message/i;
  const MAX_TRACKED = 150;
  const tracked: { el: Element; id: number; text: string; at: number; named: boolean; floating: boolean }[] = [];
  // inserted but not shown yet: a toast is put into the page transparent and
  // with no height, and fades in half a second later
  const pending: { node: Node; at: number }[] = [];
  const PENDING_MS = 1500;
  w.__qpilotPending = () => pending.length;
  let lastInput = 0;
  let nextId = 1;
  for (const type of ["pointerdown", "keydown", "wheel"]) {
    window.addEventListener(type, () => (lastInput = Date.now()), { capture: true, passive: true });
  }
  // the browser sends a mousemove of its own when the layout changes under a
  // still pointer: only a move to another point is somebody's hand
  let mx = -1;
  let my = -1;
  window.addEventListener(
    "mousemove",
    (e) => {
      if (e.clientX !== mx || e.clientY !== my) lastInput = Date.now();
      mx = e.clientX;
      my = e.clientY;
    },
    { capture: true, passive: true },
  );
  const send = (r: Report) => {
    try {
      w.__qpilotFlash?.(r);
    } catch {}
  };
  const onScreen = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  const exists = (el: Element) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  // anything that appears may vanish again, but two kinds are told apart: what
  // calls itself a message (role, aria-live, a telling class) and what floats
  // over the page. They are kept longer and never pushed out by plain content.
  const kind = (el: Element): { named: boolean; floating: boolean } => {
    let floating = false;
    let named = false;
    for (let n: Element | null = el, i = 0; n && n !== document.documentElement && i < 6; n = n.parentElement, i++) {
      const role = n.getAttribute("role");
      const live = n.getAttribute("aria-live");
      if (role === "alert" || role === "status" || (live && live !== "off")) named = true;
      if (i < 3 && NAMED.test(`${typeof n.className === "string" ? n.className : ""} ${n.id} ${n.getAttribute("data-testid") ?? ""}`)) named = true;
      const pos = getComputedStyle(n).position;
      if (pos === "fixed" || pos === "sticky") floating = true;
    }
    return { named, floating };
  };
  const consider = (node: Node, again = false) => {
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!el || !el.isConnected) return;
    const text = ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 3 || text.length > 400) return;
    const k = kind(el);
    if (!exists(el) || !onScreen(el)) {
      // looked at again on the next ticks; plain content that is not visible
      // (a closed accordion, a tab that is not selected) is not waited for
      if (!again && (k.named || k.floating) && pending.length < 40) pending.push({ node, at: Date.now() });
      return;
    }
    if (again) pending.splice(pending.findIndex((p) => p.node === node), 1);
    const plain = !k.named && !k.floating;
    if (tracked.length >= MAX_TRACKED) {
      // a page that has just rendered fills the list with content that will stay
      const oldest = tracked.findIndex((t) => !t.named && !t.floating);
      if (oldest < 0 || (plain && tracked.length >= MAX_TRACKED + 40)) return;
      tracked.splice(oldest, 1);
    }
    const r = el.getBoundingClientRect();
    if (r.width * r.height > innerWidth * innerHeight * 0.35) return; // a page section, not a message
    if (tracked.some((t) => t.text === text || t.el.contains(el) || el.contains(t.el))) return;
    const item = { el, id: nextId++, text: text.slice(0, 300), at: Date.now(), ...k };
    tracked.push(item);
    send({ kind: "appeared", id: item.id, text: item.text });
  };

  const start = () => {
    new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === "characterData") consider(rec.target);
        else for (const n of rec.addedNodes) consider(n);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    setInterval(() => {
      const now = Date.now();
      // read once per tick and only if something went away
      let pageText: string | null = null;
      // the node itself may still be in the page, faded out and waiting to be
      // removed: its own copy of the words does not count
      const stillThere = (text: string, own: number) => {
        pageText ??= (document.body?.innerText ?? "").replace(/\s+/g, " ");
        return pageText.split(text).length - 1 > own;
      };
      for (const p of [...pending]) {
        consider(p.node, true);
        const i = pending.indexOf(p);
        if (i >= 0 && now - p.at > PENDING_MS) pending.splice(i, 1);
      }
      for (let i = tracked.length - 1; i >= 0; i--) {
        const t = tracked[i];
        const text = ((t.el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
        // sliding off the screen is how a floating message leaves; anything else
        // that is off screen has merely been scrolled away
        if (exists(t.el) && text.length >= 3 && (onScreen(t.el) || !t.floating)) {
          // it stays: the page tree shows it
          if (now - t.at > (t.named || t.floating ? 30000 : 12000)) tracked.splice(i, 1);
          continue;
        }
        tracked.splice(i, 1);
        // a menu or a tooltip closes because of a click or a mouse move; a toast
        // goes away with nobody touching anything
        // (one that calls itself an alert is believed even if the agent has moved on)
        // (<=: the click that made it appear can carry the same millisecond)
        const onItsOwn = lastInput <= t.at;
        const life = now - t.at;
        if (life < 300 || !(onItsOwn || (t.named && life <= 8000))) continue;
        // a re-render swaps the node for a new one with the same words: nothing vanished
        const own = t.el.isConnected && ((t.el as HTMLElement).innerText ?? "").includes(t.text) ? 1 : 0;
        if (stillThere(t.text, own)) continue;
        send({ kind: "vanished", id: t.id, text: t.text });
      }
    }, 250);
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start);
}

/** Watch every page of the run for short-lived messages. Call once, before the first navigation. */
export async function watchFlashes(ctx: ToolContext): Promise<void> {
  const shots = new Map<number, Buffer>();
  const told = new Map<string, number>();
  let lastShot = 0;
  await ctx.context.exposeBinding("__qpilotFlash", async ({ page }: { page: Page }, r: Report) => {
    if (!r || typeof r.id !== "number" || typeof r.text !== "string") return;
    if (r.kind === "appeared") {
      // most things that appear are menus and never get reported: keep the cost low
      if (Date.now() - lastShot < SHOT_EVERY_MS) return;
      lastShot = Date.now();
      const shot = await captureEvidence(page);
      if (!shot) return;
      shots.set(r.id, shot);
      if (shots.size > MAX_SHOTS) shots.delete(shots.keys().next().value as number);
      return;
    }
    const text = r.text.slice(0, 300);
    const shot = shots.get(r.id);
    shots.delete(r.id);
    // counted per step: the same "Could not save" on a later step is news again
    const key = `${ctx.step.current}|${text}`;
    const times = (told.get(key) ?? 0) + 1;
    told.set(key, times);
    if (times > SAME_TEXT_TIMES) return;
    if (ctx.notices.filter((n) => n.startsWith(FLASH_NOTE)).length >= MAX_UNREAD) return;
    if (shot) ctx.flashShot = shot;
    // the model reads the message as it was; the log gets the masked copy
    ctx.notices.push(`${FLASH_NOTE}: "${text}". It is no longer in the page tree — this is what it said.`);
    note(ctx, null, { type: "flash", message: redact(ctx, text) });
  });
  await ctx.context.addInitScript(watchInPage);
}
