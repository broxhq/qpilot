import type Anthropic from "@anthropic-ai/sdk";
import type { Locator, Page } from "playwright";

// Resolve a text anchor for near=/scroll_to. Headings and exact matches win over
// a substring in prose: otherwise near="Top paid keywords" grabs the first
// paragraph that merely mentions the phrase instead of the actual section.
export async function findAnchor(page: Page, wanted: string): Promise<Locator | null> {
  const candidates: Locator[] = [
    page.getByRole("heading", { name: wanted, exact: true }),
    page.getByRole("heading", { name: wanted }),
    page.getByText(wanted, { exact: true }),
    page.getByText(wanted, { exact: false }),
  ];
  for (const c of candidates) {
    if ((await c.count().catch(() => 0)) > 0) return c.first();
  }
  return null;
}

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "set_plan",
    description:
      "CALL FIRST. Plan = array of groups, one per test case (TC-01, TC-02, …). If there is only one test case — one group. Put step text in steps WITHOUT leading numbers; do not split or add service sub-steps like 'open page'.",
    input_schema: {
      type: "object",
      properties: {
        groups: {
          type: "array",
          description: "One group per test case, in order.",
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Test case title, e.g. 'TC-01. Missing section…'. Omit if unnamed.",
              },
              steps: {
                type: "array",
                items: { type: "string" },
                description: "Steps of the test case, one action+check per item, no leading numbers.",
              },
            },
            required: ["steps"],
          },
        },
      },
      required: ["groups"],
    },
  },
  {
    name: "navigate",
    description: "Open a URL in the browser.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "snapshot",
    description:
      "Get the page state: URL, title, and ARIA tree with ref=[eN] on each element — pass those refs to click/fill. The tree covers the WHOLE loaded page, not just the visible viewport — scrolling does NOT add elements to it. Call after every page change. If the tree is truncated or you need a specific section, pass `near` to zoom into just that block (e.g. near='Top ads') — this is unambiguous and never truncated, use it instead of scrolling to hunt for a control.",
    input_schema: {
      type: "object",
      properties: {
        near: {
          type: "string",
          description: "Optional: visible text of a section/heading to scope the snapshot to that block only, e.g. 'Top ads'. Returns the surrounding container's subtree with refs.",
        },
      },
    },
  },
  {
    name: "click",
    description: "Click an element. ref from snapshot is required (e.g. e12).",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref from snapshot, e.g. e12" },
        name: { type: "string", description: "Human-readable label for the log, e.g. 'Login button'" },
      },
      required: ["ref"],
    },
  },
  {
    name: "fill",
    description: "Type text into a field. ref from snapshot is required (e.g. e7).",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Field ref from snapshot, e.g. e7" },
        value: { type: "string", description: "Text to type" },
        name: { type: "string", description: "Human-readable field label for the log, e.g. 'Username'" },
      },
      required: ["ref", "value"],
    },
  },
  {
    name: "press",
    description: "Press a key (Enter, Tab, Escape, ArrowDown, etc.)",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "dismiss",
    description:
      "Close an open overlay (dropdown, popover, tooltip, multi-select panel) by clicking an empty spot in the page corner — i.e. a click OUTSIDE the overlay. Use this when a click fails with 'intercepts pointer events' (an overlay is covering your target) and Escape doesn't help. After calling, take a fresh snapshot.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "wait",
    description: "Wait N milliseconds (use sparingly, max 3000).",
    input_schema: {
      type: "object",
      properties: { ms: { type: "number" } },
      required: ["ms"],
    },
  },
  {
    name: "select",
    description: "Choose an option in a <select> dropdown. ref from snapshot is required.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "ref of the <select> element from snapshot, e.g. e9" },
        value: { type: "string", description: "Option value or visible label to select" },
        name: { type: "string", description: "Human-readable label for the log" },
      },
      required: ["ref", "value"],
    },
  },
  {
    name: "hover",
    description: "Hover the mouse over an element (to reveal tooltips, dropdowns, etc). ref from snapshot is required.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "ref of the element from snapshot, e.g. e5" },
        name: { type: "string", description: "Human-readable label for the log" },
      },
      required: ["ref"],
    },
  },
  {
    name: "scroll_to",
    description: "Scroll until a target element is visible. PREFERRED over pixel scroll when you know what you're looking for. Automatically scrolls the right container (page, inner scrollable div, or sideways) to reveal it. Target by text OR by ref. After calling, take a snapshot to get a fresh ref.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Visible text of the target element or section heading, e.g. 'Top ads' or 'Show all'. Use a short, unique substring." },
        ref: { type: "string", description: "Alternatively, ref of the target from a snapshot (e.g. e14) — use for icons/unlabeled elements with no stable text." },
      },
    },
  },
  {
    name: "scroll",
    description: "Scroll by a pixel offset. Without ref — scrolls the main window. With ref — scrolls the nearest scrollable block CONTAINING that element (pass any ref inside the block you want to scroll; the actual scroll container is found automatically). Returns the new position and whether the end is reached. Prefer scroll_to when you know the target.",
    input_schema: {
      type: "object",
      properties: {
        y: { type: "number", description: "Vertical scroll in pixels (positive = down, negative = up). 0 for pure horizontal." },
        x: { type: "number", description: "Horizontal scroll in pixels (positive = right, negative = left). Default 0." },
        ref: { type: "string", description: "Optional ref of any element inside the block to scroll, e.g. e14. Omit to scroll the main window." },
      },
      required: ["y"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the user for ONE specific value needed right now (OTP/SMS code, captcha, phone number for login). Use ONLY when the value is not in the test case and the agent cannot know it. prompt must describe exactly the field currently on screen (by its label/placeholder from the snapshot).",
    input_schema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "What to enter, by field label. Example: 'Enter phone number', 'Enter SMS code'.",
        },
        secret: {
          type: "boolean",
          description: "true only for secret values: password, OTP/SMS code, CVV. false for phone, email, username.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "report_step",
    description:
      "Record the result of one test case step. Call AFTER executing and checking the expected result. Screenshot for fail/warn is taken automatically.",
    input_schema: {
      type: "object",
      properties: {
        num: {
          type: "number",
          description: "Sequential step number from the plan (across all groups, as returned by set_plan).",
        },
        description: { type: "string", description: "Brief description of what was checked." },
        status: { type: "string", enum: ["pass", "fail", "warn"] },
        evidence: {
          type: "string",
          description: "What was observed — actual result, verbatim text quote, console error.",
        },
      },
      required: ["num", "description", "status"],
    },
  },
  {
    name: "finish",
    description: "End the run after all steps are complete.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["passed", "failed"] },
        summary: { type: "string", description: "1-3 sentences about the results." },
      },
      required: ["status", "summary"],
    },
  },
];

const MAX_SNAPSHOT_CHARS = 8000;

export async function snapshot(page: Page, near?: string): Promise<string> {
  const url = page.url();
  if (!url || url === "about:blank") {
    return `URL: ${url || "about:blank"}\n\nPage not opened yet. Call navigate with the starting URL from the test case first.`;
  }
  const title = await page.title().catch(() => "");

  // Default scope = whole body. If `near` is given, scope to the section block
  // around that text so the relevant controls aren't lost to truncation and
  // duplicate labels (e.g. several "Show all") are disambiguated.
  let target = page.locator("body");
  let scopeNote = "";
  const wanted = near?.trim();
  if (wanted) {
    const anchor = await findAnchor(page, wanted);
    if (anchor) {
      // Climb from the matched text to a meaningful container (first ancestor
      // with enough descendants), tag it, and snapshot just that subtree.
      const tagged = await anchor
        .evaluate((el, max) => {
          let n: Element | null = el;
          let best: Element = el;
          for (let i = 0; i < max && n; i++) {
            best = n;
            if (n.querySelectorAll("*").length >= 25) break;
            n = n.parentElement;
          }
          best.setAttribute("data-qa-scope", "1");
          return true;
        }, 8)
        .catch(() => false);
      if (tagged) {
        target = page.locator('[data-qa-scope="1"]').first();
        scopeNote = ` (scoped to the block around "${wanted}")`;
      }
    } else {
      scopeNote = ` ("${wanted}" not found — showing full page)`;
    }
  }

  let tree = "";
  try {
    tree = await target.ariaSnapshot({ mode: "ai", timeout: 5000 });
  } catch (err) {
    tree = `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`;
  } finally {
    if (wanted) {
      await page
        .evaluate(() =>
          document
            .querySelectorAll('[data-qa-scope="1"]')
            .forEach((el) => el.removeAttribute("data-qa-scope")),
        )
        .catch(() => {});
    }
  }
  if (tree.length > MAX_SNAPSHOT_CHARS) {
    tree =
      tree.slice(0, MAX_SNAPSHOT_CHARS) +
      "\n... (truncated — scrolling won't help; use snapshot with `near` to zoom into the section you need)";
  }

  return [
    `URL: ${url}`,
    `Title: ${title}${scopeNote}`,
    "",
    "Page snapshot (pass [ref=…] of the target element to click/fill):",
    tree,
  ].join("\n");
}
