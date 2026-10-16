// Tools are plain functions with a zod input. The runtime decides at call time whether one runs
// in the reply or carries on in the background; tool authors mark nothing.

import { z } from "zod";
import type { ToolSpec } from "./types.ts";

export interface ToolContext {
  conversationId: string;
  /**
   * Who the person is, as Chinwag verified it, in one of three forms: `key:<resolve's value>` when
   * the owner's `resolve` knew them, else `phone:<E.164>` (`phone:+15551234567`) for a number a
   * phone channel verified, else `<channel>:<address>`. It is the stable id to key a person's data
   * by, never an id the model passed. To look them up in your own backend, use `key`.
   */
  person: string;
  /** Exactly what the owner's `resolve` returned for this person (no `key:`), or null when they are known only by phone or channel and address. */
  key: string | null;
  /** The channel of their latest message. */
  channel: string;
  /** The model's id for this call, as the history keeps it. */
  callId: string;
  /**
   * The same for the same tool with the same input in the same turn, also when that turn runs
   * again after a restart (a cut-off call is not rerun, but the agent may call it again): pass it
   * to your backend so a booking or payment happens once.
   */
  idempotencyKey: string;
  /** Aborted when the conversation closes (the person was forgotten): stop and drop the work. */
  signal: AbortSignal;
}

export interface Tool<Input = any> {
  name: string;
  description: string;
  input: z.ZodType<Input>;
  run(input: Input, context: ToolContext): Promise<unknown> | unknown;
  /** The longest the reply waits for this tool before it moves to the background (default: the agent's, 60 s). */
  deadlineMs?: number;
}

/**
 * Marks a tool the test cloud plays in place of a built-in (get_user_profile): it is offered only
 * to an agent that has that built-in, and then instead of it, so a test never runs the real one.
 */
export const STAND_IN = Symbol("chinwag.standIn");

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
