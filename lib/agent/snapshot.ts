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
    if ((await c.count().catch(() => 0)) > 0) return c.first();
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
