import type Anthropic from "@anthropic-ai/sdk";

// Model provider. Two backends:
//  - anthropic: native Anthropic SDK.
//  - openai: any OpenAI-compatible endpoint (Qwen, vLLM, Ollama, corp gateway,
//    OpenRouter, OpenAI itself). One adapter covers them all.
//
// Config comes from env, set by the CLI (bin/qa-agent.js) from the user's choice.

export type ProviderConfig =
  // baseURL is optional for anthropic — for corp proxies/gateways in front of Claude
  | { kind: "anthropic"; apiKey: string; model: string; baseURL?: string }
  | { kind: "openai"; baseURL: string; apiKey: string; model: string };

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const MAX_TOKENS = 2048;

/** Build the provider config from environment variables. */
export function resolveProvider(): ProviderConfig {
  const provider = (process.env.QPILOT_PROVIDER || "anthropic").toLowerCase();

  if (provider === "custom" || provider === "openai") {
    return {
      kind: "openai",
      baseURL: process.env.QPILOT_BASE_URL || "",
      apiKey: process.env.QPILOT_API_KEY || "",
      model: process.env.QPILOT_MODEL || "",
    };
  }

  return {
    kind: "anthropic",
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.QPILOT_API_KEY || "",
    model: process.env.QPILOT_MODEL || DEFAULT_ANTHROPIC_MODEL,
    baseURL: process.env.QPILOT_BASE_URL || undefined,
  };
}

/**
 * Retry-After header → milliseconds. Accepts both a number of seconds ("5") and
 * an HTTP date ("Wed, 21 Oct 2025 07:28:00 GMT"). undefined if empty/unparsable.
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Human-readable message if the config is incomplete (for the 500 in /api/run). null = ok. */
export function providerConfigError(cfg: ProviderConfig): string | null {
  if (cfg.kind === "anthropic") {
    return cfg.apiKey ? null : "ANTHROPIC_API_KEY is not configured. Run: qpilot config";
  }
  if (!cfg.baseURL) return "Custom provider: QPILOT_BASE_URL is not set. Run: qpilot config";
  if (!cfg.apiKey) return "Custom provider: QPILOT_API_KEY is not set. Run: qpilot config";
  if (!cfg.model) return "Custom provider: QPILOT_MODEL is not set. Run: qpilot config";
  return null;
}

// ── OpenAI-compatible path ───────────────────────────────────────────────────
// The internal history is always in Anthropic format. Here we convert it (and the
// tools) to OpenAI Chat Completions, then normalize the response back into an
// Anthropic.Message so the agent loop never notices the difference.

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type OpenAIMessage =
  | { role: "system" | "user" | "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

function toOpenAITools(tools: Anthropic.Tool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function toOpenAIMessages(
  system: string,
  messages: Anthropic.MessageParam[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: "system", content: system }];

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    if (m.role === "user") {
      // block(s): tool_result and/or text
      for (const b of m.content) {
        if (b.type === "tool_result") {
          const c =
            typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: c });
        } else if (b.type === "text") {
          out.push({ role: "user", content: b.text });
        }
      }
      continue;
    }

    // assistant: text + tool_use → content + tool_calls
    let text = "";
    const toolCalls: OpenAIToolCall[] = [];
    for (const b of m.content) {
      if (b.type === "text") text += b.text;
      else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      }
    }
    out.push({
      role: "assistant",
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  }

  return out;
}

/** Normalized response — structurally compatible with what the agent loop reads. */
function fromOpenAI(data: unknown): Anthropic.Message {
  const choice = (data as { choices?: unknown[] })?.choices?.[0] as
    | { message?: { content?: string; tool_calls?: OpenAIToolCall[] }; finish_reason?: string }
    | undefined;
  const msg = choice?.message ?? {};

  const content: Array<Record<string, unknown>> = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    // arguments is usually a JSON string, but some gateways return an object directly
    const raw: unknown = tc.function.arguments;
    let input: unknown = {};
    if (typeof raw === "string") {
      try {
        input = JSON.parse(raw || "{}");
      } catch {
        input = {};
      }
    } else if (raw && typeof raw === "object") {
      input = raw;
    }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }

  return {
    content,
    stop_reason: choice?.finish_reason ?? "end_turn",
  } as unknown as Anthropic.Message;
}

export async function callOpenAICompatible(
  cfg: Extract<ProviderConfig, { kind: "openai" }>,
  system: string,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
): Promise<Anthropic.Message> {
  const url = cfg.baseURL.replace(/\/+$/, "") + "/chat/completions";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: MAX_TOKENS,
      messages: toOpenAIMessages(system, messages),
      tools: toOpenAITools(tools),
      tool_choice: "auto",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Retry-After (seconds or HTTP date) — the gateway's hint on how long to wait on 429
    throw Object.assign(new Error(`Model API ${res.status}: ${body.slice(0, 300)}`), {
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }

  return fromOpenAI(await res.json());
}
