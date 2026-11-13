// Tools that act on the page.

import { type Locator, type Page } from "playwright";
import { findAnchor, snapshot } from "../snapshot";
import { REF_RE } from "../context";
import { actionResult, clickWithHint, locate, tabsLine } from "../page";
import { type ScrollResult, describeScroll, pointInScrollBlock, scrollNearest, wheel } from "../scroll";
import { type ToolDef, ref, label } from "../tool";

export const actionsTools: ToolDef[] = [
  {
    schema: {
      name: "navigate",
      description: "Open a URL. Returns the page tree.",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    page: true,
    run: async (input, ctx) => {
      const { page } = ctx;
      await page.goto(String(input.url), {
        waitUntil: "domcontentloaded",
        timeout: 60000, // slow networks and VPNs: 20s was not enough for a first load
      });
      return actionResult(ctx, `OK: navigated to ${input.url}`);
    },
  },

  {
    schema: {
      name: "snapshot",
      description:
        "Read the page tree again. Rarely needed: every action already returns it. Use near to get only the block around a text (never truncated, disambiguates repeated labels), or when a result came without a tree.",
      input_schema: {
        type: "object",
        properties: {
          near: { type: "string", description: "Visible text of a heading or block to zoom into, e.g. 'Top ads'." },
        },
      },
    },
    run: async (input, ctx) => {
      const { page } = ctx;
      const tree = await snapshot(
        page,
        typeof input.near === "string" ? input.near : undefined,
      );
      if (typeof input.near !== "string") ctx.lastTree = tree;
      // don't push the full tree to events/SSE — the UI doesn't render it anyway
      return { content: tree, observation: `Page read (${tree.length} chars)` };
    },
  },

  {
    schema: {
      name: "click",
      description:
        "Click an element (its centre). With dx/dy the click lands that many pixels away from the centre, on whatever is there — for clicking NEXT TO an element.",
      input_schema: {
        type: "object",
        properties: {
          ref: ref(),
          name: label,
          dx: { type: "number", description: "Offset from the centre in px, positive = right." },
          dy: { type: "number", description: "Offset from the centre in px, positive = down." },
        },
        required: ["ref"],
      },
    },
    page: true,
    run: async (input, ctx) => {
      const { page } = ctx;
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
    },
  },

  {
    schema: {
      name: "fill",
      description: "Type text into a field, replacing what is there.",
      input_schema: {
        type: "object",
        properties: { ref: ref("Field"), value: { type: "string" }, name: label },
        required: ["ref", "value"],
      },
    },
    page: true,
    run: async (input, ctx) => {
      const { page } = ctx;
      const loc = await locate(page, input);
      await clickWithHint(() => loc.fill(String(input.value), { timeout: 5000 }));
      return actionResult(ctx, `OK: filled "${input.value}" into ${input.name ?? input.ref}`);
    },
  },

  {
    schema: {
      name: "select",
      description: "Choose an option of a <select> dropdown, by its value or visible label.",
      input_schema: {
        type: "object",
        properties: { ref: ref("<select>"), value: { type: "string" }, name: label },
        required: ["ref", "value"],
      },
    },
    page: true,
    run: async (input, ctx) => {
      const { page } = ctx;
      const loc = await locate(page, input);
      const val = String(input.value);
      // try by value first, fall back to visible label
      try {
        await loc.selectOption(val, { timeout: 5000 });
      } catch {
        await loc.selectOption({ label: val }, { timeout: 5000 });
      }
      return actionResult(ctx, `OK: selected "${val}" in ${input.name ?? input.ref}`);
    },
  },

  {
    schema: {
      name: "hover",
      description:
        "Move the mouse over an element — for anything that opens on hover (notification bell, avatar menu, tooltip, submenu). The result shows the opened panel.",
      input_schema: { type: "object", properties: { ref: ref(), name: label }, required: ["ref"] },
    },
    page: true,
    run: async (input, ctx) => {
      const { page } = ctx;
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
    },
  },

  {
    schema: {
      name: "scroll_to",
      description: "Scroll until an element is visible, whatever container holds it. Target by text or ref.",
      input_schema: {
        type: "object",
        properties: { text: { type: "string" }, ref: ref() },
      },
    },
    page: true,
    run: async (input, ctx) => {
      const { page } = ctx;
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
    },
  },

  {
    schema: {
      name: "scroll",
      description:
        "Scroll by pixels. Without ref — the window. With ref of any element inside a scrollable block — moves the mouse over that element and turns the wheel, so the block scrolls like under a person's hand and a hover-opened panel stays open. Returns position and limits ('bottom reached'). Only for lazy-loaded content: scrolling never adds existing elements to the page tree.",
      input_schema: {
        type: "object",
        properties: {
          y: { type: "number", description: "Positive = down." },
          x: { type: "number", description: "Positive = right." },
          ref: ref("Any element inside the block to scroll"),
        },
      },
    },
    page: true,
    run: async (input, ctx) => {
      const { page } = ctx;
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
    },
  },

  {
    schema: {
      name: "press",
      description: "Press a key: Enter, Tab, Escape, ArrowDown…",
      input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
    page: true,
    run: async (input, ctx) => {
      const { page } = ctx;
      await page.keyboard.press(String(input.key));
      await page.waitForTimeout(150).catch(() => {});
      return actionResult(ctx, `OK: pressed ${input.key}`);
    },
  },

  {
    schema: {
      name: "dismiss",
      description: "Close an open dropdown/popover by clicking an empty corner of the page. Use when a click fails with 'intercepts pointer events'.",
      input_schema: { type: "object", properties: {} },
    },
    page: true,
    run: async (input, ctx) => {
      const { page } = ctx;
      // click an empty viewport corner = click-outside: closes dropdowns/popovers
      await page.mouse.click(5, 5);
      await page.waitForTimeout(150);
      return actionResult(ctx, "OK: clicked empty area to close any open overlay");
    },
  },

  {
    schema: {
      name: "wait_for",
      description:
        "Wait until a text appears (or, with gone=true, disappears) — for slow pages that still show the old state or a loader. Returns as soon as it happens, with the page tree.",
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text the expected state must show, e.g. a heading." },
          gone: { type: "boolean" },
          timeout_s: { type: "number", description: "Default 30, max 90." },
        },
        required: ["text"],
      },
    },
    page: true,
    run: async (input, ctx) => {
      const { page } = ctx;
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
    },
  },

  {
    schema: {
      name: "wait",
      description: "Wait N ms (max 10000). Prefer wait_for when you know what should appear.",
      input_schema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
    },
    page: true,
    run: async (input, ctx) => {
      const { page } = ctx;
      const ms = Math.min(Number(input.ms) || 0, 10000);
      await page.waitForTimeout(ms);
      return actionResult(ctx, `OK: waited ${ms}ms`);
    },
  },

  {
    schema: {
      name: "upload_file",
      description:
        "Give one of the run's attached files to an upload control. Omit ref first (file inputs are usually hidden); pass ref of the file input or of the button/dropzone only if that fails. You cannot see the file's contents.",
      input_schema: {
        type: "object",
        properties: {
          file: { type: "string", description: "Name of an attached file, as listed." },
          ref: ref("File input or upload button"),
          name: label,
        },
        required: ["file"],
      },
    },
    page: true,
    run: async (input, ctx) => {
      const { page } = ctx;
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
    },
  },

  {
    schema: {
      name: "switch_tab",
      description: "Switch to another open tab by its number from the Tabs line. You are moved to a newly opened tab automatically.",
      input_schema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
    },
    page: true,
    run: async (input, ctx) => {
      const pages = ctx.context.pages();
      const target = pages[Number(input.index) - 1];
      if (!target) {
        return { content: `No tab ${input.index}. ${tabsLine(ctx) || "Only one tab is open."}` };
      }
      ctx.page = target;
      await target.bringToFront().catch(() => {});
      return actionResult(ctx, `OK: switched to tab ${input.index} (${target.url()})`);
    },
  },

  {
    schema: {
      name: "handle_dialog",
      description:
        "Set what happens to the NEXT native dialog (alert/confirm/prompt). Dialogs are accepted by default; call this BEFORE the action that opens one to press Cancel or to type into a prompt.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["accept", "dismiss"] },
          text: { type: "string", description: "Text to type into a prompt()." },
        },
        required: ["action"],
      },
    },
    run: async (input, ctx) => {
      const action = input.action === "dismiss" ? "dismiss" : "accept";
      const text = typeof input.text === "string" ? input.text : undefined;
      ctx.dialogPolicy = { action, text };
      return {
        content: `OK: the next dialog will be ${action === "dismiss" ? "dismissed (Cancel)" : `accepted (OK)${text ? ` with "${text}"` : ""}`}. Now do the action that opens it.`,
      };
    },
  },

  {
    schema: {
      name: "look",
      description:
        "Take a screenshot of the visible part of the page and see it. For what the page tree cannot tell: how something looks (colour, size, position, overlap), an image, a chart, a canvas, an icon without a name. The tree stays the main source — it is faster and exact; do not look after every action.",
      input_schema: {
        type: "object",
        properties: {
          why: { type: "string", description: "What you want to see, in a few words — for the log." },
        },
      },
    },
    vision: true,
    run: async (_input, ctx) => {
      const { page } = ctx;
      const image = await page.screenshot({ type: "jpeg", quality: 60 });
      const { width, height } = viewportOf(page);
      return {
        content: `Screenshot of the visible part of the page: ${width}×${height} px, (0, 0) is its top-left corner. Use these coordinates with click_at / hover_at. What is below the fold is not in it — scroll first.`,
        image,
        observation: `Looked at the page (screenshot ${width}×${height})`,
      };
    },
  },

  {
    schema: {
      name: "measure",
      description:
        "Exact geometry and colours of elements, measured in the browser: position, size, colours, font size, whether something covers the element, and whether the given elements overlap or how far apart they are. Use it for checks of size, position, alignment, overlap and colour — numbers, where a screenshot is only an impression.",
      input_schema: {
        type: "object",
        properties: {
          refs: { type: "array", items: { type: "string" }, description: "Refs of the elements to measure, e.g. [\"e12\", \"e13\"]. Up to 8." },
        },
        required: ["refs"],
      },
    },
    vision: true,
    run: async (input, ctx) => {
      const { page } = ctx;
      const refs = (Array.isArray(input.refs) ? input.refs : [input.refs])
        .map((r) => String(r ?? "").trim())
        .filter((r) => REF_RE.test(r))
        .slice(0, 8);
      if (refs.length === 0) return { content: "Error: refs is required — refs of the elements to measure, from the latest page tree." };

      const measured: Array<{ ref: string; m: Measured }> = [];
      const missing: string[] = [];
      for (const r of refs) {
        const loc = page.locator(`aria-ref=${r}`);
        if ((await loc.count()) === 0) missing.push(r);
        else measured.push({ ref: r, m: await loc.evaluate(measureElement) });
      }

      const lines = measured.map(({ ref: r, m }) => {
        const state = !m.visible
          ? "NOT VISIBLE"
          : m.coveredBy
            ? `its centre is COVERED by ${m.coveredBy}`
            : m.inViewport ? "visible" : "outside the visible part of the page";
        return `${r} ${m.label}: left ${m.x}, top ${m.y}, ${m.w}×${m.h} px; background ${describeColor(m.background)}, text ${describeColor(m.color)}, font ${m.font}; ${state}`;
      });
      for (let i = 0; i < measured.length; i++) {
        for (let j = i + 1; j < measured.length; j++) {
          lines.push(`${measured[i].ref} and ${measured[j].ref}: ${relation(measured[i].m, measured[j].m)}`);
        }
      }
      if (missing.length) lines.push(`Not found (take refs from the latest page tree): ${missing.join(", ")}`);
      return { content: lines.join("\n"), observation: `Measured ${measured.length} element(s)` };
    },
  },

  {
    schema: {
      name: "click_at",
      description:
        "Click a point of the visible page by coordinates taken from a look screenshot — for things with no ref: a canvas, a map, a chart, an icon you recognised by sight. When the element has a ref, use click.",
      input_schema: {
        type: "object",
        properties: {
          x: { type: "number", description: "Pixels from the left edge of the screenshot." },
          y: { type: "number", description: "Pixels from the top edge of the screenshot." },
          name: label,
        },
        required: ["x", "y"],
      },
    },
    page: true,
    vision: true,
    run: async (input, ctx) => {
      const { page } = ctx;
      const at = pointOf(page, input);
      if (typeof at === "string") return { content: at };
      await page.mouse.click(at.x, at.y);
      await page.waitForTimeout(150).catch(() => {});
      return actionResult(ctx, `OK: clicked at (${at.x}, ${at.y})${input.name ? ` — ${input.name}` : ""}`);
    },
  },

  {
    schema: {
      name: "hover_at",
      description:
        "Move the mouse to a point of the visible page by coordinates taken from a look screenshot — for a hover target with no ref. When the element has a ref, use hover.",
      input_schema: {
        type: "object",
        properties: {
          x: { type: "number", description: "Pixels from the left edge of the screenshot." },
          y: { type: "number", description: "Pixels from the top edge of the screenshot." },
          name: label,
        },
        required: ["x", "y"],
      },
    },
    page: true,
    vision: true,
    run: async (input, ctx) => {
      const { page } = ctx;
      const at = pointOf(page, input);
      if (typeof at === "string") return { content: at };
      await page.mouse.move(at.x, at.y);
      await page.mouse.move(at.x + 1, at.y + 1);
      await page.waitForTimeout(600).catch(() => {});
      return actionResult(ctx, `OK: hovered at (${at.x}, ${at.y})${input.name ? ` — ${input.name}` : ""}`);
    },
  },
];

function viewportOf(page: Page): { width: number; height: number } {
  return page.viewportSize() ?? { width: 1440, height: 900 };
}

/** The point a coordinate tool was given, or what is wrong with it. */
function pointOf(page: Page, input: Record<string, unknown>): { x: number; y: number } | string {
  const x = Math.round(Number(input.x));
  const y = Math.round(Number(input.y));
  const { width, height } = viewportOf(page);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "Error: x and y are required, in pixels of the look screenshot.";
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return `Error: (${x}, ${y}) is outside the ${width}×${height} screenshot. Take the coordinates from the latest look.`;
  }
  return { x, y };
}

interface Measured {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  background: string;
  font: string;
  visible: boolean;
  inViewport: boolean;
  coveredBy: string | null;
}

/** Runs IN THE BROWSER: what a person with a ruler and a colour picker would note about an element. */
function measureElement(el: Element): Measured {
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  const describe = (e: Element) => {
    const text = (e.getAttribute("aria-label") || (e as HTMLElement).innerText || "").trim().replace(/\s+/g, " ").slice(0, 30);
    return `<${e.tagName.toLowerCase()}>${text ? ` "${text}"` : ""}`;
  };
  // the colour actually behind the element: the first ancestor that paints one
  let background = "rgba(0, 0, 0, 0)";
  for (let n: Element | null = el; n; n = n.parentElement) {
    const bg = getComputedStyle(n).backgroundColor;
    if (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) {
      background = bg;
      break;
    }
  }
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const inViewport = cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight;
  const top = inViewport ? document.elementFromPoint(cx, cy) : null;
  const covered = top && top !== el && !el.contains(top) && !top.contains(el) ? describe(top) : null;
  return {
    label: describe(el),
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
    color: st.color,
    background,
    font: `${st.fontSize}${Number(st.fontWeight) >= 600 ? " bold" : ""}`,
    visible: r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0,
    inViewport,
    coveredBy: covered,
  };
}

/** "rgb(211, 47, 47)" → "rgb(211, 47, 47) (red)": the number for exact checks, the word for plain ones. */
function describeColor(css: string): string {
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return css;
  if (m[4] !== undefined && Number(m[4]) === 0) return "none (transparent)";
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let name: string;
  if (max - min < 28) name = max < 60 ? "black" : max > 215 ? "white" : "gray";
  else {
    const d = max - min;
    const hue = (max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
    name =
      hue < 15 || hue >= 345 ? "red" : hue < 45 ? "orange" : hue < 70 ? "yellow" : hue < 165 ? "green"
      : hue < 200 ? "cyan" : hue < 260 ? "blue" : hue < 300 ? "purple" : "pink";
  }
  return `${css} (${name})`;
}

/** Do two boxes overlap, and if not, how far apart are they? */
function relation(a: Measured, b: Measured): string {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (ox > 0 && oy > 0) return `OVERLAP by ${ox}×${oy} px`;
  const parts: string[] = [];
  if (ox <= 0) parts.push(`${-ox} px apart horizontally`);
  if (oy <= 0) parts.push(`${-oy} px apart vertically`);
  const aligned = [
    a.y === b.y ? "tops aligned" : "",
    a.x === b.x ? "left edges aligned" : "",
    a.h === b.h ? "same height" : "",
    a.w === b.w ? "same width" : "",
  ].filter(Boolean);
  return `no overlap, ${parts.join(" and ")}${aligned.length ? `; ${aligned.join(", ")}` : ""}`;
}
