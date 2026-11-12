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

/** Is `fill` about to type into a password / one-time-code field? */
export async function isSecretField(page: Page, input: Record<string, unknown>): Promise<boolean> {
  const ref = typeof input.ref === "string" ? input.ref.trim() : "";
  if (!REF_RE.test(ref)) return false;
  return page
    .locator(`aria-ref=${ref}`)
    .evaluate(
      (el) =>
        el instanceof HTMLInputElement &&
        (el.type === "password" ||
          /one-time-code|current-password|new-password|cc-csc/.test(el.autocomplete)),
      undefined,
      { timeout: 1000 },
    )
    .catch(() => false);
}
