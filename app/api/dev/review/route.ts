import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { opine, type ReviewCase } from "@/lib/agent/reviewer";
import { MODEL_TIMEOUT_MS, providerConfigError, resolveProvider } from "@/lib/provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The second opinion on one saved case — for checking the reviewer itself
 * (e2e/review-eval.mjs). Off unless the server was started with QPILOT_DEV=1:
 * it spends model calls and has no place in a normal run.
 */
export async function POST(req: NextRequest) {
  if (process.env.QPILOT_DEV !== "1") return NextResponse.json({ error: "not found" }, { status: 404 });
  const cfg = resolveProvider();
  const cfgError = providerConfigError(cfg);
  if (cfgError) return NextResponse.json({ error: cfgError }, { status: 500 });
  const asked = (await req.json()) as ReviewCase;
  if (!asked?.step || typeof asked.testCase !== "string") return NextResponse.json({ error: "a review case is required" }, { status: 400 });
  const client = cfg.kind === "anthropic" ? new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, timeout: MODEL_TIMEOUT_MS }) : null;
  try {
    const { opinion, answer, calls } = await opine(cfg, client, asked);
    return NextResponse.json({ verdict: opinion?.verdict ?? null, reason: opinion?.reason ?? "", answer, calls });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
