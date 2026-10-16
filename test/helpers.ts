import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, sqlite, tool, type AgentOptions, type Database, type TemplateDefinition, type TestPerson } from "../src/index.ts";
import type { ChannelInfo, ChannelKind, ChatMessage, Keywords, Model, ModelRequest, ModelResponse, Outbound, ChinwagEvent, ToolCall } from "../src/index.ts";

/**
 * A model the test drives: each call waits for the test to answer it. The step Chinwag adds after a
 * reply that was only delivered messages is answered with nothing, and counted in `followUps`,
 * unless `followUps: "manual"`: then it is a call like any other.
 */
export function scriptedModel(options: { followUps?: "auto" | "manual" } = {}) {
  const calls: Array<{ request: ModelRequest; answer(r: ModelResponse): void; fail(error: Error): void }> = [];
  const followUps: ModelRequest[] = [];
  const waiters: Array<() => void> = [];
  const model: Model = {
    complete(request) {
      if (options.followUps !== "manual" && isFollowUp(request)) {
        followUps.push(request);
        return Promise.resolve({ text: null, toolCalls: [] });
      }
      return new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        calls.push({ request, answer: resolve, fail: reject });
        waiters.splice(0).forEach((w) => w());
      });
    },
  };
  async function nextCall(index: number) {
    while (calls.length <= index) await new Promise<void>((r) => waiters.push(r));
    return calls[index];
  }
  return { model, calls, followUps, nextCall };
}

/** The step after a response that only talked (sent messages, reacted), all of it delivered. */
function isFollowUp(request: ModelRequest): boolean {
  const i = request.messages.findLastIndex((m) => m.role === "assistant");
  const last = request.messages[i];
  if (!last || last.role !== "assistant" || !last.toolCalls?.length) return false;
  const after = request.messages.slice(i + 1);
  const talk = (name: string) => name.startsWith("send_") || name === "react" || name === "share_updates";
  return (
    last.toolCalls.every((c) => talk(c.name)) &&
    after.length === last.toolCalls.length &&
    after.every((m, k) => m.role === "tool" && (last.toolCalls![k].name.startsWith("send_") ? m.content.startsWith('{"delivered":true') : m.content === ""))
  );
}

export function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((r) => (open = r));
  return { promise, open };
}

let ids = 0;
export const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: `c${++ids}`, name, arguments: JSON.stringify(args) });
export const say = (text: string) => call("send_chat", { text });
export const respond = (...toolCalls: ToolCall[]): ModelResponse => ({ text: null, toolCalls });

export const WEB: ChannelInfo = { reactions: true, status: true };

export function harness(tools = [] as ReturnType<typeof tool>[], deadlineMs = 50, channel: ChannelInfo = WEB, followUps: "auto" | "manual" = "auto") {
  const dir = mkdtempSync(join(tmpdir(), "chinwag-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel({ followUps });
  const events: ChinwagEvent[] = [];
  const agent = createAgent({ dir, model: scripted.model, tools, deadlineMs, partialAfterMs: 20, debounceMs: 0, events: [(e) => events.push(e)] });
  const out: Outbound[] = [];
  let fail: string | null = null;
  const deliver = (o: Outbound) => {
    if (fail && o.type === "message") throw new Error(fail);
    out.push(o);
  };
  const sent = () => out.flatMap((o) => (o.type === "message" ? [o.text] : []));
  const send = (conversation: string, text: string) => agent.receive(conversation, text, deliver, { channel });
  return { agent, out, sent, send, events, failNext: (reason: string | null) => (fail = reason), ...scripted };
}

export const users = (messages: ChatMessage[]) => messages.filter((m) => m.role === "user").map((m) => m.content);
export const last = (messages: ChatMessage[]) => messages.at(-1) as { role: string; content: string };

export const WHATSAPP: ChannelInfo = {
  reactions: true,
  status: false,
  formatting: "whatsapp",
  maxLength: 4096,
  replies: true,
  buttons: { max: 3, labelMax: 20 },
  lists: { maxRows: 10, titleMax: 24, buttonMax: 20 },
  readReceipts: true,
};
export const SMS: ChannelInfo = { reactions: false, status: false, formatting: "plain", maxLength: 1600 };

export const WEB_APP: ChannelInfo = { reactions: true, status: true, formatting: "markdown", buttons: { max: 3, labelMax: 20 } };

/** An agent with real channels (by name), for one person across several of them. */
export function multi(options: {
  /** Each channel is custom unless it names its kind. */
  channels: Record<string, { info: ChannelInfo; phone?: boolean; kind?: ChannelKind; keywords?: Keywords }>;
  tools?: ReturnType<typeof tool>[];
  database?: Database;
  resolve?: (identity: { channel: string; address: string }) => string | null;
  now?: () => number;
  timeZone?: string;
  dir?: string;
  testPeople?: TestPerson[];
  templates?: TemplateDefinition[];
  history?: { maxTokens?: number; toolResultChars?: number };
  defaultCountryCode?: string;
  intercept?: AgentOptions["intercept"];
  profile?: AgentOptions["profile"];
}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "chinwag-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const database = options.database ?? sqlite();
  const events: ChinwagEvent[] = [];
  const out: Array<{ channel: string; address: string; outbound: Outbound }> = [];
  const channels = Object.entries(options.channels).map(([name, c]) => ({
    name,
    kind: "custom" as const,
    ...c,
    send: (address: string, outbound: Outbound) => void out.push({ channel: name, address, outbound }),
  }));
  const agent = createAgent({
    dir,
    model: scripted.model,
    tools: options.tools ?? [],
    deadlineMs: 50,
    debounceMs: 0,
    events: [(e) => events.push(e)],
    channels,
    database,
    resolve: options.resolve,
    now: options.now,
    timeZone: options.timeZone,
    testPeople: options.testPeople,
    templates: options.templates,
    history: options.history,
    defaultCountryCode: options.defaultCountryCode,
    intercept: options.intercept,
    profile: options.profile,
    scheduleCheckMs: 0,
  });
  const texts = (channel?: string) =>
    out.flatMap((o) => (o.outbound.type === "message" && (!channel || o.channel === channel) ? [o.outbound.text] : []));
  const message = (channel: string, from: string, text: string) => agent.message({ channel, from, message: text });
  /** The first model call from `from` on that satisfies `test` (earlier ones were restarted by a later message). */
  async function callWith(from: number, test: (c: Awaited<ReturnType<typeof scripted.nextCall>>) => boolean) {
    for (let i = from; ; i++) {
      const c = await scripted.nextCall(i);
      if (test(c)) return { call: c, index: i };
    }
  }
  return { agent, out, texts, message, events, callWith, dir, database, ...scripted };
}
