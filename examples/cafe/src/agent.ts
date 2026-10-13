// Builds Pip. The playground (main.ts) and the tests build it the same way; tests pass their own
// model, events and (simulated) tools.

import { fileURLToPath } from "node:url";
import { createAgent, openAICompatible, type EventSink, type Model, type Tool } from "../../../src/index.ts";
import { tools as cafeTools } from "./tools.ts";

export interface BuildOptions {
  model?: Model;
  events?: EventSink[];
  tools?: Tool[];
}

export const tools = cafeTools;

export function buildAgent(options: BuildOptions = {}) {
  return createAgent({
    dir: fileURLToPath(new URL("../agent", import.meta.url)),
    model: options.model ?? openAICompatible({ model: process.env.CAFE_MODEL ?? "anthropic/claude-haiku-5.5" }),
    tools: options.tools ?? cafeTools,
    context: () => `Now: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} (New York)`,
    events: options.events ?? [],
  });
}
