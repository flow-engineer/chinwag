// Observability: everything the agent does is an event. Sinks send them anywhere (a log, a
// dashboard, a test); they must never throw into the conversation.

import { appendFileSync } from "node:fs";

export interface ParleyEvent {
  type:
    | "message.in"
    | "message.out"
    | "turn.start"
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
    | "reaction.in";
  conversationId: string;
  at: number;
  [detail: string]: unknown;
}

export type EventSink = (event: ParleyEvent) => void;

/** One JSON line per event, to a file. */
export function jsonlSink(path: string): EventSink {
  return (event) => appendFileSync(path, JSON.stringify(event) + "\n");
}

export function emitter(sinks: EventSink[]) {
  return (conversationId: string, type: ParleyEvent["type"], detail: Record<string, unknown> = {}) => {
    const event: ParleyEvent = { type, conversationId, at: Date.now(), ...detail };
    for (const sink of sinks) {
      try {
        sink(event);
      } catch (error) {
        console.warn("parley: an event sink failed:", error);
      }
    }
  };
}

export type Emit = ReturnType<typeof emitter>;
