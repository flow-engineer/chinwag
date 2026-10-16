// Observability: everything the agent does is an event. Sinks send them anywhere (a log, a
// dashboard, a test); they must never throw into the conversation.

import { appendFileSync } from "node:fs";

export interface ChinwagEvent {
  type:
    | "message.in"
    | "message.arrived"
    | "message.out"
    | "turn.start"
    | "turn.context"
    | "turn.end"
    | "model.call"
    | "model.restarted"
    | "model.error"
    | "tool.start"
    | "tool.end"
    | "tool.detached"
    | "tool.repeated"
    | "task.done"
    | "skill.loaded"
    | "text.hidden"
    | "ack.required"
    | "reaction"
    | "status"
    | "message.undelivered"
    | "reaction.in"
    | "attachment.failed"
    | "keyword";
  conversationId: string;
  at: number;
  [detail: string]: unknown;
}

/** A place events go. `context` asks for `turn.context`; without it the person's record is not sent. */
export interface EventSink {
  (event: ChinwagEvent): void;
  context?: boolean;
}

/** One JSON line per event, to a file. */
export function jsonlSink(path: string): EventSink {
  return (event) => appendFileSync(path, JSON.stringify(event) + "\n");
}

export function emitter(sinks: EventSink[]) {
  return (conversationId: string, type: ChinwagEvent["type"], detail: Record<string, unknown> = {}) => {
    const event: ChinwagEvent = { type, conversationId, at: Date.now(), ...detail };
    for (const sink of sinks) {
      try {
        sink(event);
      } catch (error) {
        console.warn("chinwag: an event sink failed:", error);
      }
    }
  };
}

export type Emit = ReturnType<typeof emitter>;
