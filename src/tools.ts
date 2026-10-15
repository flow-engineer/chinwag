// Tools are plain functions with a zod input. The runtime decides at call time whether one runs
// in the reply or carries on in the background; tool authors mark nothing.

import { z } from "zod";
import type { ToolSpec } from "./types.ts";

export interface ToolContext {
  conversationId: string;
  /**
   * Who the person is, as Chinwag verified it: the owner's own key from `resolve`, a phone number
   * the channel verified, or the channel and its address. Key a person's data by this, never by an
   * id the model passed.
   */
  person: string;
  /** The channel of their latest message. */
  channel: string;
}

export interface Tool<Input = any> {
  name: string;
  description: string;
  input: z.ZodType<Input>;
  run(input: Input, context: ToolContext): Promise<unknown> | unknown;
  /** The longest the reply waits for this tool before it moves to the background (default: the agent's, 60 s). */
  deadlineMs?: number;
}

export function tool<Input>(definition: Tool<Input>): Tool<Input> {
  return definition;
}

export function toSpec(t: Tool): ToolSpec {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(t.input) as Record<string, unknown>;
  return { name: t.name, description: t.description, parameters };
}

/** A tool's output as the model reads it. */
export function render(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output ?? null);
  } catch {
    return String(output);
  }
}
