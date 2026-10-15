// Traces of every turn, for a traces endpoint (a dashboard that shows and grades conversations).
// An event sink like any other: it folds a conversation's events into one trace per turn (a root
// span, a span per model call, per tool and per message sent) and posts them as OTLP/JSON to
// `<url>/v1/traces` with the agent's trace key.
//
// It never slows or breaks a conversation: a finished turn is queued (bounded; the oldest goes when
// it is full) and sent in the background, every turn finished meanwhile in the same request; a
// failed request is dropped, logged once per kind of failure, and never names the key.
//
// Content (what the person and the agent wrote, tool inputs and results) is sent only with
// `content: true` (CHINWAG_TRACES_CONTENT=1); without it the spans hold ids, names, timing and counts,
// and the endpoint has no messages to show or grade.

import { randomBytes } from "node:crypto";
import type { EventSink, ChinwagEvent } from "./events.ts";

export interface TracesOptions {
  /** The traces endpoint's base URL; traces go to `<url>/v1/traces`. */
  url: string;
  /** The agent's key for the traces endpoint. */
  key: string;
  /** Send what was written (messages, tool inputs and results). Default false: metadata only. */
  content?: boolean;
  /** This agent's version, sent as `service.version`. */
  version?: string;
}

/** Finished turns waiting to be sent; past this the oldest is dropped. */
const MAX_QUEUED = 512;
/** Turns per request. */
const BATCH = 64;
const TIMEOUT_MS = 10_000;
/** The cap per content attribute. */
const MAX_TEXT = 32 * 1024;

/**
 * The traces options from the environment: on when CHINWAG_TRACES_KEY is set (with CHINWAG_TRACES_URL,
 * required), except under `node --test` (NODE_TEST_CONTEXT), so an agent's own tests never send
 * their turns.
 */
export function tracesFromEnv(env: NodeJS.ProcessEnv = process.env): TracesOptions | undefined {
  const key = env.CHINWAG_TRACES_KEY ?? "";
  if (!key || env.NODE_TEST_CONTEXT) return undefined;
  const url = env.CHINWAG_TRACES_URL ?? "";
  if (!url) throw new Error("chinwag: CHINWAG_TRACES_KEY is set but CHINWAG_TRACES_URL is not: set it to your traces endpoint's URL");
  return { key, url, content: env.CHINWAG_TRACES_CONTENT === "1" };
}

/** The endpoint's channel names: Chinwag's custom UIs are web or app chats. */
const CHANNEL_KIND: Record<string, string> = { sms: "sms", whatsapp: "whatsapp", custom: "web" };

type Attr = { key: string; value: Record<string, unknown> };
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status?: { code: number };
}

interface Inbound {
  at: number;
  text: string;
  channel: string;
  /** The channel's own id for the message (Chinwag's own ids are not sent: they restart). */
  messageId?: string;
}

interface Turn {
  traceId: string;
  rootId: string;
  start: number;
  inbound: Inbound[];
  spans: Span[];
  tools: Map<string, { at: number; input: unknown }>;
  replyChannel?: string;
}

export interface Traces {
  sink: EventSink;
  /** Resolves once every finished turn queued so far has been sent (or dropped). */
  flush(): Promise<void>;
}

export function traces(options: TracesOptions, agent: { service: string; kindOf(channel: string): string | undefined }): Traces {
  const base = (options.url ?? "").replace(/\/+$/, "");
  if (!options.key) throw new Error("chinwag: traces need a key");
  if (!base) throw new Error("chinwag: traces need your traces endpoint's URL");
  if (!allowedUrl(base)) throw new Error("chinwag: traces go over https (http only to this machine)");
  const endpoint = `${base}/v1/traces`;
  const content = options.content === true;
  const open = new Map<string, Turn>();
  /** Messages and background results that came while no turn was open: they join the next one. */
  const waiting = new Map<string, { inbound: Inbound[]; spans: Array<(turn: Turn) => Span> }>();
  const queue: Span[][] = [];
  const warned = new Set<string>();
  let sending: Promise<void> | null = null;

  const resource: Attr[] = [attr("service.name", agent.service), attr("telemetry.sdk.name", "chinwag")];
  if (options.version) resource.push(attr("service.version", options.version));

  function warnOnce(kind: string, message: string) {
    if (warned.has(kind)) return;
    warned.add(kind);
    console.warn(`chinwag: ${message}; later failures of this kind are not logged`);
  }

  const kindOf = (channel: string | undefined) => (channel ? CHANNEL_KIND[agent.kindOf(channel) ?? ""] ?? "other" : undefined);

  function waitingFor(id: string) {
    let w = waiting.get(id);
    if (!w) waiting.set(id, (w = { inbound: [], spans: [] }));
    return w;
  }

  function child(turn: Turn, name: string, start: number, end: number, attributes: Attr[], failed = false): Span {
    return span(turn.traceId, name, start, end, attributes, turn.rootId, failed);
  }

  function begin(conversationId: string, at: number) {
    finish(conversationId, false, at);
    const w = waiting.get(conversationId);
    waiting.delete(conversationId);
    const inbound = w?.inbound ?? [];
    const turn: Turn = { traceId: hex(16), rootId: hex(8), start: Math.min(at, ...inbound.map((m) => m.at)), inbound, spans: [], tools: new Map() };
    for (const make of w?.spans ?? []) turn.spans.push(make(turn));
    open.set(conversationId, turn);
  }

  function finish(conversationId: string, failed: boolean, at: number) {
    const turn = open.get(conversationId);
    if (!turn) return;
    open.delete(conversationId);
    const attributes = [attr("gen_ai.operation.name", "invoke_agent"), attr("gen_ai.agent.name", agent.service), ...ids(conversationId)];
    const channel = kindOf(turn.inbound.at(-1)?.channel ?? turn.replyChannel);
    if (channel) attributes.push(attr("chinwag.channel", channel));
    if (turn.inbound.length) {
      attributes.push(attr("chinwag.messages", turn.inbound.length));
      if (turn.inbound[0].messageId) attributes.push(attr("chinwag.message_id", turn.inbound[0].messageId));
      if (content) attributes.push(attr("chinwag.user_message", clip(turn.inbound.map((m) => m.text).join("\n"))));
    }
    const root: Span = { ...span(turn.traceId, `invoke_agent ${agent.service}`, turn.start, at, attributes, undefined, failed), spanId: turn.rootId };
    enqueue([root, ...turn.spans]);
  }

  /** A message sent outside any turn (one the business wrote, sent as is): a trace of its own. */
  function alone(conversationId: string, at: number, channel: string, text: unknown) {
    const turn: Turn = { traceId: hex(16), rootId: hex(8), start: at, inbound: [], spans: [], tools: new Map(), replyChannel: channel };
    open.set(conversationId, turn);
    turn.spans.push(reply(turn, at, channel, text));
    finish(conversationId, false, at);
  }

  function reply(turn: Turn, at: number, channel: string, text: unknown): Span {
    turn.replyChannel ??= channel;
    const attributes = [attr("chinwag.channel", channel)];
    if (content && typeof text === "string") attributes.push(attr("chinwag.agent_reply", clip(text)));
    return child(turn, `send ${channel}`, at, at, attributes);
  }

  function enqueue(spans: Span[]) {
    queue.push(spans);
    if (queue.length > MAX_QUEUED) {
      queue.shift();
      warnOnce("queue", "traces could not be sent fast enough and the oldest turns were dropped");
    }
    void drain();
  }

  function drain(): Promise<void> {
    sending ??= (async () => {
      while (queue.length) await post(queue.splice(0, BATCH).flat());
    })().finally(() => (sending = null));
    return sending;
  }

  async function post(spans: Span[]) {
    const body = JSON.stringify({ resourceSpans: [{ resource: { attributes: resource }, scopeSpans: [{ scope: { name: "chinwag" }, spans }] }] });
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.key}` },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const answer = await response.text();
      if (!response.ok) return warnOnce(`http ${response.status}`, `the traces endpoint refused traces (HTTP ${response.status})`);
      const rejected = Number(parseJson(answer)?.partialSuccess?.rejectedSpans ?? 0);
      if (rejected > 0) warnOnce("partial", `the traces endpoint rejected ${rejected} span(s) of a trace`);
    } catch (error) {
      const name = error instanceof Error ? error.name : "error";
      warnOnce(`network ${name}`, `traces could not reach the traces endpoint (${name})`);
    }
  }

  function handle(e: ChinwagEvent) {
    const id = e.conversationId;
    const turn = open.get(id);
    switch (e.type) {
      case "message.in": {
        // A voice note's text is its transcript (and any caption).
        const text = [e.transcript, e.text].filter(Boolean).join(" ");
        const m: Inbound = { at: e.at, text, channel: String(e.channel ?? ""), messageId: e.ownId ? String(e.messageId) : undefined };
        (turn ?? waitingFor(id)).inbound.push(m);
        return;
      }
      case "turn.start":
        return begin(id, e.at);
      case "turn.end":
        return finish(id, false, e.at);
      case "model.error":
        return finish(id, true, e.at);
      case "message.out":
        if (!turn) return alone(id, e.at, String(e.channel), e.text);
        turn.spans.push(reply(turn, e.at, String(e.channel), e.text));
        return;
      case "model.call": {
        if (!turn) return;
        const ms = Number(e.ms ?? 0);
        const usage = e.usage as { inputTokens?: number; outputTokens?: number } | undefined;
        const model = typeof e.model === "string" ? e.model : undefined;
        const attributes = [attr("gen_ai.operation.name", "chat")];
        if (model) attributes.push(attr("gen_ai.response.model", model));
        if (usage?.inputTokens !== undefined) attributes.push(attr("gen_ai.usage.input_tokens", usage.inputTokens));
        if (usage?.outputTokens !== undefined) attributes.push(attr("gen_ai.usage.output_tokens", usage.outputTokens));
        turn.spans.push(child(turn, model ? `chat ${model}` : "chat", e.at - ms, e.at, attributes));
        return;
      }
      case "tool.start":
        turn?.tools.set(String(e.callId), { at: e.at, input: e.input });
        return;
      case "tool.end":
      case "tool.detached": {
        if (!turn) return;
        const started = turn.tools.get(String(e.callId));
        turn.tools.delete(String(e.callId));
        const attributes = toolAttributes(e, started?.input);
        if (e.type === "tool.detached") attributes.push(attr("chinwag.tool.background", true));
        turn.spans.push(child(turn, `execute_tool ${e.tool}`, started?.at ?? e.at - Number(e.ms ?? 0), e.at, attributes, e.ok === false));
        return;
      }
      case "task.done": {
        // A background tool finished: its result starts the next turn, which this span joins.
        const make = (t: Turn) => child(t, `execute_tool ${e.tool}`, e.at - Number(e.ms ?? 0), e.at, [...toolAttributes(e), attr("chinwag.tool.background", true)], e.ok === false);
        if (turn) turn.spans.push(make(turn));
        else waitingFor(id).spans.push(make);
        return;
      }
    }
  }

  function toolAttributes(e: ChinwagEvent, input?: unknown): Attr[] {
    const attributes = [attr("gen_ai.operation.name", "execute_tool"), attr("gen_ai.tool.name", String(e.tool)), attr("gen_ai.tool.call.id", String(e.callId))];
    if (content && input !== undefined) attributes.push(attr("gen_ai.tool.call.arguments", clip(JSON.stringify(input))));
    if (content && typeof e.output === "string") attributes.push(attr("gen_ai.tool.call.result", clip(e.output)));
    return attributes;
  }

  return {
    sink: (event) => {
      try {
        handle(event);
      } catch (error) {
        warnOnce("sink", `traces skipped an event (${error instanceof Error ? error.name : "error"})`);
      }
    },
    flush: () => drain(),
  };
}

/** The endpoint's ids: the conversation is the person (Chinwag keeps one per person across channels). */
function ids(conversationId: string): Attr[] {
  return [attr("chinwag.conversation_id", conversationId), attr("chinwag.contact_id", conversationId)];
}

function span(traceId: string, name: string, start: number, end: number, attributes: Attr[], parentSpanId?: string, failed = false): Span {
  return {
    traceId,
    spanId: hex(8),
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    kind: 1,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(Math.max(start, end)),
    attributes,
    ...(failed ? { status: { code: 2 } } : {}),
  };
}

function attr(key: string, value: string | number | boolean): Attr {
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number") return { key, value: Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } };
  return { key, value: { stringValue: value } };
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const nanos = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();
const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [truncated]` : text);

function allowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
