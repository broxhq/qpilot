// Reading the page: the tree the model sees, and finding a block by its text.

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
    const count = await c.count().catch(() => 0);
    if (count === 0) continue;
    if (count === 1) return c.first();
    // the same title twice (a widget down the page and the panel just opened
    // over it): the one a person is looking at is the one on screen
    const size = page.viewportSize();
    for (let i = 0; size && i < Math.min(count, 8); i++) {
      const box = await c.nth(i).boundingBox({ timeout: 1000 }).catch(() => null);
      if (box && box.width > 0 && box.height > 0 && box.y < size.height && box.y + box.height > 0 && box.x < size.width && box.x + box.width > 0) {
        return c.nth(i);
      }
    }
    return c.first();
  }
  return null;
}

const MAX_HINTED = 40;

/**
 * Icon-only controls have no accessible name: the tree shows a bare `button
 * [ref=e12]`, and a header with five of them gives the model nothing to tell
 * the bell from the help icon. Add what the markup does say — test ids, class
 * names, the icon's file or sprite id, a link target.
 */
async function hintUnnamed(page: Page, tree: string): Promise<string> {
  const bare = /^\s*- (?:button|link|img|menuitem|tab) \[ref=((?:f\d+)?e\d+)\]/;
  // controls first: an <img> inside every button would use up the whole allowance
  const found = tree.split("\n").filter((l) => bare.test(l));
  const refs = [...found.filter((l) => !/^\s*- img /.test(l)), ...found.filter((l) => /^\s*- img /.test(l))]
    .map((l) => l.match(bare)?.[1])
    .filter((r): r is string => !!r)
    .filter((r, i, all) => all.indexOf(r) === i)
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
// the off-screen part always gets at least this much, even after a long visible part
const SCREEN_OVERRUN = 3000;
const TRUNCATED =
  "\n... (truncated. Elements past this point are NOT shown — including submit/footer buttons at the bottom of long forms. To act on something not listed here, use snapshot with `near='<text near it>'`, or scroll_to('<button text>') to bring it into a fresh snapshot. Scrolling alone won't reveal it.)";
const LINE_REF = /\[ref=((?:f\d+)?e\d+)\]/;

/**
 * A page that does not fit the budget used to be cut in DOM order, and DOM
 * order is not what a person sees: a header rendered through a portal sits at
 * the end of the DOM and was cut off, while a widget far below the fold came
 * first. So for a big page the part on screen goes first and in full, and the
 * rest follows in page order as far as the budget allows. Returns null when
 * nothing could be placed on screen (the caller then cuts as before).
 */
async function screenFirst(page: Page, tree: string): Promise<string | null> {
  const lines = tree.split("\n");
  const n = lines.length;
  const indent = lines.map((l) => l.length - l.trimStart().length);
  const ref = lines.map((l) => l.match(LINE_REF)?.[1] ?? null);
  const parent: number[] = new Array(n).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    while (stack.length && indent[stack[stack.length - 1]] >= indent[i]) stack.pop();
    parent[i] = stack.length ? stack[stack.length - 1] : -1;
    stack.push(i);
  }
  // a line is judged by its own box when it is a leaf of the ref'd tree, or
  // when it has children without a ref (text, hidden slides) that follow it
  const refBelow: boolean[] = new Array(n).fill(false);
  const plainChild: boolean[] = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (ref[i]) for (let p = parent[i]; p >= 0 && !refBelow[p]; p = parent[p]) refBelow[p] = true;
    else if (parent[i] >= 0) plainChild[parent[i]] = true;
  }
  const judged = lines.map((_, i) => !!ref[i] && (!refBelow[i] || plainChild[i]));

  const size = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null));
  if (!size) return null;
  const visible = await Promise.all(
    lines.map(async (_, i) => {
      if (!judged[i]) return false;
      const box = await page.locator(`aria-ref=${ref[i]}`).boundingBox({ timeout: 1500 }).catch(() => null);
      return (
        !!box && box.width > 0 && box.height > 0 &&
        box.x < size.width && box.x + box.width > 0 && box.y < size.height && box.y + box.height > 0
      );
    }),
  );

  // own[i]: true = on screen, false = off screen, null = only a container of others
  const own: (boolean | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (judged[i]) own[i] = visible[i];
    else if (!ref[i]) own[i] = parent[i] >= 0 ? (own[parent[i]] ?? false) : false;
  }
  const part = (want: boolean) => {
    const keep: boolean[] = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      if (own[i] !== want) continue;
      for (let p = i; p >= 0 && !keep[p]; p = parent[p]) keep[p] = true;
    }
    return lines.filter((_, i) => keep[i]).join("\n");
  };
  const on = part(true);
  if (!on) return null;
  let off = part(false);
  const room = Math.max(SCREEN_OVERRUN, MAX_SNAPSHOT_CHARS - on.length);
  if (off.length > room) off = off.slice(0, room) + TRUNCATED;
  return [
    "ON SCREEN NOW — the page is too big to show whole; this is the part a person sees, in full:",
    on,
    "",
    "OFF SCREEN — the rest of the page, in page order:",
    off || "(nothing)",
  ].join("\n");
}

/** The page as the model gets it. */
export async function snapshot(page: Page, near?: string): Promise<string> {
  return (await readPage(page, near)).view;
}

/**
 * `view` is what the model reads (cut to the budget, the visible part first);
 * `full` is the whole tree — changes are looked for in it, so that a panel
 * that opened past the cut is still reported.
 */
export async function readPage(page: Page, near?: string): Promise<{ view: string; full: string }> {
  const url = page.url();
  if (!url || url === "about:blank") {
    const view = `URL: ${url || "about:blank"}\n\nPage not opened yet. Call navigate with the starting URL from the test case first.`;
    return { view, full: view };
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
  const whole = tree;
  if (tree.length > MAX_SNAPSHOT_CHARS) tree = (await screenFirst(page, tree)) ?? tree;
  tree = await hintUnnamed(page, tree);
  if (tree.length > MAX_SNAPSHOT_CHARS + SCREEN_OVERRUN) {
    tree = tree.slice(0, MAX_SNAPSHOT_CHARS + SCREEN_OVERRUN) + TRUNCATED;
  }

  const wrap = (t: string) =>
    [
      `URL: ${url}`,
      `Title: ${title}${scopeNote}`,
      "",
      "Page snapshot (pass [ref=…] of the target element to click/fill):",
      t,
    ].join("\n");
  return { view: wrap(tree), full: wrap(whole) };
}
