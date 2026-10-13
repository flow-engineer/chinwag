// An agent: instructions, skills and tools, and one Conversation per person, across every channel
// they write on. Channels hand it messages; it says whether anything is running, so a host can stop
// it when it is idle. Its state lives in a database (in memory unless one is given), so a restart
// carries on where it stopped.
//
// Who a person is gets fixed when their message arrives, from what the channel verified, never
// from anything the model or a tool says: the owner's own key from `resolve`, else the phone
// number of a phone channel (SMS, WhatsApp, iMessage verify it), else that channel's address alone.
// Identities with the same key are one person in one conversation.

import { randomUUID } from "node:crypto";
import { summarize, type Channel, type ChannelSummary } from "./channels.ts";
import { Conversation, windowClosed, type ChannelLink, type ConversationSettings } from "./conversation.ts";
import { sqlite, type Database } from "./db.ts";
import { emitter, type EventSink } from "./events.ts";
import { addBusinessSchedule, claimDue } from "./schedules.ts";
import { loadInstructions, loadSkills, skillTool } from "./skills.ts";
import { Store, type ConversationRow, type IdentityRow } from "./store.ts";
import { toSpec, type Tool } from "./tools.ts";
import type { ChannelInfo, Deliver, Incoming, Model, Outbound } from "./types.ts";

export interface AgentOptions {
  /** Folder holding AGENTS.md and skills/<name>/SKILL.md. */
  dir: string;
  model: Model;
  tools?: Tool[];
  /** Added to the system prompt at the start of every turn: who this person is, the time. */
  context?: (conversationId: string) => Promise<string> | string;
  /**
   * Answer some messages without the model (STOP, HELP): return the reply, "" to send nothing, or
   * null to let the agent reply.
   */
  intercept?: (conversationId: string, text: string) => string | null;
  /**
   * Put every skill's full text in the prompt instead of loading skills on demand. Saves a model
   * round trip per skill; worth it when the skills are few and short.
   */
  inlineSkills?: boolean;
  /**
   * Live status lines (share_updates) on channels that can show them, web and app UIs. Default on;
   * pass a string to replace Parley's guidance on when and what to share.
   */
  shareUpdates?: boolean | string;
  /**
   * The longest a reply waits for a tool that sets no `deadlineMs` of its own; past it the tool
   * moves to the background. Default 60,000 ms. Before that, the reply waits for all of a
   * response's tools unless the person writes again or `partialAfterMs` passes.
   */
  deadlineMs?: number;
  /** When one tool of a response is done and the others are still running this long after, the finished results go back to the agent. Default 5,000 ms. */
  partialAfterMs?: number;
  /** Quiet time after a message before the reply starts, to catch quick bursts. Default 300 ms. */
  debounceMs?: number;
  maxSteps?: number;
  events?: EventSink[];
  /** This agent's id in the database (several agents can share one). Default "default". */
  id?: string;
  /** Where Parley keeps its state. Default: SQLite in memory (gone on restart). */
  database?: Database;
  /** The channels people reach the agent on: whatsapp(...), sms(...), customUI(...), each with its own name. */
  channels?: Channel[];
  /**
   * The owner's own key for a person (a member id), from a channel identity, or null when there is
   * none. Identities with the same key are one person.
   */
  resolve?: (identity: { channel: string; address: string }) => Promise<string | null> | string | null;
  /** The business's time zone (IANA), for scheduled messages when a person's is not known. */
  timeZone?: string;
  /** How often due scheduled messages are looked for. Default 5,000 ms; 0 turns the timer off. */
  scheduleCheckMs?: number;
  /** The clock (tests move it). */
  now?: () => number;
}

export interface AgentStatus {
  busy: boolean;
  /** Milliseconds since the last thing ran anywhere; 0 while busy. */
  idleForMs: number;
  conversations: number;
  backgroundTasks: number;
}

export interface ReceiveOptions {
  /** What the channel can show. Default: plain text only (no reactions, no status). */
  channel?: ChannelInfo;
  /** The channel's own id for the message; Parley makes one (m1, m2, ...) otherwise. */
  messageId?: string;
  /** The channel's name. Default "chat". */
  channelName?: string;
}

export interface NudgeInput {
  /** The person, by a channel identity they have written from. */
  to: { channel: string; address: string };
  /** Sent as written, with no model call. */
  text?: string;
  /** The agent gets a turn with this note and writes the message itself, or sends nothing. */
  prompt?: string;
  /** A template the owner already set up with the channel, sent as is (also outside WhatsApp's window). */
  template?: { name: string; language?: string; variables?: Record<string, string> };
  /** Send it later, at this time (ms since the epoch), as a scheduled message. */
  at?: number;
  /** The same key twice sends once; the second call gets the first's result. */
  idempotencyKey?: string;
}

export interface NudgeResult {
  id: string;
  /** sent, silent (the agent chose not to), dropped (a no-contact rule), refused, failed, or scheduled. */
  status: string;
  reason?: string;
}

const NO_EXTRAS: ChannelInfo = { reactions: false, status: false };

export class Agent {
  private readonly conversations = new Map<string, Conversation>();
  private readonly options: AgentOptions;
  private readonly settings: ConversationSettings;
  private readonly store: Store;
  private readonly startedAt = Date.now();
  /** Conversations in the store, known once resume() ran. */
  private readonly rows = new Map<string, ConversationRow>();
  private resumed = false;
  private readonly arriving = new Map<string, Promise<unknown>>();
  private readonly nudgeWaiters = new Map<string, (result: NudgeResult) => void>();
  private readonly now: () => number;
  private readonly channelsByName: Map<string, Channel>;

  constructor(options: AgentOptions) {
    this.options = options;
    this.channelsByName = new Map((options.channels ?? []).map((c) => [c.name, c]));
    if (this.channelsByName.size !== (options.channels ?? []).length) throw new Error("parley: two channels have the same name");
    this.now = options.now ?? Date.now;
    const emit = emitter(options.events ?? []);
    const skills = loadSkills(options.dir);
    const tools = [...(options.tools ?? [])];
    if (skills.length && !options.inlineSkills) tools.push(skillTool(skills, (id, name) => emit(id, "skill.loaded", { skill: name })));
    this.store = new Store(options.database ?? sqlite(), options.id ?? "default");
    this.settings = {
      model: options.model,
      tools: new Map(tools.map((t) => [t.name, t])),
      specs: tools.map(toSpec),
      instructions: loadInstructions(options.dir, skills, options.inlineSkills),
      context: options.context,
      deadlineMs: options.deadlineMs ?? 60_000,
      partialAfterMs: options.partialAfterMs ?? 5_000,
      debounceMs: options.debounceMs ?? 300,
      maxSteps: options.maxSteps ?? 8,
      maxRestarts: Number.POSITIVE_INFINITY,
      talk: {
        shareUpdates: options.shareUpdates !== false,
        shareUpdatesInstructions: typeof options.shareUpdates === "string" ? options.shareUpdates : undefined,
      },
      emit,
      store: this.store,
      ready: this.store.migrate(),
      now: this.now,
      timeZone: options.timeZone,
      tagChannels: (options.channels ?? []).length > 1,
      links: (id) => this.links(id),
      settle: (target, status, reason) => this.settle(target, status, reason),
    };
    const every = options.scheduleCheckMs ?? 5_000;
    if (every > 0) setInterval(() => void this.runDue().catch((error) => console.warn("parley: scheduled messages:", error)), every).unref();
  }

  /**
   * Loads what the database holds and carries on: turns cut off by a restart run again, events not
   * yet handled are handled, background tools that were running are reported as interrupted. A
   * durable database needs this before the first message.
   */
  async resume(): Promise<void> {
    await this.settings.ready;
    for (const row of await this.store.allConversations()) this.rows.set(row.id, row);
    this.resumed = true;
    for (const id of await this.store.unfinished()) this.open(id);
  }

  /**
   * A message from a person on a channel set up in `channels`. Returns the conversation and the id
   * the agent knows the message by, or null when `intercept` answered it.
   */
  async message(input: { channel: string; from: string; message: string | Incoming; messageId?: string }): Promise<{ conversationId: string; messageId: string } | null> {
    const adapter = this.channelsByName.get(input.channel);
    if (!adapter) throw new Error(`parley: no channel named ${input.channel}`);
    this.mustBeResumed();
    // Messages from one address are taken in order, so a new person is made only once.
    const key = `${input.channel}\u0000${input.from}`;
    const previous = this.arriving.get(key) ?? Promise.resolve();
    const handled = previous.then(() => this.arrive(adapter, input));
    this.arriving.set(key, handled.catch(() => undefined));
    return handled;
  }

  private async arrive(adapter: Channel, input: { channel: string; from: string; message: string | Incoming; messageId?: string }) {
    await this.settings.ready;
    const conversationId = await this.conversationFor(adapter, input.channel, input.from);
    const conversation = this.open(conversationId);
    const deliver: Deliver = (outbound) => adapter.send(input.from, outbound);
    conversation.link({ name: input.channel, info: adapter.info, params: adapter.params, instructions: adapter.instructions, address: input.from, deliver, lastMessageAt: null });
    const text = typeof input.message === "string" ? input.message : input.message.text;
    const fixed = this.options.intercept?.(conversationId, text) ?? null;
    if (fixed !== null) {
      if (fixed) await deliver({ type: "message", text: fixed });
      return null;
    }
    return { conversationId, messageId: conversation.receive(input.message, { channel: input.channel, messageId: input.messageId }) };
  }

  /** The conversation an identity belongs to, made (and linked) the first time it writes. */
  private async conversationFor(adapter: Channel, channel: string, address: string): Promise<string> {
    const known = await this.store.identity(channel, address);
    if (known) return known.conversationId;
    const owner = await this.options.resolve?.({ channel, address });
    const [personKey, verifiedBy] = owner ? [`key:${owner}`, "resolver"] : adapter.phone ? [`phone:${normalizePhone(address)}`, "phone"] : [`${channel}:${address}`, "channel"];
    const existing = await this.store.conversationByKey(personKey);
    const id = existing?.id ?? `p_${randomUUID().slice(0, 12)}`;
    if (!existing) {
      await this.store.createConversation(id, personKey);
      const row = await this.store.conversation(id);
      if (row) this.rows.set(id, row);
    }
    await this.store.addIdentity(id, channel, address, verifiedBy);
    return id;
  }

  /**
   * A message from a person; replies go to `deliver`, the channel it came in on. Returns the id
   * the agent knows the message by, or null when `intercept` answered it. The conversation is
   * this id alone: use message() and `channels` for one person across several channels. When
   * `channelName` is one of the agent's channels, its definition (what it shows, its params) is
   * used and replies go to `deliver`: that is how the simulators play an agent's own channels.
   */
  receive(conversationId: string, message: string | Incoming, deliver: Deliver, options: ReceiveOptions = {}): string | null {
    const text = typeof message === "string" ? message : message.text;
    const fixed = this.options.intercept?.(conversationId, text) ?? null;
    if (fixed !== null) {
      if (fixed) void deliver({ type: "message", text: fixed });
      return null;
    }
    this.mustBeResumed();
    const name = options.channelName ?? "chat";
    const defined = this.channelsByName.get(name);
    const isNew = !this.conversations.has(conversationId) && !this.rows.has(conversationId);
    const conversation = this.open(conversationId, `${name}:${conversationId}`);
    if (isNew) conversation.persist(() => this.store.addIdentity(conversationId, name, conversationId, "channel"));
    conversation.link({ name, info: defined?.info ?? options.channel ?? NO_EXTRAS, params: defined?.params, instructions: defined?.instructions, address: conversationId, deliver, lastMessageAt: null });
    return conversation.receive(message, { channel: name, messageId: options.messageId });
  }

  /** The person reacted to one of the agent's messages; the agent learns it at its next turn. */
  reacted(conversationId: string, emoji: string, toText: string): void {
    this.conversations.get(conversationId)?.reacted(emoji, toText);
  }

  /** The channel reports that a message did not reach the person; the agent hears about it. */
  undelivered(conversationId: string, text: string, reason: string): void {
    this.conversations.get(conversationId)?.undelivered(text, reason);
  }

  conversation(conversationId: string): Conversation | undefined {
    return this.conversations.get(conversationId);
  }

  /**
   * A message the business starts. Resolves once it is settled: sent, silent (a prompt nudge the
   * agent chose not to send), dropped (a no-contact rule covers it), refused (outside_window,
   * unknown_person) or failed; or scheduled, for one with `at`.
   */
  async nudge(input: NudgeInput): Promise<NudgeResult> {
    await this.settings.ready;
    const kinds = [input.text, input.prompt, input.template].filter((v) => v !== undefined).length;
    if (kinds !== 1) throw new Error("parley: a nudge has exactly one of text, prompt or template");
    if (input.idempotencyKey) {
      const earlier = await this.store.nudgeByKey(input.idempotencyKey);
      if (earlier) return this.result(earlier.id, earlier.status, earlier.reason);
    }
    const identity = await this.store.identity(input.to.channel, input.to.address);
    if (!identity) return { id: "", status: "refused", reason: "unknown_person" };
    const id = `n_${randomUUID().slice(0, 8)}`;
    const conversationId = identity.conversationId;
    const record = { id, conversationId, channel: input.to.channel, idempotencyKey: input.idempotencyKey ?? null, reason: null };
    if (input.at !== undefined) {
      if (input.template) throw new Error("parley: a template nudge cannot be scheduled yet");
      const zone = (await this.store.conversation(conversationId))?.timeZone ?? this.options.timeZone ?? "UTC";
      await addBusinessSchedule(this.store, conversationId, input.to.channel, input.at, zone, { text: input.text, prompt: input.prompt });
      await this.store.addNudge({ ...record, body: { text: input.text, prompt: input.prompt, at: input.at }, status: "scheduled" });
      return { id, status: "scheduled" };
    }
    const body = input.template ? { template: input.template } : input.text !== undefined ? { text: input.text } : { prompt: input.prompt };
    if (!input.template && windowClosed({ info: this.infoOf(input.to.channel, conversationId), lastMessageAt: identity.lastMessageAt }, this.now())) {
      await this.store.addNudge({ ...record, body, status: "refused", reason: "outside_window" });
      return { id, status: "refused", reason: "outside_window" };
    }
    const settled = new Promise<NudgeResult>((resolve) => this.nudgeWaiters.set(id, resolve));
    const inbox = await this.store.addNudge({ ...record, body, status: "queued" });
    this.wake(conversationId, inbox);
    return settled;
  }

  /** Looks for due scheduled messages once and hands each to its conversation. Returns how many. */
  async runDue(): Promise<number> {
    await this.settings.ready;
    if (this.store.db.durable && !this.resumed) return 0;
    const now = this.now();
    const queued = await claimDue(this.store, now, async (s) => {
      const identity = (await this.store.identities(s.conversationId)).find((i) => i.channel === s.channel);
      if (!identity) return `no way to reach them on ${s.channel}`;
      return windowClosed({ info: this.infoOf(s.channel, s.conversationId), lastMessageAt: identity.lastMessageAt }, now) ? "outside_window" : null;
    });
    for (const q of queued) this.wake(q.conversationId, q.inbox);
    return queued.length;
  }

  /** The agent's channels without their sends: what the simulators and the test cloud play. */
  channels(): ChannelSummary[] {
    return [...this.channelsByName.values()].map(summarize);
  }

  status(): AgentStatus {
    const all = [...this.conversations.values()];
    const busy = all.some((c) => c.busy);
    const idle = all.length ? Math.min(...all.map((c) => c.idleForMs)) : Date.now() - this.startedAt;
    return {
      busy,
      idleForMs: busy ? 0 : idle,
      conversations: all.length,
      backgroundTasks: all.reduce((n, c) => n + c.backgroundTasks.length, 0),
    };
  }

  /** The conversation in memory, made (and loaded from the store, if it is there) when needed. */
  private open(id: string, personKey = id): Conversation {
    let conversation = this.conversations.get(id);
    if (!conversation) {
      const row = this.rows.get(id) ?? null;
      conversation = new Conversation(id, row?.personKey ?? personKey, this.settings, row);
      this.conversations.set(id, conversation);
    }
    return conversation;
  }

  /** An inbox row for a conversation: handed to it in memory, or found when it loads. */
  private wake(conversationId: string, inbox: number): void {
    const resident = this.conversations.get(conversationId);
    if (!resident) {
      void this.store.conversation(conversationId).then((row) => {
        if (row) this.rows.set(conversationId, row);
        this.open(conversationId);
      });
      return;
    }
    void this.store.openInbox(conversationId).then((rows) => {
      const row = rows.find((r) => r.id === inbox);
      if (row) resident.enqueue(row);
    });
  }

  private async links(conversationId: string): Promise<ChannelLink[]> {
    const identities: IdentityRow[] = await this.store.identities(conversationId);
    return identities.flatMap((i) => {
      const adapter = this.channelsByName.get(i.channel);
      if (!adapter) return [];
      return [{ name: i.channel, info: adapter.info, params: adapter.params, instructions: adapter.instructions, address: i.address, deliver: (o: Outbound) => adapter.send(i.address, o), lastMessageAt: i.lastMessageAt }];
    });
  }

  /** What a channel can show: its adapter's, else what the conversation was last told. */
  private infoOf(channel: string, conversationId: string): ChannelInfo {
    return this.channelsByName.get(channel)?.info ?? this.conversations.get(conversationId)?.channelInfo(channel) ?? NO_EXTRAS;
  }

  private async settle(target: { run?: string; nudge?: string }, status: string, reason?: string): Promise<void> {
    if (target.run) await this.store.settleRun(target.run, status, reason);
    if (target.nudge) {
      await this.store.settleNudge(target.nudge, status, reason);
      this.nudgeWaiters.get(target.nudge)?.(this.result(target.nudge, status, reason));
      this.nudgeWaiters.delete(target.nudge);
    }
  }

  private result(id: string, status: string, reason?: string | null): NudgeResult {
    return reason ? { id, status, reason } : { id, status };
  }

  private mustBeResumed(): void {
    if (this.store.db.durable && !this.resumed) throw new Error("parley: call await agent.resume() before the first message when the database is durable");
  }
}

/** A phone number as one string however it was typed: digits, with a leading + kept. */
function normalizePhone(address: string): string {
  const digits = address.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? `+${digits.slice(1).replace(/\+/g, "")}` : digits;
}

export function createAgent(options: AgentOptions): Agent {
  return new Agent(options);
}
