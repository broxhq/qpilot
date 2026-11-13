// Can this model see? Nobody is asked: the agent finds out for itself.
//
// Before the first run with a model, it is shown a picture of a random number
// and asked to read it back. Only a model that gets it right is offered the
// tools that need eyes (look, click_at, hover_at) and the part of the prompt
// about them. A text-only model is offered exactly what it always was — so
// adding vision cannot change how a text-only run goes.

import type Anthropic from "@anthropic-ai/sdk";
import type { Browser } from "playwright";
import { askAboutImage, type ProviderConfig } from "../provider";

const CHECK_TIMEOUT_MS = 30_000;

// One answer per model for the life of the server: the check costs a model call.
const g = globalThis as unknown as { __qa_vision?: Map<string, boolean> };
const known = (g.__qa_vision ??= new Map<string, boolean>());

const keyOf = (cfg: ProviderConfig) => `${cfg.kind}|${cfg.baseURL ?? ""}|${cfg.model}`;

/** A small picture of `digits`, drawn by the browser the run already has. */
async function pictureOf(browser: Browser, digits: string): Promise<Buffer> {
  const context = await browser.newContext({ viewport: { width: 480, height: 200 } });
  try {
    const page = await context.newPage();
    await page.setContent(
      `<body style="margin:0;height:100vh;display:grid;place-items:center;background:#fff;font:bold 110px sans-serif">${digits}</body>`,
    );
    return await page.screenshot({ type: "jpeg", quality: 70 });
  } finally {
    await context.close();
  }
}

export async function canSee(
  cfg: ProviderConfig,
  client: Anthropic | null,
  browser: Browser,
): Promise<boolean> {
  // an escape hatch, not a setting: QPILOT_VISION=0 keeps a model that sees badly
  // on text, QPILOT_VISION=1 skips the check (a gateway where it misfires, tests)
  const forced = process.env.QPILOT_VISION;
  if (forced === "0" || forced === "false") return false;
  if (forced === "1" || forced === "true") return true;

  const key = keyOf(cfg);
  const cached = known.get(key);
  if (cached !== undefined) return cached;

  const digits = String(1000 + Math.floor(Math.random() * 9000));
  try {
    const answer = await askAboutImage(
      cfg,
      client,
      await pictureOf(browser, digits),
      "What number is in the image? Answer with the digits only.",
      CHECK_TIMEOUT_MS,
    );
    const sees = answer.replace(/\D/g, "") === digits;
    known.set(key, sees);
    return sees;
  } catch (err) {
    // The endpoint refused the image outright: the model cannot see, remember that.
    // Anything else (timeout, network, 5xx) says nothing about the model — go on
    // without eyes this once and ask again next run.
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429) {
      known.set(key, false);
    }
    return false;
  }
}

/** The endpoint refused a screenshot mid-run: stop offering eyes to this model. */
export function forgetVision(cfg: ProviderConfig): void {
  known.set(keyOf(cfg), false);
}
