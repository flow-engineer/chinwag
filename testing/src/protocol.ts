// What travels through the tunnel between an agent on a developer's machine and the test cloud.
// Every connection is opened by the agent's side (plain HTTP), so it works behind any router.
//
//   POST /api/sessions                 OpenSession → Opened     start a session, learn which files to upload
//   POST /api/files                    { files: UploadFile[] }   upload the files the cloud lacks
//   GET  /api/sessions/:id/stream      server-sent Commands     the person's side, cloud → agent
//        Last-Event-ID: N                                    a resume: the commands after N
//   POST /api/sessions/:id/outbound    { conversationId, outbound } → { ok } | 409 { error }
//   POST /api/sessions/:id/tool-calls  ToolCallRequest → ToolCallResult   held open while the tool is simulated
//   POST /api/sessions/:id/events      { seq, events: ChinwagEvent[] }
//
// Every POST after the open sends Idempotency-Key. An older cloud ignores it. When Opened
// says idempotency, a repeat of a key is the stored answer and the client may send it again.
//   POST /api/sessions/:id/receipts    Receipt → { ok }
//   POST /api/sessions/:id/drained     {} → { ok }   flush before the terminal command
//
// When Opened says resume, every command on the stream carries `id: N` (1, 2, 3, ... per session).
// A stream that drops, or sits silent past the idle watch, is opened again with Last-Event-ID set
// to the last id the client handled (0 for none); the cloud sends the commands after it, and holds
// them for 2 minutes while no stream is attached. The client skips an id it has handled.
//
// When Opened says reopen, a tunnel call or the stream may answer 410 { error: "session_gone" }: the
// cloud lost the session (its tunnel restarted). The client opens one new session with `only`, the
// runs that have no result yet, and merges the two reports. Never more than once.
//
// The open goes to the cloud's front door; every later call goes to Opened.tunnel (else the same
// address) and carries `authorization: Bearer <token>` from Opened.

import type { Attachment, ChannelInfo, ChannelSummary, Incoming, ToolSpec } from "../../src/index.ts";

/** One graded expect item of a run. */
export interface Check {
  kind: "outcome" | "judge";
  text: string;
  pass: boolean;
  reason: string;
}

/** Model tokens and their cost, added up over a run. */
export interface Usage {
  input: number;
  output: number;
  costUsd: number;
}

export interface OpenSession {
  /** name: a stable key (the package name) that keeps the agent's history together; title: for people. */
  agent: { name: string; title?: string; tools: ToolSpec[]; channels?: ChannelSummary[] };
  /** Every file in the local suite; only these tests run. */
  files: Array<{ path: string; hash: string }>;
  /** How many times each scenario runs. */
  runs: number;
  /** Acknowledge each message independently of the serial event uploads. */
  deliveryReceipts?: boolean;
  /** The client will retry a call when this cloud stores the result under Idempotency-Key. */
  retries?: boolean;
  /** The client opens a lost stream again with Last-Event-ID when this cloud resumes. */
  resume?: boolean;
  /** The client opens one new session for the unfinished runs when this cloud says session_gone. */
  reopen?: boolean;
  /** Play only these runs, numbered as given: a re-open after session_gone. Sent only to a cloud whose Opened said reopen,
   * and only when some run finished: the cloud checks it against the suite's files it already stores. */
  only?: RunKey[];
}

/** One run of a suite: a scenario's id, one of its channels, and which of the `runs` times (from 1). */
export interface RunKey {
  scenario: string;
  channel: string;
  run: number;
}

export interface Receipt {
  conversationId: string;
  messageId: string;
  status: "taken" | "intercepted";
}

export interface Opened {
  sessionId: string;
  token: string;
  /** Hashes the cloud does not have yet; upload these. */
  missing: string[];
  /** Where to watch this session's runs. */
  dashboard: string;
  /** The tunnel's absolute URL, where every later call goes (a hosted cloud's front door serves
   * only the open). Absent or empty: the open's own address (a local cloud). */
  tunnel?: string;
  /** This cloud stores each Idempotency-Key with its result. Absent on an older cloud. */
  idempotency?: boolean;
  /** This cloud numbers stream commands with an SSE id, sends the ones after Last-Event-ID to a
   * stream opened again, and holds them 2 minutes while none is attached. Absent on an older cloud. */
  resume?: boolean;
  /** This cloud answers session_gone for a session it lost, and plays `only` on an open. Absent on an older cloud. */
  reopen?: boolean;
}

export interface UploadFile {
  hash: string;
  path: string;
  content: string;
}

export type Command =
  | { type: "message"; conversationId: string; messageId: string; incoming: WireIncoming; channel: ChannelInfo; channelName?: string }
  | { type: "reaction"; conversationId: string; emoji: string; toText: string }
  | { type: "drain" }
  | { type: "run"; run: RunSummary }
  | { type: "finished"; summary: SessionSummary }
  /** The session stopped before it finished; the CLI exits with this error. */
  | { type: "failed"; error: string };

/**
 * A person's message as it travels: a scenario's file goes by its path in the tests folder, and the
 * agent's side reads it there, so the file never leaves the developer's machine.
 */
export type WireIncoming = Omit<Incoming, "attachments"> & { attachments?: Array<{ kind: Attachment["kind"]; file: string }> };

export interface ToolCallRequest {
  conversationId: string;
  tool: string;
  input: unknown;
}

export type ToolCallResult = { ok: true; output: unknown } | { ok: false; error: string };

export interface RunSummary {
  runId: string;
  scenario: string;
  run: number;
  channel: string;
  /** Every check passed. */
  passed: boolean;
  checks: Check[];
  /** Why the person stopped: goal met, gave up, max turns, or the agent went quiet. */
  ended: string;
  turns: number;
  messagesIn: number;
  messagesOut: number;
  toolCalls: number;
  /** Slowest acknowledgement of a person's message, in ms (null if one was never acknowledged). */
  slowestAckMs: number | null;
  /** The agent's model calls in this run, from its own events, and the models that answered them. */
  agentUsage: Usage;
  agentModels: string[];
  /** The test's own model calls in this run: the person, the tool simulator and the judge. */
  testUsage: Usage;
  watch: string;
  /** The first try never reached the agent, so this run is the second try. */
  retried?: boolean;
}

export interface SessionSummary {
  sessionId: string;
  suiteHash: string;
  /** The model that played the person and the tools and judged. */
  testModel: string;
  runs: RunSummary[];
  dashboard: string;
}
