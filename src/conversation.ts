// One conversation: an actor that owns one person's history, across every channel they write
// on, and runs one turn at a time.
//
// - Typing shows the moment a message arrives; it stops once the person has been acknowledged.
// - Double texts fold into the reply in progress. Someone who sends another message is usually
//   correcting themselves, so a model step in flight is aborted and runs again with every message
//   so far; one that arrives while tools run ends the wait for them (below).
// - The person sees only what the agent sends with its send tools, react or share_updates.
// - Acknowledgement first: after the person writes, the agent's first response must reach them,
//   on every channel they are waiting on. A first response that only calls tools is held, and the
//   agent is asked to acknowledge in the same response as those calls.
// - Tools in one response run together, and the reply waits for all of them: one answer, not an
//   acknowledgement and a result later. A tool moves to the background (the agent is told, the
//   person is not) only when the person writes again meanwhile, when another tool of the response
//   finished partialAfterMs ago (the finished results go back now), or past its own limit
//   (deadlineMs). Its result comes back into this chat later; the same call with the same input
//   while it runs is not run again. Messages go out in the order the agent wrote them, while tools run.
// - A sent message's result says it was delivered. A reply to the person of only messages, in a turn
//   where the agent used no tool, gets one more step (it may have said "getting your plan" and meant
//   to act next); a second such response ends the turn. A message that fails to arrive comes back to the agent as
//   a message.
// - A background result the agent says nothing about, with no other tool pending, is sent back
//   once: it may have written the answer as plain text, which never reaches the person. A result
//   returned to its response is sent back only when the agent answers it in new plain text: silence
//   is left alone, and text repeating a message already sent counts as said.
// - Several channels: each message is tagged with its channel, the agent answers each on its own
//   channel, and a send on a channel missing from their last 5 messages is held until the agent
//   confirms it.
// - Everything is kept in the store as it happens: the history, the inbox of events not yet
//   handled, background tools in flight. After a restart the conversation carries on.
// - Scheduled messages and nudges arrive through the inbox and wait for the turn in progress.

import type { z } from "zod";
import type { Emit } from "./events.ts";
import { coveredBy, noContactTools, rulesSection } from "./nudges.ts";
import { scheduleTools } from "./schedules.ts";
import type { ConversationRow, InboxRow, StoreApi } from "./store.ts";
import { REACT, UPDATE, reactInput, sendInput, sendToolName, talkInstructions, talkSpecs, updateInput, type ChannelView, type SendInput, type TalkSettings } from "./talk.ts";
import { render, toSpec, type Tool } from "./tools.ts";
import type { ChannelInfo, ChatMessage, Deliver, Incoming, Model, Outbound, ToolCall, ToolSpec } from "./types.ts";

export interface ConversationSettings {
  model: Model;
  tools: Map<string, Tool>;
  specs: ToolSpec[];
  instructions: string;
  /** Per-turn context for the system prompt (the person's profile, the time). */
  context?: (conversationId: string) => Promise<string> | string;
  /** The longest a reply waits for a tool that sets no limit of its own. */
  deadlineMs: number;
  /** When one tool of a response is done and others still run this long after, the finished results go back. */
  partialAfterMs: number;
  debounceMs: number;
  maxSteps: number;
  /** How many times one step restarts for new messages before it lets the step finish. */
  maxRestarts: number;
  talk: TalkSettings;
  emit: Emit;
  store: StoreApi;
  /** Resolves once the store's tables exist. */
  ready: Promise<void>;
  now: () => number;
  /** The agent's own time zone (the business's), for schedules when the person's is not known. */
  timeZone?: string;
  /** Tag every message with its channel (the agent has several), even for a person on one so far. */
  tagChannels: boolean;
  /** How the channels of a conversation loaded from the store are reached again. */
  links(conversationId: string): Promise<ChannelLink[]>;
  /** Records how a scheduled run or a nudge ended. */
  settle(target: { run?: string; nudge?: string }, status: string, reason?: string): Promise<void>;
}

/** One channel this person writes on, and how to reach them there. */
export interface ChannelLink {
  name: string;
  info: ChannelInfo;
  /** The channel's own extra fields on its send tool. */
  params?: Record<string, z.ZodType>;
  /** The agent author's guidance for this channel, in the system prompt while it is in use. */
  instructions?: string;
  address: string;
  deliver: Deliver;
  lastMessageAt: number | null;
}

const ACKNOWLEDGE_FIRST =
  "[Parley] They have not heard from you yet. In one response, acknowledge them " +
  "(react to their message or send a short line) and make your tool calls again.";
const INTERRUPTED = "[Parley] Cut off by a restart: this may or may not have happened. Check before you rely on it.";

/** A tool call the reply is waiting on. */
interface Running {
  call: ToolCall;
  input: string;
  startedAt: number;
  limitMs: number;
  outcome: Promise<{ ok: boolean; text: string }>;
  result?: { ok: boolean; text: string };
}

/** Why a tool stopped holding the reply: the person wrote, the others are done, or its limit passed. */
type Detach = "message" | "partial" | "limit";

interface Task {
  id: string;
  tool: string;
  /** Its input, as checked, with keys in a fixed order: a repeat of a running call has the same. */
  input: string;
  startedAt: number;
}

/** A scheduled run or a prompt nudge whose turn owes the person a message. */
interface Owed {
  run?: string;
  nudge?: string;
  mode: "message" | "check" | "prompt";
  channel: string;
}

interface Pending {
  id: string;
  text: string;
  channel: string;
  inbox?: number;
}

interface Note {
  text: string;
  inbox?: number;
  owed?: Owed;
  /** Learned at the next turn, but does not start one (the person's reaction). */
  wait?: boolean;
}

/** Sent without the model: a fixed-text scheduled message, or a text or template nudge. */
interface Direct {
  inbox?: number;
  channel: string;
  text?: string;
  template?: { name: string; language?: string; variables?: Record<string, string> };
  run?: string;
  nudge?: string;
}

export class Conversation {
  readonly id: string;
  readonly personKey: string;
  readonly history: ChatMessage[] = [];
  private readonly settings: ConversationSettings;
  private readonly channels = new Map<string, ChannelLink>();
  private pending: Pending[] = [];
  private notes: Note[] = [];
  /** A tool's result is in the history and no message has gone out since: from the background, or returned to a response. */
  private resultUnsent: false | "background" | "returned" = false;
  /** What the agent has sent in this turn, to tell its own text repeated from something new. */
  private sentThisTurn = new Set<string>();
  private direct: Direct[] = [];
  private owed: Owed[] = [];
  /** The person's message ids, and the channel each came on. */
  private readonly messageIds = new Map<string, string>();
  private readonly knownInbox = new Set<number>();
  private messageCount = 0;
  private recentChannels: string[] = [];
  private timeZone: string | null = null;
  private running = false;
  private stepAbort: AbortController | null = null;
  /** Ends the reply's wait for its tools now (the person wrote). */
  private wakeTools: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly tasks = new Map<string, Task>();
  private taskCount = 0;
  private idleSince = Date.now();
  private settled: Array<() => void> = [];
  /** Channels where nothing has reached the person since their latest message there. */
  private readonly unanswered = new Set<string>();
  /** The next model response is the first since their latest message. */
  private firstResponse = false;
  private readonly typingOn = new Set<string>();
  /** The send tool for each channel, this turn. */
  private sendTools = new Map<string, string>();
  private readonly builtins: Map<string, Tool>;
  private readonly builtinSpecs: ToolSpec[];
  private readonly loaded: Promise<void>;
  private writes: Promise<void>;
  /** History entries already in the store. */
  private saved = 0;
  /** A turn was cut off by a restart: it runs again with the history so far. */
  private resumeTurn = false;
  /** Forgotten: nothing more runs, is sent or is kept. */
  private closed = false;

  constructor(id: string, personKey: string, settings: ConversationSettings, existing: ConversationRow | null = null) {
    this.id = id;
    this.personKey = personKey;
    this.settings = settings;
    if (existing) {
      this.messageCount = existing.messageCount;
      this.recentChannels = existing.recentChannels;
      this.timeZone = existing.timeZone;
    }
    const builtins = [
      ...scheduleTools({
        store: settings.store,
        conversationId: id,
        channel: () => this.currentChannel(),
        now: settings.now,
        personZone: () => this.timeZone,
        setPersonZone: (zone) => {
          this.timeZone = zone;
          return this.persist(() => settings.store.updateConversation(id, { timeZone: zone }));
        },
        agentZone: settings.timeZone,
      }),
      ...noContactTools({ store: settings.store, conversationId: id, now: settings.now, zone: () => this.timeZone ?? settings.timeZone ?? "UTC" }),
    ];
    this.builtins = new Map(builtins.map((t) => [t.name, t]));
    this.builtinSpecs = builtins.map(toSpec);
    this.loaded = settings.ready.then(() => (existing ? this.load() : settings.store.createConversation(id, personKey)));
    this.writes = this.loaded.catch((error) => console.warn(`parley: conversation ${id} did not load:`, error));
  }

  /** What a channel of this conversation can show, if the person has written on it. */
  channelInfo(channel: string): ChannelInfo | undefined {
    return this.channels.get(channel)?.info;
  }

  /** Reach the person on this channel (again): a new channel, or a fresh way to deliver. */
  link(link: ChannelLink): void {
    const known = this.channels.get(link.name);
    if (known) {
      known.deliver = link.deliver;
      known.info = link.info;
      known.params = link.params;
      known.instructions = link.instructions;
      known.address = link.address;
    } else this.channels.set(link.name, link);
  }

  /** A message from the person on `channel`; returns the id the agent sees it by. */
  receive(input: string | Incoming, options: { channel: string; messageId?: string }): string {
    const incoming: Incoming = typeof input === "string" ? { text: input } : input;
    const channel = options.channel;
    const id = options.messageId ?? `m${++this.messageCount}`;
    const at = this.settings.now();
    this.messageIds.set(id, channel);
    const item: Pending = { id, text: describe(incoming), channel };
    this.pending.push(item);
    this.recentChannels = [...this.recentChannels, channel].slice(-5);
    const link = this.channels.get(channel);
    if (link) link.lastMessageAt = at;
    const fields = { messageCount: this.messageCount, recentChannels: this.recentChannels };
    this.persist(async () => {
      item.inbox = await this.settings.store.addInbox(this.id, "message", { id, text: item.text, channel });
      this.knownInbox.add(item.inbox);
      await this.settings.store.updateConversation(this.id, fields);
      if (link) await this.settings.store.touchIdentity(channel, link.address, at);
    });
    this.settings.emit(this.id, "message.in", { text: incoming.text, messageId: id, channel, replyTo: incoming.replyTo, choice: incoming.choice });
    this.unanswered.add(channel);
    this.firstResponse = true;
    void this.typing(true, channel);
    if (this.running) {
      // Fold it in: a model step in flight is thrown away and run again with this message, and
      // tools being waited on move to the background so the agent reads it now.
      this.stepAbort?.abort();
      this.wakeTools?.();
      return id;
    }
    this.schedule(this.settings.debounceMs);
    return id;
  }

  /** An event from the inbox (a scheduled run, a nudge) for this conversation. */
  enqueue(row: InboxRow): void {
    if (this.knownInbox.has(row.id)) return;
    this.knownInbox.add(row.id);
    const p = row.payload as Record<string, any>;
    if (row.kind === "message") {
      this.pending.push({ id: p.id, text: p.text, channel: p.channel, inbox: row.id });
      this.messageIds.set(p.id, p.channel);
      this.unanswered.add(p.channel);
      this.firstResponse = true;
      this.wakeTools?.();
    } else if (row.kind === "note") {
      this.notes.push({ text: p.text, inbox: row.id, wait: p.wait === true });
    } else if (row.kind === "schedule") {
      if (p.fixed) this.direct.push({ inbox: row.id, channel: p.channel, text: p.text, run: p.run });
      else this.notes.push({ text: p.text, inbox: row.id, owed: { run: p.run, mode: p.mode, channel: p.channel } });
    } else if (row.kind === "nudge") {
      if (p.prompt !== undefined) {
        const text = `[Nudge from the business, not from the person: ${p.prompt}] Write it to them now in your own words, or send nothing if it does not fit what they asked not to be messaged about.`;
        this.notes.push({ text, inbox: row.id, owed: { nudge: p.nudge, mode: "prompt", channel: p.channel } });
      } else this.direct.push({ inbox: row.id, channel: p.channel, text: p.text, template: p.template, nudge: p.nudge });
    }
    if (!this.running && this.hasWork()) this.schedule(0);
  }

  /**
   * The person reacted to one of the agent's messages. The agent learns it at its next turn; a
   * reaction alone does not start one.
   */
  reacted(emoji: string, toText: string): void {
    this.settings.emit(this.id, "reaction.in", { emoji, toText });
    this.note(`[They reacted ${emoji} to your message: "${clip(toText)}"]`, true);
  }

  /** The channel reports, now or later, that a message did not reach the person. */
  undelivered(text: string, reason: string): void {
    this.settings.emit(this.id, "message.undelivered", { text, reason });
    this.note(`[Not delivered] "${text}": ${reason}`);
  }

  get busy(): boolean {
    return this.running || this.timer !== null || this.tasks.size > 0;
  }

  get idleForMs(): number {
    return this.busy ? 0 : Date.now() - this.idleSince;
  }

  get backgroundTasks(): Task[] {
    return [...this.tasks.values()];
  }

  /** Resolves once nothing is running or waiting (no turn, no background task) and all is stored. */
  async whenIdle(): Promise<void> {
    if (this.busy) await new Promise<void>((resolve) => this.settled.push(resolve));
    await this.writes;
  }

  /** Resolves once everything so far is in the store. */
  stored(): Promise<void> {
    return this.writes;
  }

  /**
   * The person was forgotten: a step in flight is cut off, nothing waiting runs, nothing more is
   * sent or kept. Tools already running finish on their own, and their results go nowhere.
   */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
    this.notes = [];
    this.direct = [];
    this.stepAbort?.abort();
    this.wakeTools?.();
  }

  /** Runs `work` after every earlier write to the store, in order. */
  persist(work: () => Promise<unknown>): Promise<void> {
    if (this.closed) return this.writes;
    const next = this.writes.then(work).then(
      () => undefined,
      (error) => console.warn(`parley: could not save conversation ${this.id}:`, error),
    );
    this.writes = next;
    return next;
  }

  /** Picks up where the conversation was: its history, events not yet handled, tools cut off. */
  private async load(): Promise<void> {
    const { store } = this.settings;
    for (const link of await this.settings.links(this.id)) this.link(link);
    const history = await store.history(this.id);
    this.saved = history.length;
    this.history.push(...history);
    const only = [...this.channels.keys()][0] ?? "chat";
    for (const entry of history) {
      if (entry.role !== "user") continue;
      for (const m of entry.content.matchAll(/^\[(?:([\w-]+) · )?(m\d+)[,\]]/gm)) this.messageIds.set(m[2], m[1] ?? only);
    }
    // A step cut off while its tools ran: those calls get a result that says so.
    const answered = new Set(history.flatMap((e) => (e.role === "tool" ? [e.toolCallId] : [])));
    const lastCalls = [...history].reverse().find((e) => e.role === "assistant" && e.toolCalls?.length);
    if (lastCalls?.role === "assistant") {
      for (const c of lastCalls.toolCalls ?? []) if (!answered.has(c.id)) this.history.push({ role: "tool", toolCallId: c.id, content: INTERRUPTED });
    }
    for (const task of await store.tasks(this.id)) {
      this.note(`[Parley] ${task.tool} (${task.taskId}) was still running in the background when the agent restarted. It may or may not have finished; check before telling them it is done.`);
      this.persist(() => store.removeTask(this.id, task.taskId));
    }
    for (const row of await store.openInbox(this.id)) this.enqueue(row);
    const row = await store.conversation(this.id);
    this.resumeTurn = row?.turnOpen === true;
    if ((this.resumeTurn || this.hasWork()) && !this.running) this.schedule(0);
  }

  private hasWork(): boolean {
    return this.pending.length > 0 || this.notes.some((n) => !n.wait) || this.direct.length > 0;
  }

  private note(text: string, wait = false): void {
    const item: Note = { text, wait };
    this.notes.push(item);
    this.persist(async () => {
      item.inbox = await this.settings.store.addInbox(this.id, "note", { text, wait });
      this.knownInbox.add(item.inbox);
    });
    if (!wait && !this.running) this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.loaded;
      for (;;) {
        if (this.closed) break;
        if (this.pending.length || this.notes.some((n) => !n.wait) || this.resumeTurn) {
          this.resumeTurn = false;
          await this.turn();
          continue;
        }
        const next = this.direct.shift();
        if (!next) break;
        await this.sendDirect(next);
      }
    } catch (error) {
      this.settings.emit(this.id, "model.error", { error: String(error) });
      await this.send(this.currentChannel(), { type: "message", text: "Sorry, something went wrong on my side. Could you send that again?" });
    } finally {
      this.running = false;
      for (const channel of [...this.typingOn]) await this.typing(false, channel);
      for (const link of this.channels.values()) if (link.info.status) await this.send(link.name, { type: "status", text: null });
      this.checkIdle();
    }
  }

  private checkIdle(): void {
    if (this.busy) return;
    this.idleSince = Date.now();
    const waiting = this.settled;
    this.settled = [];
    for (const resolve of waiting) resolve();
  }

  private views(): ChannelView[] {
    return [...this.channels.values()].map((c) => ({ name: c.name, info: c.info, params: c.params, instructions: c.instructions }));
  }

  /** The channel of the person's latest message. */
  private currentChannel(): string {
    return this.recentChannels.at(-1) ?? [...this.channels.keys()][0] ?? "chat";
  }

  /** Move waiting messages and notes into the history; the person's messages are now read. */
  private absorb(): boolean {
    if (!this.pending.length && !this.notes.length) return false;
    const items: Array<{ inbox?: number }> = [];
    for (const note of this.notes.splice(0)) {
      this.history.push({ role: "user", content: note.text });
      if (note.text.startsWith("[Background result:")) this.resultUnsent = "background";
      if (note.owed) this.owed.push(note.owed);
      items.push(note);
    }
    const messages = this.pending.splice(0);
    if (messages.length) {
      const tag = this.settings.tagChannels || this.channels.size > 1;
      this.history.push({ role: "user", content: messages.map((m) => `[${tag ? `${m.channel} · ` : ""}${m.id}${m.text}`).join("\n") });
      items.push(...messages);
      for (const channel of new Set(messages.map((m) => m.channel))) {
        if (this.channels.get(channel)?.info.readReceipts) void this.send(channel, { type: "read", messageIds: messages.filter((m) => m.channel === channel).map((m) => m.id) });
      }
    }
    this.flush(items);
    return true;
  }

  /** Stores history entries not yet stored, and marks the inbox rows they came from handled. */
  private flush(items: Array<{ inbox?: number }> = []): void {
    const seq = this.saved;
    const entries = this.history.slice(seq);
    this.saved = this.history.length;
    if (!entries.length && !items.length) return;
    this.persist(() => this.settings.store.appendHistory(this.id, seq, entries, items.flatMap((i) => (i.inbox === undefined ? [] : [i.inbox]))));
  }

  private async turn(): Promise<void> {
    const started = Date.now();
    const { store } = this.settings;
    this.settings.emit(this.id, "turn.start", {});
    this.persist(() => store.updateConversation(this.id, { turnOpen: true }));
    this.absorb();
    // A turn the person started (as against a background result, a scheduled message or a nudge).
    const theirs = this.unanswered.size > 0;
    if (!this.channels.size) {
      // No way to reach them right now (a channel with no adapter, after a restart).
      for (const o of this.owed.splice(0)) this.settle(o, "failed", "no way to reach them on that channel right now");
      this.persist(() => store.updateConversation(this.id, { turnOpen: false }));
      return;
    }
    const context = this.settings.context ? await this.settings.context(this.id) : "";
    const rules = rulesSection(await store.noContact(this.id, this.settings.now()), this.timeZone ?? this.settings.timeZone ?? "UTC");
    // A message that came while those loaded had no step to restart: it joins the first one.
    this.absorb();
    let restarts = 0;
    let reminded = false;
    let followedUp = false;
    /** A tool other than talking has been called in this turn. */
    let acted = false;
    this.sentThisTurn.clear();
    for (let step = 0; step < this.settings.maxSteps; step++) {
      if (this.closed) return;
      // The channels can grow mid-turn (they wrote on another one), so each step offers what is there now.
      const views = this.views();
      const several = views.length > 1;
      this.sendTools = new Map(views.map((v) => [sendToolName(v.name), v.name]));
      const system = [this.settings.instructions, talkInstructions(views, this.settings.talk), rules, context].filter(Boolean).join("\n\n");
      const specs = [...this.settings.specs, ...this.builtinSpecs, ...talkSpecs(views, this.settings.talk)];
      const abort = new AbortController();
      if (restarts < this.settings.maxRestarts) this.stepAbort = abort;
      const callStarted = Date.now();
      let response;
      try {
        response = await this.settings.model.complete({ system, messages: [...this.history], tools: specs, signal: abort.signal });
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      } finally {
        this.stepAbort = null;
      }
      if (abort.signal.aborted || !response) {
        restarts++;
        step--;
        this.settings.emit(this.id, "model.restarted", { ms: Date.now() - callStarted });
        this.absorb();
        continue;
      }
      this.settings.emit(this.id, "model.call", {
        ms: Date.now() - callStarted,
        toolCalls: response.toolCalls.map((c) => c.name),
        usage: response.usage,
        ...(response.model ? { model: response.model } : {}),
      });
      if (response.text) this.settings.emit(this.id, "text.hidden", { text: response.text });

      const talk = response.toolCalls.filter((c) => this.isTalk(c.name));
      const work = response.toolCalls.filter((c) => !this.isTalk(c.name));
      const first = this.firstResponse;
      this.firstResponse = false;

      const reached = new Set(talk.flatMap((c) => this.targets(c)));
      const waiting = [...this.unanswered].filter((c) => !reached.has(c));
      if (first && waiting.length && work.length) {
        // Acknowledgement first: these calls do not run until the person has heard from the agent.
        this.settings.emit(this.id, "ack.required", { held: work.map((c) => c.name), channels: waiting });
        this.history.push({
          role: "user",
          content: several
            ? `[Parley] They have not heard from you on ${waiting.join(" or ")} yet. In one response, acknowledge them there (react to their message or send a short line) and make your tool calls again.`
            : ACKNOWLEDGE_FIRST,
        });
        this.flush();
        continue;
      }

      if (!response.toolCalls.length) {
        this.history.push({ role: "assistant", content: response.text });
        const owes = [...new Set([...this.unanswered, ...this.owed.filter((o) => o.mode === "message").map((o) => o.channel)])];
        if (owes.length && !reminded) {
          reminded = true;
          this.history.push({
            role: "user",
            content: several
              ? `[Parley] INTERNAL MESSAGE, not from them: ${response.text ? "your text above never reached them" : "they have not heard from you"} on ${owes.join(" or ")}. Reply with ${owes.map((c) => sendToolName(c)).join(" or ")}, without mentioning this note${response.text ? ", that text" : ""} or any delay.`
              : `[Parley] INTERNAL MESSAGE, not from them: ${response.text ? "your text above never reached them" : "they have not heard from you"}. Reply with ${sendToolName(owes[0])}, without mentioning this note${response.text ? ", that text" : ""} or any delay.`,
          });
          this.flush();
          continue;
        }
        // After a returned result, only new plain text is sent back: silence may be the answer, and
        // text that repeats a message already sent has been said.
        const said = !!response.text && !this.sentThisTurn.has(response.text.trim());
        const owedResult = this.resultUnsent === "returned" && said;
        if ((this.resultUnsent === "background" || owedResult) && !this.tasks.size && !reminded) {
          // A result came back and the agent said nothing to them: it may have written the answer as plain text.
          reminded = true;
          this.history.push({ role: "user", content: `[Parley] INTERNAL MESSAGE, not from them: they have not heard from you since the result above, and text outside ${this.sendToolsNow()} never reaches them. If the result is for them, tell them with ${this.sendToolsNow()}, without mentioning this note, any earlier text or any delay.` });
          this.flush();
          continue;
        }
        this.flush();
        if (this.absorb()) continue;
        break;
      }

      this.history.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
      this.flush();
      if (work.length) acted = true;
      const working = this.runTools(work);
      const said: Array<{ content: string; refused: boolean }> = [];
      for (const call of talk) said.push(await this.talk(call));
      const { results: done, finished } = await working;
      // A result the agent has not passed on yet: if it ends the turn without a message, it is reminded once.
      if (finished) this.resultUnsent = "returned";
      const problems = said.some((s) => s.refused);
      const results = new Map<string, string>();
      talk.forEach((call, i) => results.set(call.id, said[i].content));
      work.forEach((call, i) => results.set(call.id, done[i]));
      for (const call of response.toolCalls) {
        this.history.push({ role: "tool", toolCallId: call.id, content: results.get(call.id) ?? "" });
      }
      this.flush();
      // Only messages: the turn is over unless one was refused or something new came in meanwhile, or
      // this replies to their message without having used any tool: it gets one more step, in case it
      // meant to act next (it said "getting your order status" and has not asked for it yet). A tool
      // used, or still running in the background, means it already acted.
      if (!work.length && !problems && !this.absorb()) {
        if (!theirs || followedUp || acted || this.tasks.size) break;
        followedUp = true;
      }
      this.absorb();
    }
    for (const o of this.owed.splice(0)) {
      if (o.mode === "message") this.settle(o, "failed", "the agent sent nothing");
      else this.settle(o, o.mode === "check" ? "quiet" : "silent");
    }
    this.resultUnsent = false;
    this.persist(() => store.updateConversation(this.id, { turnOpen: false }));
    this.settings.emit(this.id, "turn.end", { ms: Date.now() - started });
  }

  private isTalk(name: string): boolean {
    return this.sendTools.has(name) || name === REACT || name === UPDATE;
  }

  /** The channels a talk call reaches (for the acknowledgement rule), before it runs. */
  private targets(call: ToolCall): string[] {
    if (this.sendTools.has(call.name)) return [this.sendTools.get(call.name)!];
    if (call.name === UPDATE) return [...this.channels.values()].filter((c) => c.info.status).map((c) => c.name);
    try {
      const channel = this.messageIds.get(JSON.parse(call.arguments || "{}").message_id);
      return channel ? [channel] : [];
    } catch {
      return [];
    }
  }

  /**
   * Run one of the send tools, react or share_updates. A message that went out says where it was
   * delivered; one that failed on the way is told as a message of its own. `refused` is a call
   * that did nothing because of its input: the agent gets another step to fix it.
   */
  private async talk(call: ToolCall): Promise<{ content: string; refused: boolean }> {
    const refused = (content: string) => ({ content, refused: true });
    const done = (content = "") => ({ content, refused: false });
    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments || "{}");
    } catch {
      return refused("The arguments were not valid JSON.");
    }
    const channel = this.sendTools.get(call.name);
    if (channel) {
      const link = this.channels.get(channel)!;
      const several = this.sendTools.size > 1;
      // Some models fill every optional field, with "" or null when they have nothing: that is not sent.
      const given = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      for (const k of Object.keys(link.params ?? {})) if (given[k] === "" || given[k] === null) delete given[k];
      const parsed = sendInput(link.info, several, link.params).safeParse(raw);
      if (!parsed.success) return refused(`Not sent, fix and send again: ${parsed.error.message}`);
      const input = parsed.data as SendInput;
      const fields = Object.fromEntries(Object.keys(link.params ?? {}).flatMap((k) => ((input as Record<string, unknown>)[k] === undefined ? [] : [[k, (input as Record<string, unknown>)[k]]])));
      const hasFields = Object.keys(fields).length > 0;
      if (several && !input.confirm && !this.recentChannels.includes(channel)) {
        const last = link.lastMessageAt ? ` (last time ${ago(this.settings.now() - link.lastMessageAt)} ago)` : "";
        return refused(`Not sent: they have not written on ${channel} in their last 5 messages${last}. If you are sure, call ${call.name} again with confirm: true.`);
      }
      if (input.reply_to && this.messageIds.get(input.reply_to) !== channel) return refused(`Not sent: there is no message ${input.reply_to} on ${channel} to reply to.`);
      const outbound: Outbound = {
        type: "message",
        text: input.text,
        ...(input.reply_to ? { replyTo: input.reply_to } : {}),
        ...(input.buttons?.length ? { buttons: input.buttons } : {}),
        ...(input.list ? { list: input.list } : {}),
        ...(hasFields ? { fields } : {}),
      };
      const failure = await this.send(channel, outbound);
      if (failure) {
        this.undelivered(input.text, failure);
        return done();
      }
      this.settings.emit(this.id, "message.out", { text: input.text, channel, buttons: input.buttons, list: input.list, replyTo: input.reply_to, ...(hasFields ? { fields } : {}) });
      this.sent();
      this.sentThisTurn.add(input.text.trim());
      await this.acknowledged(channel);
      return done(JSON.stringify({ delivered: true, channel }));
    }
    if (call.name === REACT) {
      const input = reactInput.safeParse(raw);
      if (!input.success) return refused(`Invalid input: ${input.error.message}`);
      const on = this.messageIds.get(input.data.message_id);
      if (!on) return refused(`There is no message ${input.data.message_id}.`);
      if (!this.channels.get(on)?.info.reactions) return refused(`Reactions do not work on ${on}; send a short line instead.`);
      const failure = await this.send(on, { type: "reaction", emoji: input.data.emoji, messageId: input.data.message_id });
      if (failure) return refused(`The reaction did not go through: ${failure}`);
      this.settings.emit(this.id, "reaction", { emoji: input.data.emoji, messageId: input.data.message_id, channel: on });
      await this.acknowledged(on);
      return done();
    }
    if (call.name === UPDATE) {
      const input = updateInput.safeParse(raw);
      if (!input.success) return refused(`Invalid input: ${input.error.message}`);
      for (const link of this.channels.values()) {
        if (!link.info.status) continue;
        if (await this.send(link.name, { type: "status", text: input.data.text })) continue;
        this.settings.emit(this.id, "status", { text: input.data.text, channel: link.name });
        await this.acknowledged(link.name);
      }
      return done();
    }
    return refused(`There is no tool named ${call.name}.`);
  }

  /** How a scheduled run or a nudge ended, stored in order with everything else. */
  private settle(target: { run?: string; nudge?: string }, status: string, reason?: string): void {
    this.persist(() => this.settings.settle({ run: target.run, nudge: target.nudge }, status, reason));
  }

  /** A message reached the person: whatever this turn owed them is sent. */
  private sent(): void {
    this.resultUnsent = false;
    for (const o of this.owed.splice(0)) this.settle(o, "sent");
  }

  private async acknowledged(channel: string): Promise<void> {
    this.unanswered.delete(channel);
    await this.typing(false, channel);
  }

  private async typing(on: boolean, channel: string): Promise<void> {
    if (on === this.typingOn.has(channel)) return;
    if (on) this.typingOn.add(channel);
    else this.typingOn.delete(channel);
    await this.send(channel, { type: "typing", on });
  }

  /** Hand one outbound to a channel; returns why it failed, or null. */
  private async send(channel: string, outbound: Outbound): Promise<string | null> {
    if (this.closed) return "this person was forgotten";
    const link = this.channels.get(channel);
    if (!link) return `no way to reach them on ${channel} right now`;
    try {
      await link.deliver(outbound);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** A fixed-text scheduled message or a text or template nudge, sent with no model turn. */
  private async sendDirect(d: Direct): Promise<void> {
    const settle = (status: string, reason?: string) => {
      this.settle(d, status, reason);
      this.flush([d]);
    };
    const link = this.channels.get(d.channel);
    if (!link) return settle("failed", `no way to reach them on ${d.channel} right now`);
    if (!d.template && windowClosed(link, this.settings.now())) return settle("refused", "outside_window");
    if (d.nudge) {
      const rules = await this.settings.store.noContact(this.id, this.settings.now());
      const covered = rules.length ? await coveredBy(this.settings.model, rules, d.text ?? `the template "${d.template?.name}"`) : null;
      if (covered) return settle("dropped", `no-contact rule ${covered.id}: ${covered.rule}`);
    }
    const outbound: Outbound = d.template ? { type: "template", ...d.template } : { type: "message", text: d.text ?? "" };
    const failure = await this.send(d.channel, outbound);
    if (failure) return settle("failed", failure);
    if (d.template) {
      this.history.push({ role: "user", content: `[Parley] The business sent them its template "${d.template.name}" on ${d.channel}.` });
    } else {
      const callId = `direct_${d.inbox ?? Date.now()}`;
      this.history.push({ role: "user", content: `[Parley] The business sent them this message through you on ${d.channel}, as written:` });
      this.history.push({ role: "assistant", content: null, toolCalls: [{ id: callId, name: sendToolName(d.channel), arguments: JSON.stringify({ text: d.text }) }] });
      this.history.push({ role: "tool", toolCallId: callId, content: JSON.stringify({ delivered: true, channel: d.channel }) });
    }
    this.settings.emit(this.id, "message.out", { text: d.text ?? d.template?.name, channel: d.channel, direct: true });
    settle("sent");
  }

  /** The send tools the agent has right now, for Parley's notes: "send_sms", or "send_sms or send_app". */
  private sendToolsNow(): string {
    return [...this.channels.keys()].map((c) => sendToolName(c)).join(" or ");
  }

  /**
   * Run a response's tool calls together and wait for all of them, except: a message from the
   * person ends the wait, a finished result waits at most partialAfterMs for the others, and a tool
   * past its limit stops holding the reply. Whatever is still running then moves to the background.
   */
  private async runTools(calls: ToolCall[]): Promise<{ results: string[]; finished: number }> {
    const results: Array<string | undefined> = [];
    let finished = 0;
    const live: Array<{ i: number; r: Running }> = [];
    calls.forEach((call, i) => {
      const started = this.start(call);
      if (typeof started === "string") results[i] = started;
      else live.push({ i, r: started });
    });
    let firstDoneAt: number | null = null;
    for (;;) {
      for (const { i, r } of live) {
        if (!r.result || results[i] !== undefined) continue;
        results[i] = r.result.text;
        finished++;
        firstDoneAt ??= Date.now();
        this.settings.emit(this.id, "tool.end", { callId: r.call.id, tool: r.call.name, ms: Date.now() - r.startedAt, ok: r.result.ok, inline: true, output: clipOutput(r.result.text) });
      }
      const open = live.filter(({ i }) => results[i] === undefined);
      if (!open.length) break;
      if (this.closed) {
        for (const { i } of open) results[i] = "";
        break;
      }
      const now = Date.now();
      const all: Detach | null = this.pending.length ? "message" : firstDoneAt !== null && now - firstDoneAt >= this.settings.partialAfterMs ? "partial" : null;
      if (all) {
        for (const { i, r } of open) results[i] = this.detach(r, all);
        break;
      }
      const late = open.filter(({ r }) => now - r.startedAt >= r.limitMs);
      for (const { i, r } of late) results[i] = this.detach(r, "limit");
      if (late.length) continue;
      const wakeAt = Math.min(...open.map(({ r }) => r.startedAt + r.limitMs), firstDoneAt === null ? Infinity : firstDoneAt + this.settings.partialAfterMs);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(wake, Math.max(0, wakeAt - Date.now()));
        function wake() {
          clearTimeout(timer);
          resolve();
        }
        this.wakeTools = wake;
        for (const { r } of open) void r.outcome.then(wake);
      });
      this.wakeTools = null;
    }
    return { results: results as string[], finished };
  }

  /** Start one tool call; the model's input is checked first (a refusal is the call's result). */
  private start(call: ToolCall): Running | string {
    const tool = this.builtins.get(call.name) ?? this.settings.tools.get(call.name);
    if (!tool) return `There is no tool named ${call.name}.`;
    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments || "{}");
    } catch {
      return "The arguments were not valid JSON.";
    }
    const parsed = tool.input.safeParse(raw);
    if (!parsed.success) return `Invalid input: ${parsed.error.message}`;

    // The same call while it is still running in the background is not run again: its result is coming.
    const input = stableJson(parsed.data);
    const running = [...this.tasks.values()].find((t) => t.tool === call.name && t.input === input);
    if (running) {
      this.settings.emit(this.id, "tool.repeated", { callId: call.id, tool: call.name, task: running.id });
      return `[Parley] Not run: ${call.name} with this input is already running in the background (${running.id}). Its result will come to you here; don't call it again.`;
    }

    this.settings.emit(this.id, "tool.start", { callId: call.id, tool: call.name, input: parsed.data });
    const context = { conversationId: this.id, person: this.personKey, channel: this.currentChannel() };
    const r: Running = {
      call,
      input,
      startedAt: Date.now(),
      limitMs: tool.deadlineMs ?? this.settings.deadlineMs,
      outcome: Promise.resolve()
        .then(() => tool.run(parsed.data, context))
        .then(
          (output) => ({ ok: true, text: render(output) }),
          (error) => ({ ok: false, text: `Failed: ${error instanceof Error ? error.message : String(error)}` }),
        ),
    };
    void r.outcome.then((result) => (r.result = result));
    return r;
  }

  /** The reply stops waiting for this tool: it carries on in the background and its result comes back as a note. */
  private detach(r: Running, why: Detach): string {
    const { call, startedAt } = r;
    const task: Task = { id: `task_${++this.taskCount}`, tool: call.name, input: r.input, startedAt };
    this.tasks.set(task.id, task);
    this.persist(() => this.settings.store.addTask(this.id, task.id, call.id, call.name, startedAt));
    this.settings.emit(this.id, "tool.detached", { callId: call.id, tool: call.name, task: task.id, ms: Date.now() - startedAt, why });
    void r.outcome.then((result) => {
      this.tasks.delete(task.id);
      this.persist(() => this.settings.store.removeTask(this.id, task.id));
      this.settings.emit(this.id, "task.done", { callId: call.id, tool: call.name, task: task.id, ms: Date.now() - startedAt, ok: result.ok, output: clipOutput(result.text) });
      this.note(`[Background result: ${call.name} (${task.id})] ${result.text}\n[Parley] They have not seen this result: tell them with ${this.sendToolsNow()}.`);
      this.checkIdle();
    });
    return (
      `[Parley] ${call.name} started and is still running in the background (${task.id}). Do not call ${call.name} again: ` +
      `its result will come to you here when it finishes. Until then don't tell them it is done; when it arrives, tell them with ${this.sendToolsNow()}.` +
      (why === "partial" ? " The other results are in: tell them this now only if it answers what they asked; the rest is coming." : "")
    );
  }
}

/** The business may not message first on this channel now (WhatsApp, past 24 hours). */
export function windowClosed(link: { info: ChannelInfo; lastMessageAt: number | null }, now: number): boolean {
  const hours = link.info.replyWindowHours;
  if (!hours) return false;
  return link.lastMessageAt === null || now - link.lastMessageAt > hours * 3_600_000;
}

/** One line of a conversation as the person saw it, read back from the history (the playground shows these). */
export type TranscriptEntry =
  | { kind: "in"; channel: string; id: string; text: string; at: number; choice?: boolean }
  | {
      kind: "out";
      channel: string;
      text: string;
      at: number;
      replyTo?: string;
      buttons?: string[];
      list?: { button: string; rows: Array<{ id: string; title: string; description?: string }> };
      /** The channel's own params the agent filled in. */
      fields?: Record<string, unknown>;
    }
  | { kind: "reaction"; channel: string; messageId: string; emoji: string; at: number }
  | { kind: "tool"; callId: string; tool: string; input: unknown; output: string; ok: boolean; at: number };

const SEND_KEYS = new Set(["text", "reply_to", "buttons", "list", "confirm"]);

/**
 * The history as the person saw it: their messages (with the ids describe() wrote), what the agent
 * delivered with its send tools and reactions, and its other tool calls with their results.
 * Parley's notes and the agent's plain text never reached the person and are left out. `only` is
 * the channel of untagged messages (an agent with one channel does not tag them).
 */
export function transcriptOf(history: Array<{ entry: ChatMessage; at: number }>, only: string): TranscriptEntry[] {
  const lines: TranscriptEntry[] = [];
  const results = new Map<string, { content: string; at: number }>();
  for (const { entry, at } of history) if (entry.role === "tool") results.set(entry.toolCallId, { content: entry.content, at });
  const channelOf = new Map<string, string>();
  for (const { entry, at } of history) {
    if (entry.role === "user") {
      const starts = [...entry.content.matchAll(/^\[(?:([\w-]+) · )?(m\d+)(?=[,\]])/gm)];
      starts.forEach((m, i) => {
        const channel = m[1] ?? only;
        const rest = entry.content.slice(m.index! + m[0].length, i + 1 < starts.length ? starts[i + 1].index! - 1 : undefined);
        const tapped = rest.indexOf(", tapped] ");
        const text = rest.startsWith("] ") ? rest.slice(2) : tapped >= 0 ? rest.slice(tapped + 10) : rest.slice(rest.indexOf('"] ') + 3);
        channelOf.set(m[2], channel);
        lines.push({ kind: "in", channel, id: m[2], text, at, ...(tapped >= 0 ? { choice: true } : {}) });
      });
      continue;
    }
    if (entry.role !== "assistant") continue;
    for (const call of entry.toolCalls ?? []) {
      const result = results.get(call.id);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || "{}");
      } catch {}
      if (call.name.startsWith("send_")) {
        let delivered: { delivered?: boolean; channel?: string } = {};
        try {
          delivered = JSON.parse(result?.content ?? "");
        } catch {}
        if (!delivered.delivered || !delivered.channel) continue;
        const fields = Object.fromEntries(Object.entries(args).filter(([k, v]) => !SEND_KEYS.has(k) && v !== undefined && v !== null && v !== ""));
        lines.push({
          kind: "out",
          channel: delivered.channel,
          text: String(args.text ?? ""),
          at: result!.at,
          ...(typeof args.reply_to === "string" ? { replyTo: args.reply_to } : {}),
          ...(Array.isArray(args.buttons) && args.buttons.length ? { buttons: args.buttons as string[] } : {}),
          ...(args.list ? { list: args.list as never } : {}),
          ...(Object.keys(fields).length ? { fields } : {}),
        });
      } else if (call.name === REACT) {
        const channel = channelOf.get(String(args.message_id));
        if (result?.content === "" && channel) lines.push({ kind: "reaction", channel, messageId: String(args.message_id), emoji: String(args.emoji), at: result.at });
      } else if (call.name !== UPDATE && result) {
        lines.push({ kind: "tool", callId: call.id, tool: call.name, input: args, output: result.content, ok: !result.content.startsWith("Failed:"), at: result.at });
      }
    }
  }
  return lines;
}

/** How a message from the person reads to the agent, after its id: "[m5] text", with any quote or tap. */
function describe(incoming: Incoming): string {
  const parts: string[] = [];
  if (incoming.replyTo) parts.push(`, replying to ${incoming.replyTo.fromAgent ? "your" : "their own"} message "${clip(incoming.replyTo.text)}"`);
  if (incoming.choice) return `${parts.join("")}, tapped] ${incoming.choice.title}`;
  return `${parts.join("")}] ${incoming.text}`;
}

/** A tool's output as events carry it: whole up to 4,000 characters (for debugging and observability). */
function clipOutput(text: string): string {
  return text.length > 4_000 ? `${text.slice(0, 4_000)}…` : text;
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/** JSON with object keys sorted, so the same input always reads the same. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
}
