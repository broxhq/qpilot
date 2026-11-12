// Scrolling: the in-browser helpers and the wheel.

import { type Page } from "playwright";

export type ScrollResult = {
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
export function scrollNearest(
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

/**
 * Runs IN THE BROWSER. A point inside the visible part of the nearest scrollable
 * ancestor of the element — where a person would rest the pointer to scroll that
 * block. The element itself may be scrolled out of view, so its own position is
 * no use. null when the block is the page itself.
 */
export function pointInScrollBlock(el: Element): { x: number; y: number } | null {
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
export async function wheel(page: Page, dx: number, dy: number): Promise<void> {
  const steps = Math.min(40, Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 120)));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(dx / steps, dy / steps);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(250); // smooth scrolling and scroll handlers
}

// Human/model-readable summary: how far it moved, current position vs. limit,
// and hints when nothing happened (likely an inner scroll container).
export function describeScroll(r: ScrollResult, reqX: number, reqY: number): string {
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
