// Keeping refs and secrets out of everything a person reads: events, report, log.

import { type Page } from "playwright";
import { REF_RE, type ToolContext } from "./context";

// Models copy refs out of the snapshot in every form: [ref=e12], [e12], (e12), "row e12".
export const stripRefs = (t: string): string =>
  t
    .replace(/\s*[[(](?:ref=)?(?:f\d+)?e\d+[\])]/g, "")
    .replace(/(^|\s)(?:ref=)?(?:f\d+)?e\d{1,6}(?=[\s.,;:)]|$)/g, "");

export const SECRET_MASK = "••••••";

/** Mask known secrets in text that goes to events / the UI (never in what the model receives). */
export function redact(ctx: ToolContext, text: string): string {
  let out = text;
  for (const secret of ctx.secrets) {
    if (secret.length >= 3) out = out.split(secret).join(SECRET_MASK);
  }
  return out;
}

export function redactDeep(ctx: ToolContext, v: unknown): unknown {
  if (ctx.secrets.size === 0) return v;
  if (typeof v === "string") return redact(ctx, v);
  if (Array.isArray(v)) return v.map((x) => redactDeep(ctx, x));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactDeep(ctx, x)]),
    );
  }
  return v;
}

/**
 * Is `fill` about to type something that must not be read in the log?
 * "secret" — a password or one-time-code field. "cell" — one box of a code
 * typed a character per box: four to eight one-character inputs side by side.
 * Such boxes are plain text inputs, so nothing but their shape gives them away.
 */
export async function isSecretField(page: Page, input: Record<string, unknown>): Promise<"secret" | "cell" | false> {
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (!REF_RE.test(ref)) return false;
  return page
    .locator(`aria-ref=${ref}`)
    .evaluate(
      (el) => {
        if (!(el instanceof HTMLInputElement)) return false;
        if (el.type === "password" || /one-time-code|current-password|new-password|cc-csc/.test(el.autocomplete)) return "secret";
        if (el.maxLength !== 1) return false;
        // the boxes of one code share a container a level or two up
        for (let box: Element | null = el.parentElement, up = 0; box && up < 3; box = box.parentElement, up++) {
          const cells = [...box.querySelectorAll("input")].filter((i) => i.maxLength === 1);
          if (cells.length >= 4 && cells.length <= 8) return "cell";
        }
        return false;
      },
      undefined,
      { timeout: 1000 },
    )
    .catch(() => false as const);
}

/**
 * A secret typed in pieces: the user gave a code, and the agent types it one
 * character per field. Each piece is too short to be masked as a secret (a
 * mask on every "1" would blank half the log), so the pieces are recognised by
 * what they add up to. Returns what has been spelled so far if `value`
 * continues (or starts) a known secret, and "" if it does not.
 */
export function spells(secrets: Set<string>, soFar: string, value: string): string {
  if (!value || value.length > 2) return "";
  for (const attempt of [soFar + value, value]) {
    for (const secret of secrets) if (secret.length >= 3 && secret.startsWith(attempt)) return attempt;
  }
  return "";
}
