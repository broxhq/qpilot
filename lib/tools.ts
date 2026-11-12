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

// Descriptions are part of every model call, so they stay short: what the tool
// does and the one thing that is easy to get wrong. Behaviour rules live in the
// system prompt (lib/agent.ts).
const ref = (what = "Element") => ({ type: "string", description: `${what} ref from the latest page tree, e.g. e12` });
const label = { type: "string", description: "Short human-readable name for the log, e.g. 'Login button'" };

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "set_plan",
    description:
      "First call of the run. One group per test case; each step is the tester's step (action and expected result) without a leading number. Preconditions are not steps.",
    input_schema: {
      type: "object",
      properties: {
        groups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Test case title; omit if it has none." },
              steps: { type: "array", items: { type: "string" } },
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
    description: "Open a URL. Returns the page tree.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
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
  {
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
  {
    name: "fill",
    description: "Type text into a field, replacing what is there.",
    input_schema: {
      type: "object",
      properties: { ref: ref("Field"), value: { type: "string" }, name: label },
      required: ["ref", "value"],
    },
  },
  {
    name: "select",
    description: "Choose an option of a <select> dropdown, by its value or visible label.",
    input_schema: {
      type: "object",
      properties: { ref: ref("<select>"), value: { type: "string" }, name: label },
      required: ["ref", "value"],
    },
  },
  {
    name: "hover",
    description:
      "Move the mouse over an element — for anything that opens on hover (notification bell, avatar menu, tooltip, submenu). The result shows the opened panel.",
    input_schema: { type: "object", properties: { ref: ref(), name: label }, required: ["ref"] },
  },
  {
    name: "press",
    description: "Press a key: Enter, Tab, Escape, ArrowDown…",
    input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  },
  {
    name: "dismiss",
    description: "Close an open dropdown/popover by clicking an empty corner of the page. Use when a click fails with 'intercepts pointer events'.",
    input_schema: { type: "object", properties: {} },
  },
  {
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
  {
    name: "wait",
    description: "Wait N ms (max 10000). Prefer wait_for when you know what should appear.",
    input_schema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"] },
  },
  {
    name: "scroll_to",
    description: "Scroll until an element is visible, whatever container holds it. Target by text or ref.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, ref: ref() },
    },
  },
  {
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
  {
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
  {
    name: "switch_tab",
    description: "Switch to another open tab by its number from the Tabs line. You are moved to a newly opened tab automatically.",
    input_schema: { type: "object", properties: { index: { type: "number" } }, required: ["index"] },
  },
  {
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
  {
    name: "note",
    description:
      "Save a fact you will need later: a value to compare, an id, a state before a change. Notes stay in your context for the whole run; old page trees do not.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "mock_request",
    description:
      "Intercept requests whose URL matches and control the response. Call BEFORE the action that sends the request. status/body = answer without hitting the server; patch = merge fields into the REAL JSON response; abort = network error; delay_ms = slow it down. Stays active until clear_mocks.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Part of the URL ('/api/cart') or a glob with * ('*/orders/*')." },
        method: { type: "string" },
        status: { type: "number" },
        body: { type: "string", description: "Response body, usually a JSON string." },
        content_type: { type: "string" },
        patch: { type: "object", description: "Merged into the real response; applied to every item if it is a list." },
        abort: { type: "boolean" },
        delay_ms: { type: "number" },
      },
      required: ["url"],
    },
  },
  {
    name: "clear_mocks",
    description: "Remove all mocks; reports how many requests each one matched.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "set_offline",
    description: "Turn the browser's network off (true) or back on (false).",
    input_schema: { type: "object", properties: { offline: { type: "boolean" } }, required: ["offline"] },
  },
  {
    name: "get_requests",
    description:
      "The Network tab: recent XHR/fetch calls and page loads with method, URL, status, request body and JSON response. `find` matches the URL or the request body, so an RPC method name works too.",
    input_schema: {
      type: "object",
      properties: {
        find: { type: "string", description: "Text in the URL or request body, e.g. 'orders' or 'getNotifications'." },
        method: { type: "string" },
        failed_only: { type: "boolean", description: "Only failed or 4xx/5xx." },
        limit: { type: "number", description: "Latest N matches, default 15." },
      },
    },
  },
  {
    name: "get_console",
    description: "JavaScript console errors of the whole run.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "ask_user",
    description:
      "Ask the user for ONE value the test case does not give and you cannot know: a login, phone, OTP, captcha. Name the field on screen.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What to enter, e.g. 'Enter the SMS code'." },
        secret: { type: "boolean", description: "true for passwords and codes." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "report_step",
    description:
      "Record the verdict of one step, AFTER you have seen the result of its actions. Screenshot for fail/warn is automatic.",
    input_schema: {
      type: "object",
      properties: {
        // Order matters: the model writes the fields in this order, so it states
        // what it saw BEFORE it commits to a verdict. With status first it picked
        // the verdict and then wrote evidence to fit it.
        num: { type: "number", description: "Step number from the plan." },
        expected: { type: "string", description: "Expected result of the step, copied from the test case." },
        evidence: {
          type: "string",
          description:
            "What you actually saw, one or two sentences: a verbatim quote from the page, a request and its status, a dialog text. For a 'changed / did not change' check give the value before and after for every element checked.",
        },
        status: {
          type: "string",
          enum: ["pass", "fail", "warn"],
          description: "Decided from the evidence you just wrote: pass only if it shows the expected result.",
        },
        description: { type: "string", description: "Only if the step went differently from the plan: one line saying what was done." },
      },
      required: ["num", "evidence", "status"],
    },
  },
  {
    name: "finish",
    description: "End the run after the last step is reported.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["passed", "failed"] },
        summary: { type: "string", description: "1–2 sentences, in the language of the test case." },
      },
      required: ["status", "summary"],
    },
  },
];

const MAX_HINTED = 40;

/**
 * Icon-only controls have no accessible name: the tree shows a bare `button
 * [ref=e12]`, and a header with five of them gives the model nothing to tell
 * the bell from the help icon. Add what the markup does say — test ids, class
 * names, the icon's file or sprite id, a link target.
 */
async function hintUnnamed(page: Page, tree: string): Promise<string> {
  const bare = /^\s*- (?:button|link|img|menuitem|tab) \[ref=((?:f\d+)?e\d+)\]/;
  const refs = tree
    .split("\n")
    .map((l) => l.match(bare)?.[1])
    .filter((r): r is string => !!r)
    .slice(0, MAX_HINTED);
  if (refs.length === 0) return tree;

  const hints = await Promise.all(
    refs.map((ref) =>
      page
        .locator(`aria-ref=${ref}`)
        .evaluate(
          (el) => {
            const out: string[] = [];
            const add = (k: string, v: string | null | undefined) => {
              const t = (v ?? "").trim().slice(0, 60);
              if (t && out.length < 4 && !out.some((o) => o.endsWith(`=${t}`))) out.push(`${k}=${t}`);
            };
            const words = (c: string | null) =>
              (c ?? "").split(/\s+/).filter((w) => /[a-zA-Z]{4,}/.test(w)).slice(0, 3).join(" ");
            for (const a of ["data-testid", "data-test-id", "data-test", "data-qa", "data-name", "id", "name", "title"]) {
              add(a, el.getAttribute(a));
            }
            add("class", words(el.getAttribute("class")));
            const use = el.querySelector("use");
            add("icon", use?.getAttribute("href") ?? use?.getAttribute("xlink:href"));
            add("icon", el.querySelector("svg title")?.textContent);
            const img = el.tagName === "IMG" ? el : el.querySelector("img");
            if (img) {
              add("alt", img.getAttribute("alt"));
              add("img", (img.getAttribute("src") ?? "").split("/").pop()?.split("?")[0]);
            }
            const inner = el.querySelector("[data-testid], [class]");
            if (inner) add("inside", inner.getAttribute("data-testid") ?? words(inner.getAttribute("class")));
            if (el.tagName === "A") add("href", el.getAttribute("href"));
            return out.join(", ");
          },
          undefined,
          { timeout: 800 },
        )
        .catch(() => ""),
    ),
  );
  const byRef = new Map(refs.map((r, i) => [r, hints[i]]));
  return tree
    .split("\n")
    .map((line) => {
      const ref = line.match(bare)?.[1];
      const hint = ref ? byRef.get(ref) : "";
      return hint ? line.replace(`[ref=${ref}]`, `[ref=${ref}] (no name; ${hint})`) : line;
    })
    .join("\n");
}

const MAX_SNAPSHOT_CHARS = 16000;

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
      // Climb from the matched element to a container with enough context, but
      // stop BEFORE a huge ancestor — otherwise scoping a leaf (e.g. a submit
      // button at the end of a long form) lands on <body> and the target gets
      // truncated away. Bounding descendant count keeps the target in the tree.
      const tagged = await anchor
        .evaluate((el, max) => {
          let n: Element | null = el;
          let best: Element = el;
          for (let i = 0; i < max && n; i++) {
            const count = n.querySelectorAll("*").length;
            if (count > 300) break; // ancestor too large — keep the previous one
            best = n;
            if (count >= 25) break; // enough surrounding context
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
  tree = await hintUnnamed(page, tree);
  if (tree.length > MAX_SNAPSHOT_CHARS) {
    tree =
      tree.slice(0, MAX_SNAPSHOT_CHARS) +
      "\n... (truncated. Elements past this point are NOT shown — including submit/footer buttons at the bottom of long forms. To act on something not listed here, use snapshot with `near='<text near it>'`, or scroll_to('<button text>') to bring it into a fresh snapshot. Scrolling alone won't reveal it.)";
  }

  return [
    `URL: ${url}`,
    `Title: ${title}${scopeNote}`,
    "",
    "Page snapshot (pass [ref=…] of the target element to click/fill):",
    tree,
  ].join("\n");
}
