// Models over the OpenAI-compatible chat API: OpenRouter by default; OpenAI, Gemini, Anthropic or a
// local server by changing the base URL.

import OpenAI from "openai";
import type { ChatMessage, Model, ModelRequest, ModelResponse } from "./types.ts";

export interface OpenAICompatibleOptions {
  model: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
}

export function openAICompatible(options: OpenAICompatibleOptions): Model {
  const client = new OpenAI({
    apiKey: options.apiKey ?? process.env.OPENROUTER_API_KEY,
    baseURL: options.baseURL ?? "https://openrouter.ai/api/v1",
    maxRetries: 1,
  });
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const completion = await client.chat.completions.create(
        {
          model: options.model,
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
  if (message.role === "user") return { role: "user", content: message.content };
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
