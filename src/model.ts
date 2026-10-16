// Models over the OpenAI-compatible chat API: OpenRouter by default; OpenAI, Gemini, Anthropic or a
// local server by changing the base URL.

import OpenAI from "openai";
import type { ChatMessage, Model, ModelRequest, ModelResponse } from "./types.ts";

export interface OpenAICompatibleOptions {
  /** The provider's model id. When omitted, the key in the environment picks a default. */
  model?: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  /** The model sees photos (OpenAI-style image_url parts). Default true; false for a text-only model. */
  images?: boolean;
  /** The model reads PDFs (file parts). Default true on OpenRouter, which reads them for any model; false elsewhere. */
  pdfs?: boolean;
}

/** The first of these with a value is the agent's model. `MODEL` overrides that provider's default id. */
const KEYS = [
  { env: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1", model: "anthropic/claude-haiku-5.5" },
  { env: "OPENAI_API_KEY", baseURL: "https://api.openai.com/v1", model: "gpt-6-luna" },
  { env: "ANTHROPIC_API_KEY", baseURL: "https://api.anthropic.com/v1/", model: "claude-haiku-5-5" },
  { env: "GEMINI_API_KEY", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3.8-flash" },
] as const;

/** Which key, address and model an omitted `apiKey` / `baseURL` resolve to. */
export function modelFromKeys(env: Record<string, string | undefined>): { apiKey?: string; baseURL: string; model: string } {
  const named = env.MODEL?.trim();
  for (const provider of KEYS) {
    const apiKey = env[provider.env]?.trim();
    if (apiKey) return { apiKey, baseURL: provider.baseURL, model: named || provider.model };
  }
  return { baseURL: KEYS[0].baseURL, model: named || KEYS[0].model };
}

export function openAICompatible(options: OpenAICompatibleOptions = {}): Model {
  // An explicit key or address is that provider. Otherwise the first key in the environment wins.
  const fromEnv = options.apiKey !== undefined || options.baseURL !== undefined ? undefined : modelFromKeys(process.env);
  const baseURL = options.baseURL ?? fromEnv?.baseURL ?? KEYS[0].baseURL;
  const apiKey = options.apiKey ?? fromEnv?.apiKey ?? (process.env.OPENROUTER_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());
  // A server at a base URL you name (a local one) may need no key; the client still sends one.
  if (!apiKey && options.baseURL === undefined) {
    throw new Error(`No model key: set one of ${KEYS.map((k) => k.env).join(", ")} (in the agent's .env), or pass apiKey, or baseURL for a server that needs none.`);
  }
  const client = new OpenAI({
    apiKey: apiKey || "none",
    baseURL,
    maxRetries: 1,
  });
  const model = options.model?.trim() || fromEnv?.model || KEYS[0].model;
  return {
    reads: { images: options.images ?? true, pdfs: options.pdfs ?? baseURL.startsWith("https://openrouter.ai/") },
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const completion = await client.chat.completions.create(
        {
          model,
          temperature: options.temperature,
          messages: [{ role: "system", content: request.system }, ...request.messages.map(toWire)],
          ...(request.tools.length
            ? { tools: request.tools.map((t) => ({ type: "function" as const, function: t })) }
            : {}),
        },
        { signal: request.signal },
      );
      const message = completion.choices[0]?.message;
      return {
        text: message?.content?.trim() || null,
        toolCalls: (message?.tool_calls ?? [])
          .filter((call) => call.type === "function")
          .map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments || "{}" })),
        usage: completion.usage ? { inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens, ...costOf(completion.usage) } : undefined,
        model: completion.model,
      };
    },
  };
}

function toWire(message: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  if (message.role === "user") {
    const media = (message.media ?? []).filter((m) => m.data);
    if (!media.length) return { role: "user", content: message.content };
    return {
      role: "user",
      content: [
        { type: "text", text: message.content },
        ...media.map((m): OpenAI.Chat.ChatCompletionContentPart => {
          const url = `data:${m.mime};base64,${m.data}`;
          return m.kind === "image" ? { type: "image_url", image_url: { url } } : { type: "file", file: { filename: m.name ?? "document.pdf", file_data: url } };
        }),
      ],
    };
  }
  return {
    role: "assistant",
    content: message.content,
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  };
}

/** OpenRouter adds the call's cost in US dollars to usage; other providers leave it out. */
function costOf(usage: object): { costUsd?: number } {
  const cost = (usage as { cost?: unknown }).cost;
  return typeof cost === "number" ? { costUsd: cost } : {};
}
