// Tools that act on the page.

import { type Locator, type Page } from "playwright";
import { findAnchor, snapshot } from "../../tools";
import { type Handlers, REF_RE } from "../context";
import { actionResult, clickWithHint, locate, tabsLine } from "../page";
import { type ScrollResult, describeScroll, pointInScrollBlock, scrollNearest, wheel } from "../scroll";

export const actionHandlers: Handlers = {
  navigate: async (input, ctx) => {
    const { page } = ctx;
    await page.goto(String(input.url), {
      waitUntil: "domcontentloaded",
      timeout: 60000, // slow networks and VPNs: 20s was not enough for a first load
    });
    return actionResult(ctx, `OK: navigated to ${input.url}`);
  },

  snapshot: async (input, ctx) => {
    const { page } = ctx;
    const tree = await snapshot(
      page,
      typeof input.near === "string" ? input.near : undefined,
    );
    if (typeof input.near !== "string") ctx.lastTree = tree;
    // don't push the full tree to events/SSE — the UI doesn't render it anyway
    return { content: tree, observation: `Page read (${tree.length} chars)` };
  },

  click: async (input, ctx) => {
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

  fill: async (input, ctx) => {
    const { page } = ctx;
    const loc = await locate(page, input);
    await clickWithHint(() => loc.fill(String(input.value), { timeout: 5000 }));
    return actionResult(ctx, `OK: filled "${input.value}" into ${input.name ?? input.ref}`);
  },

  select: async (input, ctx) => {
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

  hover: async (input, ctx) => {
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

  scroll_to: async (input, ctx) => {
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

  scroll: async (input, ctx) => {
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

  press: async (input, ctx) => {
    const { page } = ctx;
    await page.keyboard.press(String(input.key));
    await page.waitForTimeout(150).catch(() => {});
    return actionResult(ctx, `OK: pressed ${input.key}`);
  },

  dismiss: async (input, ctx) => {
    const { page } = ctx;
    // click an empty viewport corner = click-outside: closes dropdowns/popovers
    await page.mouse.click(5, 5);
    await page.waitForTimeout(150);
    return actionResult(ctx, "OK: clicked empty area to close any open overlay");
  },

  wait_for: async (input, ctx) => {
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

  wait: async (input, ctx) => {
    const { page } = ctx;
    const ms = Math.min(Number(input.ms) || 0, 10000);
    await page.waitForTimeout(ms);
    return actionResult(ctx, `OK: waited ${ms}ms`);
  },

  upload_file: async (input, ctx) => {
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

  switch_tab: async (input, ctx) => {
    const pages = ctx.context.pages();
    const target = pages[Number(input.index) - 1];
    if (!target) {
      return { content: `No tab ${input.index}. ${tabsLine(ctx) || "Only one tab is open."}` };
    }
    ctx.page = target;
    await target.bringToFront().catch(() => {});
    return actionResult(ctx, `OK: switched to tab ${input.index} (${target.url()})`);
  },

  handle_dialog: async (input, ctx) => {
    const action = input.action === "dismiss" ? "dismiss" : "accept";
    const text = typeof input.text === "string" ? input.text : undefined;
    ctx.dialogPolicy = { action, text };
    return {
      content: `OK: the next dialog will be ${action === "dismiss" ? "dismissed (Cancel)" : `accepted (OK)${text ? ` with "${text}"` : ""}`}. Now do the action that opens it.`,
    };
  },
};
