import type Anthropic from "@anthropic-ai/sdk";

// Провайдер модели. Два бэкенда:
//  - anthropic: нативный Anthropic SDK (как было исторически).
//  - openai: любой OpenAI-совместимый endpoint (Qwen, vLLM, Ollama, корп-гейтвей,
//    OpenRouter, сам OpenAI). Один адаптер покрывает весь этот зоопарк.
//
// Конфиг приходит из env (их выставляет CLI bin/qa-agent.js по выбору юзера).

export type ProviderConfig =
  // baseURL у anthropic опционален — для корп-прокси/гейтвеев перед Claude
  | { kind: "anthropic"; apiKey: string; model: string; baseURL?: string }
  | { kind: "openai"; baseURL: string; apiKey: string; model: string };

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const MAX_TOKENS = 2048;

/** Собрать конфиг провайдера из переменных окружения. */
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

/** Понятное сообщение, если конфиг неполный (для 500 в /api/run). null = всё ок. */
export function providerConfigError(cfg: ProviderConfig): string | null {
  if (cfg.kind === "anthropic") {
    return cfg.apiKey ? null : "ANTHROPIC_API_KEY is not configured. Run: qpilot config";
  }
  if (!cfg.baseURL) return "Custom provider: QPILOT_BASE_URL is not set. Run: qpilot config";
  if (!cfg.apiKey) return "Custom provider: QPILOT_API_KEY is not set. Run: qpilot config";
  if (!cfg.model) return "Custom provider: QPILOT_MODEL is not set. Run: qpilot config";
  return null;
}

// ── OpenAI-совместимый путь ────────────────────────────────────────────────
// Внутренняя история диалога всегда в формате Anthropic. Здесь конвертируем
// её (и тулы) в OpenAI Chat Completions, а ответ нормализуем обратно в форму
// Anthropic.Message, чтобы цикл агента не заметил разницы.

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
      // блок(и): tool_result и/или text
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

/** Нормализованный ответ — структурно совместим с тем, что читает цикл агента. */
function fromOpenAI(data: unknown): Anthropic.Message {
  const choice = (data as { choices?: unknown[] })?.choices?.[0] as
    | { message?: { content?: string; tool_calls?: OpenAIToolCall[] }; finish_reason?: string }
    | undefined;
  const msg = choice?.message ?? {};

  const content: Array<Record<string, unknown>> = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    // arguments обычно JSON-строка, но часть гейтвеев отдаёт сразу объект
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
    throw Object.assign(new Error(`Model API ${res.status}: ${body.slice(0, 300)}`), {
      status: res.status,
    });
  }

  return fromOpenAI(await res.json());
}
