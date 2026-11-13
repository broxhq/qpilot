import type Anthropic from "@anthropic-ai/sdk";
import { readConfigFile, type StoredConfig } from "./config";

// Model provider. Two backends:
//  - anthropic: native Anthropic SDK.
//  - openai: any OpenAI-compatible endpoint (Qwen, vLLM, Ollama, corp gateway,
//    OpenRouter, OpenAI itself). One adapter covers them all.
//
// Config comes from ~/.qpilot/config.json (written by the Settings page, the
// CLI and the macOS app), falling back to env vars when there is no file.

export type ProviderConfig =
  // baseURL is optional for anthropic — for corp proxies/gateways in front of Claude
  | { kind: "anthropic"; apiKey: string; model: string; baseURL?: string }
  | { kind: "openai"; baseURL: string; apiKey: string; model: string };

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const MAX_TOKENS = 2048;
/** One model call; a normal answer takes seconds, the slowest full-length one about a minute. */
export const MODEL_TIMEOUT_MS = 120_000;

/**
 * The provider settings in config-file shape: the file if there is one,
 * else env vars (dev `.env.local`, CI). null when neither has anything.
 */
export function currentStoredConfig(): { config: StoredConfig; source: "file" | "env" } | null {
  const file = readConfigFile();
  if (file) return { config: file, source: "file" };
  const p = (process.env.QPILOT_PROVIDER || "anthropic").toLowerCase();
  if (p === "custom" || p === "openai") {
    if (!process.env.QPILOT_API_KEY && !process.env.QPILOT_BASE_URL) return null;
    return {
      source: "env",
      config: {
        provider: "custom",
        apiKey: process.env.QPILOT_API_KEY || "",
        model: process.env.QPILOT_MODEL || undefined,
        baseURL: process.env.QPILOT_BASE_URL || undefined,
      },
    };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.QPILOT_API_KEY || "";
  if (!apiKey) return null;
  return {
    source: "env",
    config: {
      provider: "anthropic",
      apiKey,
      model: process.env.QPILOT_MODEL || undefined,
      baseURL: process.env.QPILOT_BASE_URL || undefined,
    },
  };
}

export function toProviderConfig(cfg: StoredConfig): ProviderConfig {
  return cfg.provider === "custom"
    ? { kind: "openai", baseURL: cfg.baseURL || "", apiKey: cfg.apiKey, model: cfg.model || "" }
    : {
        kind: "anthropic",
        apiKey: cfg.apiKey,
        model: cfg.model || DEFAULT_ANTHROPIC_MODEL,
        baseURL: cfg.baseURL || undefined,
      };
}

/** Provider config for a run — read fresh each time, so Settings apply at once. */
export function resolveProvider(): ProviderConfig {
  const file = readConfigFile();
  if (file) return toProviderConfig(file);
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
  const fix = "Open Settings (the gear on the home page) to set it.";
  if (cfg.kind === "anthropic") {
    return cfg.apiKey ? null : `No Anthropic API key is configured. ${fix}`;
  }
  if (!cfg.baseURL) return `Custom provider: the base URL is not set. ${fix}`;
  if (!cfg.apiKey) return `Custom provider: the API token is not set. ${fix}`;
  if (!cfg.model) return `Custom provider: the model id is not set. ${fix}`;
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

type OpenAIImagePart = { type: "image_url"; image_url: { url: string } };
type OpenAIMessage =
  | { role: "system" | "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "user"; content: string | Array<{ type: "text"; text: string } | OpenAIImagePart> }
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
      // A tool message can only be text here, so a screenshot returned by a tool
      // follows as a user message once the turn's tool results are in.
      const images: OpenAIImagePart[] = [];
      for (const b of m.content) {
        if (b.type === "tool_result") {
          let text: string;
          if (typeof b.content === "string") text = b.content;
          else {
            const parts = b.content ?? [];
            text = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
            for (const p of parts) {
              if (p.type === "image" && p.source.type === "base64") {
                images.push({
                  type: "image_url",
                  image_url: { url: `data:${p.source.media_type};base64,${p.source.data}` },
                });
              }
            }
          }
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: text });
        } else if (b.type === "text") {
          out.push({ role: "user", content: b.text });
        }
      }
      if (images.length) {
        out.push({
          role: "user",
          content: [{ type: "text", text: "The screenshot you asked for with look:" }, ...images],
        });
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

  const usage = (data as { usage?: { prompt_tokens?: number; completion_tokens?: number } })?.usage;
  return {
    content,
    stop_reason: choice?.finish_reason ?? "end_turn",
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  } as unknown as Anthropic.Message;
}

export async function callOpenAICompatible(
  cfg: Extract<ProviderConfig, { kind: "openai" }>,
  system: string,
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
): Promise<Anthropic.Message> {
  const url = cfg.baseURL.replace(/\/+$/, "") + "/chat/completions";

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      // a gateway that queues or hangs must not hold the run for minutes:
      // give up and let callModel retry
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: MAX_TOKENS,
        messages: toOpenAIMessages(system, messages),
        tools: toOpenAITools(tools),
        // "auto", not "required": forcing a tool call makes slow models faster
        // (no free text), but the ones that reason in text before acting gave
        // wrong verdicts without it. Fast models write no such text anyway.
        tool_choice: "auto",
      }),
    });
  } catch (err) {
    // Node's network errors are bare ("fetch failed") — say what was unreachable,
    // otherwise the run just shows two useless words.
    if ((err as Error).name === "TimeoutError") {
      throw new Error(`The model did not answer in ${MODEL_TIMEOUT_MS / 1000} s (${url}).`);
    }
    const cause = (err as { cause?: { message?: string; code?: string } }).cause;
    const detail = cause?.code ?? cause?.message ?? (err as Error).message;
    throw new Error(
      `Cannot reach the model endpoint ${url} (${detail}). Check that the URL is right, the service is up, and you are on the network/VPN it needs. Run \`qpilot config\` to change it.`,
    );
  }

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

// ── a question about one image (the vision check) ────────────────────────────

/**
 * Shows the model one JPEG and returns its answer as text. Used once per model
 * to find out whether it can see at all (lib/agent/vision.ts). Throws like any
 * model call: with `status` on an HTTP error.
 */
export async function askAboutImage(
  cfg: ProviderConfig,
  client: Anthropic | null,
  jpeg: Buffer,
  question: string,
  timeoutMs: number,
): Promise<string> {
  const data = jpeg.toString("base64");
  // room for models that reason before they answer
  const maxTokens = 600;

  if (cfg.kind === "anthropic") {
    const res = await client!.messages.create(
      {
        model: cfg.model,
        max_tokens: maxTokens,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
            { type: "text", text: question },
          ],
        }],
      },
      { timeout: timeoutMs, maxRetries: 0 },
    );
    return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  }

  const res = await fetch(cfg.baseURL.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: question },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } },
        ],
      }],
    }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Model API ${res.status}`), { status: res.status });
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  return json.choices?.[0]?.message?.content ?? "";
}

/** One plain question, one plain answer — no tools, no history. */
export async function askText(
  cfg: ProviderConfig,
  client: Anthropic | null,
  system: string,
  question: string,
  timeoutMs: number,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  // room for models that reason before they answer
  const maxTokens = 600;

  if (cfg.kind === "anthropic") {
    const res = await client!.messages.create(
      { model: cfg.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: question }] },
      { timeout: timeoutMs, maxRetries: 0 },
    );
    return {
      text: res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
    };
  }

  const res = await fetch(cfg.baseURL.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: question },
      ],
    }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Model API ${res.status}`), { status: res.status });
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: json.choices?.[0]?.message?.content ?? "",
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
  };
}
