// The simulators: one page with a simulator per platform (SMS, WhatsApp, iMessage, Telegram, web),
// all talking to the same agent with that platform's rules. Nothing is really sent. Parley's local
// playground and the test cloud both run it. Its JSON API is also the test API: a harness or a
// coding agent can play the person through it.
//
//   POST /api/messages    {platform, person, text, replyTo?, choice?}  → {messageId, at}
//   POST /api/reactions   {platform, person, messageId, emoji}          the person reacts to an agent message
//   GET  /api/events      ?platform&person   server-sent events: what the person sees, plus the trace
//   GET  /api/transcript  ?platform&person   everything so far, with timestamps
//   POST /api/reset       ?platform&person   start that conversation over
//   GET  /api/status                          busy / idle, background tasks
//   GET  /api/platforms                       each platform's rules, the agent's own platforms, link cards
//   GET  /person          ?person            one person on each of the agent's own channels, side by side
//
// The person's messages have the agent's ids (m1, m2, ...); the agent's messages get a1, a2, ...

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChannelInfo, ChannelSummary, Deliver, EventSink, Incoming, ListRow, Outbound, ParleyEvent } from "../../src/index.ts";
import { PLATFORMS, channelOf, platform as platformOf, smsSegments, type Platform } from "./platforms.ts";

/** What the simulators need from an agent. Parley's Agent is one as it is. */
export interface AgentConnection {
  /** A person's message; returns its id, or null when the agent answered it without a turn. */
  receive(conversationId: string, incoming: Incoming, deliver: Deliver, options: { channel: ChannelInfo; channelName?: string }): string | null;
  /**
   * The agent's own channels, if it has any (Parley's Agent does): a simulator plays the one of
   * its kind (SMS, WhatsApp, and the web simulator for a custom UI) with its definition.
   */
  channels?(conversationId: string): ChannelSummary[];
  /** The person reacted to one of the agent's messages. */
  reacted(conversationId: string, emoji: string, toText: string): void;
  status(): { busy: boolean; idleForMs: number; backgroundTasks: number; conversations: number };
}

export interface SimulatorsOptions {
  /** The agent's name, shown in each simulator's header. */
  title?: string;
  /** The SMS provider's own replies; HELP is usually set to say who the agent is. */
  sms?: { helpReply?: string };
  /**
   * One person is one conversation on every platform that plays one of the agent's own channels,
   * as with real channels that know the person (by phone number, or the owner's `resolve`).
   * Otherwise each platform is a conversation of its own.
   */
  shareConversations?: boolean;
  /** How a custom UI shows the links in its params: the first card whose `match` is in the URL. */
  cards?: LinkCard[];
}

export interface LinkCard {
  /** Text the link's URL contains, such as "/video/". */
  match: string;
  /** The card's button, such as "Start video call". */
  label: string;
  /** What opening it shows: a call screen, or a page of the app (the default). */
  kind?: "call" | "page";
}

export type Line =
  | { kind: "in"; id: string | null; text: string; at: number; replyTo?: string; choice?: boolean }
  | {
      kind: "out";
      id: string;
      text: string;
      at: number;
      replyTo?: string;
      buttons?: string[];
      list?: { button: string; rows: ListRow[] };
      /** The channel's own params the agent filled in (an app_link): shown under the message. */
      fields?: Record<string, unknown>;
      sms?: { segments: number; encoding: string };
      /** Sent by the SMS carrier itself (STOP, START, HELP replies), not the agent. */
      carrier?: boolean;
    }
  | { kind: "reaction"; messageId: string; emoji: string; at: number; by: "agent" | "person" }
  | { kind: "read"; messageIds: string[]; at: number }
  /** A tool call by the agent: shown only in the simulator's debug mode, never to the person. */
  | {
      kind: "tool";
      callId: string;
      tool: string;
      input: unknown;
      at: number;
      status: "running" | "background" | "done" | "failed";
      ms?: number;
      output?: string;
      /** Cloud tests: which kind of response the tool simulator played, and what it changed. */
      played?: string;
      changes?: string[];
    }
  | { kind: "undelivered"; text: string; reason: string; at: number };

// What a US SMS provider sends for the standard keywords (Twilio's defaults).
const CARRIER = {
  stop: ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"],
  start: ["START", "YES", "UNSTOP"],
  help: ["HELP", "INFO"],
  stopReply: "You have successfully been unsubscribed. You will not receive any more messages from this number. Reply START to resubscribe.",
  startReply: "You have successfully been re-subscribed to messages from this number. Reply HELP for help. Reply STOP to unsubscribe. Msg&Data Rates May Apply.",
  helpReply: "Reply STOP to unsubscribe. Msg&Data Rates May Apply.",
};

const PAGE = readFileSync(new URL("./page.html", import.meta.url), "utf8");
const PERSON_PAGE = readFileSync(new URL("./person.html", import.meta.url), "utf8");
/** Changes every time the server starts, so an open page from an older run reloads itself. */
const BOOT = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const MAX_BODY = 16_384;

interface Thread {
  lines: Line[];
  agentCount: number;
  optedOut: boolean;
}

export function simulators(options: SimulatorsOptions = {}) {
  const clients = new Map<string, Set<ServerResponse>>();
  const threads = new Map<string, Thread>();
  const generations = new Map<string, number>();

  const key = (platformId: string, person: string) => `${platformId}:${person}`;
  const conversationId = (platformId: string, person: string, shared = false) => {
    const base = shared ? `person:${person}` : key(platformId, person);
    const generation = generations.get(base) ?? 0;
    return generation ? `${base}#${generation}` : base;
  };
  /** The threads a conversation shows in: one per platform, or each platform of a shared one. */
  const threadsOf = new Map<string, Set<string>>();
  const targets = (id: string) => threadsOf.get(keyOf(id)) ?? [keyOf(id)];
  /** The thread key a conversation id belongs to (the part before any #generation). */
  const keyOf = (id: string) => id.split("#")[0];
  const thread = (k: string) => {
    let t = threads.get(k);
    if (!t) threads.set(k, (t = { lines: [], agentCount: 0, optedOut: false }));
    return t;
  };

  function push(k: string, payload: unknown): void {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients.get(k) ?? []) client.write(data);
  }

  /** Record a line and show it to the open simulators. */
  function emitLine(k: string, line: Line): void {
    const t = thread(k);
    t.lines.push(line);
    if (t.lines.length > 500) t.lines.splice(0, t.lines.length - 500);
    push(k, { type: "line", line });
  }

  function findLine(k: string, id: string): Line | undefined {
    return thread(k).lines.find((l) => (l.kind === "in" || l.kind === "out") && l.id === id);
  }

  /** Tool calls in progress, by call id, so later events update the same line. */
  const toolLines = new Map<string, Extract<Line, { kind: "tool" }>>();

  const events: EventSink = (event: ParleyEvent) => {
    for (const k of targets(event.conversationId)) show(k, event);
  };

  function show(k: string, event: ParleyEvent): void {
    if (event.type === "tool.start" && typeof event.callId === "string") {
      const line: Extract<Line, { kind: "tool" }> = { kind: "tool", callId: event.callId, tool: String(event.tool), input: event.input, at: event.at, status: "running" };
      toolLines.set(`${k}:${event.callId}`, line);
      emitLine(k, line);
    } else if ((event.type === "tool.end" || event.type === "tool.detached" || event.type === "task.done") && typeof event.callId === "string") {
      const line = toolLines.get(`${k}:${event.callId}`);
      if (line) {
        line.ms = Number(event.ms);
        if (event.type === "tool.detached") line.status = "background";
        else {
          line.status = event.ok === false ? "failed" : "done";
          line.output = typeof event.output === "string" ? event.output : undefined;
          toolLines.delete(`${k}:${event.callId}`);
        }
        push(k, { type: "lineUpdate", line });
      }
    }
    if (event.type === "message.undelivered") {
      emitLine(k, { kind: "undelivered", text: String(event.text), reason: String(event.reason), at: event.at });
    }
    push(k, { type: "trace", event });
  }

  /** What the platform does with one thing the agent sends. Throws when it would not arrive. */
  function deliverer(p: Platform, k: string) {
    return (outbound: Outbound) => {
      const t = thread(k);
      if (outbound.type === "message") {
        if (t.optedOut) throw new Error("the person texted STOP, so the carrier blocks messages to them");
        const sms = p.segments ? smsSegments(outbound.text) : undefined;
        emitLine(k, {
          kind: "out",
          id: `a${++t.agentCount}`,
          text: outbound.text,
          at: Date.now(),
          ...(outbound.replyTo ? { replyTo: outbound.replyTo } : {}),
          ...(outbound.buttons ? { buttons: outbound.buttons } : {}),
          ...(outbound.list ? { list: outbound.list } : {}),
          ...(outbound.fields ? { fields: outbound.fields } : {}),
          ...(sms ? { sms: { segments: sms.segments, encoding: sms.encoding } } : {}),
        });
        return;
      }
      if (outbound.type === "reaction") {
        emitLine(k, { kind: "reaction", messageId: outbound.messageId, emoji: outbound.emoji, at: Date.now(), by: "agent" });
        return;
      }
      if (outbound.type === "read") {
        emitLine(k, { kind: "read", messageIds: outbound.messageIds, at: Date.now() });
        return;
      }
      push(k, { ...outbound, at: Date.now() });
    };
  }

  /** The SMS carrier's own handling of STOP, START and HELP. The text still reaches the agent. */
  function carrier(p: Platform, k: string, text: string): void {
    if (!p.carrierKeywords) return;
    const word = text.trim().toUpperCase();
    const t = thread(k);
    let reply: string | null = null;
    if (CARRIER.stop.includes(word)) {
      t.optedOut = true;
      reply = CARRIER.stopReply;
    } else if (CARRIER.start.includes(word)) {
      t.optedOut = false;
      reply = CARRIER.startReply;
    } else if (CARRIER.help.includes(word)) {
      reply = options.sms?.helpReply ?? CARRIER.helpReply;
    }
    if (reply) {
      const sms = smsSegments(reply);
      emitLine(k, { kind: "out", id: `a${++t.agentCount}`, text: reply, at: Date.now(), carrier: true, sms: { segments: sms.segments, encoding: sms.encoding } });
    }
  }

  function listen(agent: AgentConnection, port: number): Promise<{ close(): Promise<void>; url: string }> {
    const server = createServer(handler(agent));
    return new Promise((resolve) => {
      server.listen(port, "127.0.0.1", () =>
        resolve({
          // The bound port, so port 0 (any free port) works too.
          url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          close: () => new Promise<void>((done) => server.close(() => done())),
        }),
      );
    });
  }

  /**
   * The simulators as a request handler, served under `base` (such as "/simulator") so another
   * server can mount them; listen() serves them at the root of their own port.
   */
  function handler(agent: AgentConnection, base = "") {
    return (req: IncomingMessage, res: ServerResponse) =>
      handle(agent, req, res, base).catch((error) => {
        console.warn("parley simulators:", error);
        if (!res.headersSent) res.writeHead(500).end();
      });
  }

  async function handle(agent: AgentConnection, req: IncomingMessage, res: ServerResponse, base = ""): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    // The path inside the simulators, whatever they are mounted under.
    const path = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) || "/" : url.pathname;
    const qp = platformOf(url.searchParams.get("platform"));
    const qperson = (url.searchParams.get("person") || "demo").slice(0, 128);
    const qk = key(qp.id, qperson);
    const shared = (p: Platform, who: string) => Boolean(options.shareConversations && ownChannel(agent, p, conversationId(p.id, who)));

    if (req.method === "GET" && path === "/person") {
      const page = PERSON_PAGE.replaceAll("{{title}}", escapeHtml(options.title ?? "Agent")).replaceAll("{{base}}", base);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page);
      return;
    }
    if (req.method === "GET" && path === "/") {
      const page = PAGE.replaceAll("{{title}}", escapeHtml(options.title ?? "Agent")).replaceAll("{{boot}}", BOOT).replaceAll("{{base}}", base);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page);
      return;
    }
    if (req.method === "GET" && path === "/api/platforms") {
      const own = PLATFORMS.filter((p) => ownChannel(agent, p, conversationId(p.id, qperson))).map((p) => ({ platform: p.id, channel: ownChannel(agent, p, conversationId(p.id, qperson))!.name }));
      return json(res, 200, { platforms: PLATFORMS, own, cards: options.cards ?? [] });
    }
    if (req.method === "GET" && path === "/api/status") return json(res, 200, agent.status());
    if (req.method === "GET" && path === "/api/transcript") {
      const t = thread(qk);
      return json(res, 200, { platform: qp.id, person: qperson, optedOut: t.optedOut, lines: t.lines });
    }
    if (req.method === "POST" && path === "/api/reset") {
      // A shared conversation starts over on every platform it shows in.
      const base = shared(qp, qperson) ? `person:${qperson}` : qk;
      generations.set(base, (generations.get(base) ?? 0) + 1);
      for (const k of threadsOf.get(base) ?? [qk]) {
        threads.delete(k);
        push(k, { type: "reset" });
      }
      threadsOf.delete(base);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello", boot: BOOT })}\n\n`);
      const set = clients.get(qk) ?? new Set();
      set.add(res);
      clients.set(qk, set);
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        set.delete(res);
      });
      return;
    }

    const body = req.method === "POST" ? await readBody(req) : null;
    const p = typeof body?.platform === "string" ? platformOf(body.platform) : qp;
    const person = typeof body?.person === "string" && body.person ? body.person.slice(0, 128) : qperson;
    const k = key(p.id, person);

    if (req.method === "POST" && path === "/api/reactions") {
      const messageId = typeof body?.messageId === "string" ? body.messageId : "";
      const emoji = typeof body?.emoji === "string" ? body.emoji.slice(0, 16) : "";
      const target = findLine(k, messageId);
      if (!p.personReactions || !target || target.kind !== "out" || !emoji) {
        return json(res, 400, { error: "reactions need a platform that has them, an agent message id and an emoji" });
      }
      emitLine(k, { kind: "reaction", messageId, emoji, at: Date.now(), by: "person" });
      agent.reacted(conversationId(p.id, person, shared(p, person)), emoji, target.text);
      return json(res, 202, { ok: true });
    }

    if (req.method === "POST" && path === "/api/messages") {
      const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4_000) : "";
      if (!text) return json(res, 400, { error: "text is required" });
      const replyId = p.replies && typeof body?.replyTo === "string" ? body.replyTo : undefined;
      const quoted = replyId ? findLine(k, replyId) : undefined;
      const choice = body?.choice && typeof body.choice === "object" ? (body.choice as { id?: string; title?: string }) : undefined;
      const incoming: Incoming = {
        text,
        ...(quoted && (quoted.kind === "in" || quoted.kind === "out") ? { replyTo: { text: quoted.text, fromAgent: quoted.kind === "out" } } : {}),
        ...(choice?.title ? { choice: { id: choice.id, title: String(choice.title) } } : {}),
      };
      const at = Date.now();
      const line: Line = { kind: "in", id: null, text, at, ...(quoted ? { replyTo: replyId } : {}), ...(choice?.title ? { choice: true } : {}) };
      emitLine(k, line);
      carrier(p, k, text);
      const id = conversationId(p.id, person, shared(p, person));
      const own = ownChannel(agent, p, id);
      threadsOf.set(keyOf(id), (threadsOf.get(keyOf(id)) ?? new Set()).add(k));
      const messageId = agent.receive(id, incoming, deliverer(p, k), own ? { channel: own.info, channelName: own.name } : { channel: channelOf(p) });
      line.id = messageId;
      push(k, { type: "id", at, messageId });
      return json(res, 202, { messageId, at });
    }
    res.writeHead(404).end();
  }

  return { events, listen, handler, conversationId };
}

/** The agent's own channel a simulator plays, if it has one of that kind. */
function ownChannel(agent: AgentConnection, p: Platform, conversationId: string): ChannelSummary | undefined {
  const kind = p.id === "web" ? "custom" : p.id;
  return agent.channels?.(conversationId).find((c) => c.kind === kind);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
