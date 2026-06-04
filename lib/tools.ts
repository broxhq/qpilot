import type Anthropic from "@anthropic-ai/sdk";
import type { Page } from "playwright";

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
      "Get the current page state: URL, title, and ARIA tree with ref=[eN] on each element — pass those refs to click/fill. Call after every page change.",
    input_schema: { type: "object", properties: {} },
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
    name: "scroll",
    description: "Scroll the page by pixel offset. Use to reveal elements below the fold.",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Horizontal scroll in pixels (usually 0)" },
        y: { type: "number", description: "Vertical scroll in pixels (positive = down)" },
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

export async function snapshot(page: Page): Promise<string> {
  const url = page.url();
  if (!url || url === "about:blank") {
    return `URL: ${url || "about:blank"}\n\nPage not opened yet. Call navigate with the starting URL from the test case first.`;
  }
  const title = await page.title().catch(() => "");

  let tree = "";
  try {
    tree = await page
      .locator("body")
      .ariaSnapshot({ mode: "ai", timeout: 5000 });
  } catch (err) {
    tree = `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`;
  }
  if (tree.length > MAX_SNAPSHOT_CHARS) {
    tree = tree.slice(0, MAX_SNAPSHOT_CHARS) + "\n... (truncated)";
  }

  return [
    `URL: ${url}`,
    `Title: ${title}`,
    "",
    "Page snapshot (pass [ref=…] of the target element to click/fill):",
    tree,
  ].join("\n");
}
