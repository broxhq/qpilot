// Talking to the model: one call with retries, and keeping the history within budget.

import type Anthropic from "@anthropic-ai/sdk";
import { TOOLS, snapshot } from "../tools";
import { callOpenAICompatible, parseRetryAfter, type ProviderConfig } from "../provider";
import { SYSTEM } from "./prompt";

export const CONTEXT_BUDGET_CHARS = 64_000;

export const KEEP_RECENT_TOOL_MSGS = 3;

export const MAX_RETRIES = 5;

export const MAX_BACKOFF_MS = 30_000;

export function compactHistory(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const size = messages.reduce((n, m) => {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    return n + c.length;
  }, 0);
  if (size <= CONTEXT_BUDGET_CHARS) return messages;

  const positions: Array<[number, number]> = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (m.role === "user" && Array.isArray(m.content)) {
      for (let bi = 0; bi < m.content.length; bi++) {
        if ((m.content[bi] as { type?: string })?.type === "tool_result")
          positions.push([mi, bi]);
      }
    }
  }

  const truncate = new Set(
    positions.slice(0, -KEEP_RECENT_TOOL_MSGS).map(([mi, bi]) => `${mi}-${bi}`),
  );

  return messages.map((m, mi) => {
    if (m.role !== "user" || !Array.isArray(m.content)) return m;
    const content = (m.content as Anthropic.ToolResultBlockParam[]).map((b, bi) => {
      if (!truncate.has(`${mi}-${bi}`) || b?.type !== "tool_result") return b;
      const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
      return c.length < 400 ? b : { ...b, content: `[…old tool output (page snapshot or request list), ${c.length} chars omitted]` };
    });
    return { ...m, content };
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Backoff before a retry. Prefer the server's Retry-After (present on 429 from
// most gateways); otherwise exponential 1→2→4→8s + jitter, capped.
// The Anthropic SDK exposes headers on err.headers; the custom path on err.retryAfterMs.
export function retryDelayMs(err: unknown, attempt: number): number {
  const e = err as { retryAfterMs?: number; headers?: { get?: (k: string) => string | null } };
  const hinted =
    e?.retryAfterMs ?? parseRetryAfter(e?.headers?.get?.("retry-after") ?? null);
  if (typeof hinted === "number" && hinted > 0) {
    return Math.min(hinted, MAX_BACKOFF_MS);
  }
  const backoff = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return backoff + Math.floor(Math.random() * 500);
}

export async function callModel(
  cfg: ProviderConfig,
  client: Anthropic | null,
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.Message> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (cfg.kind === "anthropic") {
        return await client!.messages.create({
          model: cfg.model,
          max_tokens: 2048,
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          messages,
          tools: TOOLS,
          tool_choice: { type: "auto" },
        });
      }
      return await callOpenAICompatible(cfg, SYSTEM, messages, TOOLS);
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      // retrying 4xx (except 429) is pointless: bad key/model/request
      if (status && status >= 400 && status < 500 && status !== 429) break;
      if (attempt === MAX_RETRIES - 1) break;
      await sleep(retryDelayMs(err, attempt));
    }
  }
  throw lastErr;
}
