// Talking to the model: one call with retries, and keeping the history within budget.

import type Anthropic from "@anthropic-ai/sdk";
import { toolsFor } from "./handlers";
import { callOpenAICompatible, parseRetryAfter, type ProviderConfig } from "../provider";
import { systemPrompt } from "./prompt";

export const CONTEXT_BUDGET_CHARS = 64_000;

export const KEEP_RECENT_TOOL_MSGS = 3;

// What stays of an older tool result: what the action led to, not the page it
// showed. The model must still know that Save was pressed and nothing was sent.
const OLD_RESULT_CHARS = 1500;
// When even that is too much, the oldest results are cut down to a line or two.
const OLDEST_RESULT_CHARS = 240;
const KEEP_OUTCOMES = 12;

export const MAX_RETRIES = 5;

export const MAX_BACKOFF_MS = 30_000;

// Screenshots kept in the history. An older one shows a page that has changed since.
const KEEP_SCREENSHOTS = 2;

type ResultContent = Anthropic.ToolResultBlockParam["content"];

/** The text of a tool result, whether it is plain or text + screenshot. */
function textOf(content: ResultContent): string {
  if (typeof content === "string") return content;
  return (content ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

const hasImage = (content: ResultContent) =>
  Array.isArray(content) && content.some((p) => p.type === "image");

/**
 * Replaces screenshots in tool results with `note`: all of them, or all but the
 * last `keep`. Returns the same array when there was nothing to replace.
 */
export function dropScreenshots(
  messages: Anthropic.MessageParam[],
  note: string,
  keep = 0,
): Anthropic.MessageParam[] {
  let seen = 0;
  let changed = false;
  const out = [...messages];
  for (let mi = out.length - 1; mi >= 0; mi--) {
    const m = out[mi];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    let touched = false;
    const content = m.content.map((b) => b);
    for (let bi = content.length - 1; bi >= 0; bi--) {
      const b = content[bi];
      if (b.type !== "tool_result" || !hasImage(b.content)) continue;
      if (seen++ < keep) continue;
      content[bi] = { ...b, content: `${textOf(b.content)}\n${note}` };
      touched = true;
    }
    if (touched) {
      out[mi] = { ...m, content };
      changed = true;
    }
  }
  return changed ? out : messages;
}

/** A tool result without the page tree it carried: the outcome lines, notes and the list of changes. */
function withoutTree(text: string, max: number): string {
  if (text.startsWith("URL: ")) return "[page tree — no longer kept]";
  const at = text.indexOf("\n\nURL: ");
  const head = at >= 0 ? text.slice(0, at) : text;
  const kept = head.length > max ? `${head.slice(0, max)}…` : head;
  if (at >= 0) return `${kept}\n[the page tree that came with this is no longer kept]`;
  return head.length > max ? `${kept}\n[the rest of this output is no longer kept]` : kept;
}

// only text counts towards the budget: a screenshot is cheap for the model to
// read but huge as base64, and would push every page tree out of the history
const sizeOf = (messages: Anthropic.MessageParam[]) =>
  messages.reduce((n, m) => {
    if (typeof m.content === "string") return n + m.content.length;
    return n + m.content.reduce(
      (k, b) => k + (b.type === "tool_result" ? textOf(b.content).length : JSON.stringify(b).length),
      0,
    );
  }, 0);

export function compactHistory(
  history: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const messages = dropScreenshots(history, "[the screenshot is no longer kept — look again if you need it]", KEEP_SCREENSHOTS);
  if (sizeOf(messages) <= CONTEXT_BUDGET_CHARS) return messages;

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

  // First the page trees go, from every result but the latest few. If the
  // history is still too long, the outcomes of all but the last dozen actions
  // are cut down to a line or two.
  const cut = (limitFor: (order: number) => number | null) =>
    messages.map((m, mi) => {
      if (m.role !== "user" || !Array.isArray(m.content)) return m;
      const content = m.content.map((b, bi) => {
        if (b.type !== "tool_result") return b;
        const order = positions.findIndex(([pm, pb]) => pm === mi && pb === bi);
        const limit = limitFor(order);
        if (limit === null) return b;
        const c = textOf(b.content);
        const kept = withoutTree(c, limit);
        return kept === c && !hasImage(b.content) ? b : { ...b, content: kept };
      });
      return { ...m, content };
    });

  const old = positions.length - KEEP_RECENT_TOOL_MSGS;
  let out = cut((order) => (order < old ? OLD_RESULT_CHARS : null));
  if (sizeOf(out) > CONTEXT_BUDGET_CHARS) {
    const oldest = positions.length - KEEP_OUTCOMES;
    out = cut((order) => (order < oldest ? OLDEST_RESULT_CHARS : order < old ? OLD_RESULT_CHARS : null));
  }
  return out;
}

/**
 * Puts the framework's note on where the run stands after the latest tool
 * results. It is written anew for every call and never stored: the model reads
 * the current step and what it has tried on it without digging through history.
 */
export function withState(messages: Anthropic.MessageParam[], state: string): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!state || !last || last.role !== "user" || !Array.isArray(last.content)) return messages;
  return [...messages.slice(0, -1), { ...last, content: [...last.content, { type: "text", text: state }] }];
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
  /** Offer the tools that need eyes, and the part of the prompt about them. */
  vision: boolean,
): Promise<Anthropic.Message> {
  const system = systemPrompt(vision);
  const tools = toolsFor(vision);
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (cfg.kind === "anthropic") {
        return await client!.messages.create({
          model: cfg.model,
          max_tokens: 2048,
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages,
          tools,
          tool_choice: { type: "auto" },
        });
      }
      return await callOpenAICompatible(cfg, system, messages, tools);
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
