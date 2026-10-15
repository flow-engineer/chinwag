// An agent you already have, on any framework, tested through its HTTP endpoint: `chinwag test
// --agent-url <url>`. This plays the part of a Chinwag Agent on the developer's machine: each of the
// person's messages is one POST to the URL from here (so the agent never has to be reachable from
// the internet), and the replies it answers go to the test cloud as a Chinwag agent's would. Its own
// tools run on its side, for real.
//
//   POST <url>  { conversationId, messageId, channel, message: { text, attachments?: [{ kind, mime, name?, data }] } }
//   200         { replies: Outbound[] }        (data is base64; [] is no reply)
//
// A conversation's messages go one at a time, in order: the next is sent once the last one's answer
// is in. Each reply is checked against what the run's platform can show, as a Chinwag agent's send
// is. Agents that answer later (through a callback) are not supported yet.

import { Buffer } from "node:buffer";
import { emitter } from "../../src/events.ts";
import { fitMessage, z, type ChannelInfo, type ChannelSummary, type Deliver, type EventSink, type Incoming, type Outbound, type ReceiveOptions } from "../../src/index.ts";
import { sendInput, sendRefusal } from "../../src/talk.ts";

export interface HttpAgentOptions {
  url: string;
  /** Sent as `authorization: Bearer <token>` (CHINWAG_AGENT_TOKEN). */
  token?: string;
  /** The channel every message names; default the platform the run plays (whatsapp, sms, imessage, telegram, web). */
  channel?: string;
  /** How long one message waits for its answer. Default 60 s. */
  timeoutMs?: number;
  events?: EventSink[];
  log?: (line: string) => void;
}

/** The person's message as the agent's endpoint gets it. */
export interface HttpAgentRequest {
  conversationId: string;
  /** The id the cloud gave this message (m1, m2, ...): a reply's replyTo, a reaction's or a read's messageId. */
  messageId: string;
  channel: string;
  message: {
    text: string;
    replyTo?: Incoming["replyTo"];
    choice?: Incoming["choice"];
    attachments?: Array<{ kind: "image" | "audio" | "document"; mime: string; name?: string; data: string }>;
  };
}

const answerSchema = z.object({ replies: z.array(z.unknown()) });
const otherReply = z.discriminatedUnion("type", [
  z.object({ type: z.literal("read"), messageIds: z.array(z.string()) }),
  z.object({ type: z.literal("reaction"), emoji: z.string().min(1), messageId: z.string().min(1) }),
  z.looseObject({ type: z.literal("template"), name: z.string().min(1) }),
  z.object({ type: z.literal("status"), text: z.string().nullable() }),
  z.object({ type: z.literal("typing"), on: z.boolean() }),
]);

class TurnError extends Error {}

const problems = (error: z.ZodError) =>
  error.issues.map((i) => (i.code === "unrecognized_keys" ? `${i.keys.join(", ")}: not something this platform shows` : (i.path.length ? `${i.path.join(".")}: ` : "") + i.message)).join("; ");

export function httpAgent(options: HttpAgentOptions) {
  const emit = emitter(options.events ?? []);
  const log = options.log ?? ((line: string) => console.log(line));
  const timeoutMs = options.timeoutMs ?? 60_000;
  /** Each conversation's last message, so the next one waits for its answer. */
  const queues = new Map<string, Promise<void>>();

  async function post(body: HttpAgentRequest): Promise<unknown[]> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(options.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      const e = error as Error & { cause?: { code?: string; message?: string } };
      if (e.name === "TimeoutError") throw new TurnError(`no answer from ${options.url} within ${timeoutMs / 1000} s`);
      throw new TurnError(`could not reach ${options.url}: ${e.cause?.code ?? e.cause?.message ?? e.message}`);
    }
    if (response.status !== 200) throw new TurnError(`${options.url} answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TurnError(`${options.url} answered 200 with a body that is not JSON: ${text.slice(0, 200)}`);
    }
    const answer = answerSchema.safeParse(parsed);
    if (!answer.success) throw new TurnError(`${options.url} answered 200 without { "replies": [...] }: ${text.slice(0, 200)}`);
    return answer.data.replies;
  }

  /** The reply as the platform takes it, or why it cannot go: the checks a Chinwag agent's send gets. */
  function check(reply: unknown, info: ChannelInfo): { outbound: Outbound } | { refused: string } {
    const type = (reply as { type?: unknown } | null)?.type;
    if (type !== "message") {
      const other = otherReply.safeParse(reply);
      return other.success ? { outbound: other.data as Outbound } : { refused: problems(other.error) };
    }
    const { type: _, replyTo, fields, ...rest } = reply as Extract<Outbound, { type: "message" }>;
    const input = { ...rest, ...(replyTo !== undefined ? { reply_to: replyTo } : {}) };
    const sent = sendInput(info).strict().safeParse(input);
    if (!sent.success) return { refused: problems(sent.error).replaceAll("reply_to", "replyTo") };
    if (fields !== undefined && (typeof fields !== "object" || fields === null || Array.isArray(fields))) return { refused: "fields: must be an object" };
    const refusal = sendRefusal(info, input as Parameters<typeof sendRefusal>[1]);
    if (refusal) return { refused: refusal };
    return { outbound: fitMessage(info, { type: "message" as const, ...rest, ...(replyTo !== undefined ? { replyTo } : {}), ...(fields ? { fields } : {}) }) };
  }

  async function turn(conversationId: string, request: HttpAgentRequest, incoming: Incoming, info: ChannelInfo, deliver: Deliver): Promise<void> {
    const started = Date.now();
    emit(conversationId, "turn.start", {});
    try {
      if (incoming.attachments?.length) {
        request.message.attachments = await Promise.all(
          incoming.attachments.map(async (a) => ({ kind: a.kind, mime: a.mime, ...(a.name ? { name: a.name } : {}), data: Buffer.from(await a.data()).toString("base64") })),
        );
      }
      for (const reply of await post(request)) {
        const checked = check(reply, info);
        const text = (reply as { text?: unknown })?.text;
        const shown = typeof text === "string" ? text : `(${String((reply as { type?: unknown })?.type ?? "reply")})`;
        if ("refused" in checked) {
          log(`${conversationId}: a reply was not sent: ${checked.refused}`);
          emit(conversationId, "message.undelivered", { text: shown, reason: checked.refused });
          continue;
        }
        const outbound = checked.outbound;
        try {
          await deliver(outbound);
        } catch (error) {
          emit(conversationId, "message.undelivered", { text: shown, reason: (error as Error).message });
          continue;
        }
        if (outbound.type === "message") {
          const { type: _, ...sent } = outbound;
          emit(conversationId, "message.out", { ...sent, channel: request.channel });
        } else if (outbound.type === "reaction") {
          emit(conversationId, "reaction", { emoji: outbound.emoji, messageId: outbound.messageId });
        }
      }
    } catch (error) {
      const reason = error instanceof TurnError ? error.message : `the message could not be sent: ${(error as Error).message}`;
      log(`${conversationId}: ${reason}`);
      emit(conversationId, "model.error", { error: reason });
      emit(conversationId, "message.undelivered", { text: "(the agent's answer)", reason });
    } finally {
      emit(conversationId, "turn.end", { ms: Date.now() - started });
    }
  }

  return {
    /** None of its own: each run plays its platform as the platform is. */
    channels(): ChannelSummary[] {
      return [];
    },
    receive(conversationId: string, message: string | Incoming, deliver: Deliver, receive: ReceiveOptions = {}): string | null {
      const incoming: Incoming = typeof message === "string" ? { text: message } : message;
      const messageId = receive.messageId ?? "";
      // The cloud's conversations are "<platform>:<person>".
      const channel = options.channel ?? /^([a-z]+):/.exec(conversationId)?.[1] ?? "chat";
      const request: HttpAgentRequest = {
        conversationId,
        messageId,
        channel,
        message: { text: incoming.text, ...(incoming.replyTo ? { replyTo: incoming.replyTo } : {}), ...(incoming.choice ? { choice: incoming.choice } : {}) },
      };
      const attachments = incoming.attachments?.map((a) => ({ kind: a.kind, mime: a.mime, ...(a.name ? { name: a.name } : {}) }));
      emit(conversationId, "message.in", { text: incoming.text, messageId, channel, ...(attachments ? { attachments } : {}) });
      const info = receive.channel ?? { reactions: false, status: false };
      const next = (queues.get(conversationId) ?? Promise.resolve()).then(() => turn(conversationId, request, incoming, info, deliver));
      queues.set(conversationId, next);
      return messageId || null;
    },
    /** The person reacted to one of its messages: not sent to the endpoint in this version. */
    reacted(_conversationId: string, _emoji: string, _toText: string): void {},
  };
}
