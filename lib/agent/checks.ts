// Checks the model names and the framework runs.
//
// A verdict rests on what the model read, and a model reads "3 890" as "3 980"
// when that is what it expects. For an expected result that is literal — a text
// that must be on the page, a field that must be in a request — the model can
// put it as a condition instead, and the condition is run here against the real
// page and the request log: a substring is there or it is not.

import type { StepCheck } from "../types";
import type { ToolContext } from "./context";

const KINDS = ["page_has", "page_lacks", "request_has", "request_lacks"] as const;
type Kind = (typeof KINDS)[number];

const MAX_CHECKS = 8;

/** The same text however it was spaced, cased or quoted. */
const flat = (s: string) =>
  s
    .replace(/[\s    ]+/g, " ")
    .replace(/[«»“”„‟"]/g, '"')
    .replace(/[‘’‚‛']/g, "'")
    .trim()
    .toLowerCase();

/** What a person can read on the page now: the text of every frame. */
export async function pageText(ctx: ToolContext): Promise<string> {
  const parts = await Promise.all(
    ctx.page.frames().map((f) => f.evaluate(() => document.body?.innerText ?? "").catch(() => "")),
  );
  return parts.join("\n");
}

/** Lines of the page that share the most words with a text that was not found — what is there in its place. */
function nearest(text: string, page: string): string[] {
  const words = flat(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  if (words.length === 0) return [];
  return page
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l.length <= 200)
    .map((l) => ({ l, score: words.filter((w) => flat(l).includes(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.l);
}

export interface RanCheck extends StepCheck {
  /** For the model, when the check does not hold: what the page or the log has instead. */
  note?: string;
}

/** Runs the checks of one report_step. Anything that is not a check the framework knows is left out. */
export async function runChecks(ctx: ToolContext, raw: unknown): Promise<RanCheck[]> {
  const asked = (Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [])
    .map((c) => (c ?? {}) as { kind?: unknown; text?: unknown; request?: unknown })
    .filter((c): c is { kind: Kind; text: string; request?: unknown } => KINDS.includes(c.kind as Kind) && typeof c.text === "string" && !!c.text.trim())
    .slice(0, MAX_CHECKS);
  if (asked.length === 0) return [];

  const needsPage = asked.some((c) => c.kind.startsWith("page"));
  const page = needsPage ? await pageText(ctx) : "";
  // names that are not text on the page — a button's aria-label, an image's alt — are in the tree
  const tree = needsPage ? (ctx.lastFull ?? "") : "";

  return asked.map((c) => {
    const text = c.text.trim();
    const wanted = c.kind.endsWith("has");
    if (c.kind.startsWith("page")) {
      const now = flat(page).includes(flat(text)) || flat(tree).includes(flat(text));
      // "must be there" is also true of what the page showed earlier on this step —
      // another tab of the same step, a message that came and went. "Must not be
      // there" is about the page as it is now.
      const earlier = wanted && !now && [...ctx.seenTexts, ...ctx.flashSeen].some((m) => flat(m).includes(flat(text)));
      const present = now || earlier;
      const near = !present && wanted ? nearest(text, page) : [];
      return {
        kind: c.kind,
        text,
        present,
        holds: present === wanted,
        note: present
          ? wanted ? undefined : "the page has this text"
          : `the page has no such text${near.length ? `. Nearest on the page: ${near.map((l) => `"${l}"`).join(", ")}` : ""}`,
      };
    }
    const n = c.request === undefined || c.request === null ? undefined : Number(String(c.request).replace(/^#/, ""));
    const got = ctx.net.carries(text, Number.isInteger(n) ? n : undefined);
    // the number may be the wrong one: say which request does carry the text
    const elsewhere = got.known && !got.present && n !== undefined ? ctx.net.carries(text) : null;
    return {
      kind: c.kind,
      text,
      request: Number.isInteger(n) ? n : undefined,
      where: got.where,
      present: got.present,
      holds: got.known && got.present === wanted,
      note: !got.known
        ? `there is no request #${n} in the request log`
        : got.present
          ? wanted ? undefined : `${got.where ?? "a request"} carries this text`
          : n === undefined
            ? "no recorded request carries this text in its URL or body"
            : `request #${n} is ${got.where ?? "another request"} and does not carry this text in its URL or body` +
              (elsewhere?.present ? ` — request #${elsewhere.n} (${elsewhere.where}) does: name that one` : ""),
    };
  });
}
