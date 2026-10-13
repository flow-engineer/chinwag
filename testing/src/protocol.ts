// What travels through the tunnel between an agent on a developer's machine and the test cloud.
// Every connection is opened by the agent's side (plain HTTP), so it works behind any router.
//
//   POST /api/sessions                 OpenSession → Opened     start a session, learn which files to upload
//   POST /api/files                    { files: UploadFile[] }   upload the files the cloud lacks
//   GET  /api/sessions/:id/stream      server-sent Commands     the person's side, cloud → agent
//   POST /api/sessions/:id/outbound    { conversationId, outbound } → { ok } | 409 { error }
//   POST /api/sessions/:id/tool-calls  ToolCallRequest → ToolCallResult   held open while the tool is simulated
//   POST /api/sessions/:id/events      { events: ParleyEvent[] }
//
// Calls after the first carry `authorization: Bearer <token>` from Opened.

import type { ChannelInfo, ChannelSummary, Incoming, ToolSpec } from "../../src/index.ts";

/** One graded item of a run: an outcome against what the tools did, or a judged line against the transcript. */
export interface Check {
  kind: "outcome" | "judge";
  text: string;
  pass: boolean;
  reason: string;
}

/** Tokens and cost of a run's model calls. */
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
}

export interface Opened {
  sessionId: string;
  token: string;
  /** Hashes the cloud does not have yet; upload these. */
  missing: string[];
  /** Where to watch this session's runs. */
  dashboard: string;
}

export interface UploadFile {
  hash: string;
  path: string;
  content: string;
}

export type Command =
  | { type: "message"; conversationId: string; messageId: string; incoming: Incoming; channel: ChannelInfo; channelName?: string }
  | { type: "reaction"; conversationId: string; emoji: string; toText: string }
  | { type: "finished"; summary: SessionSummary }
  /** The session stopped before it finished; the CLI exits with this error. */
  | { type: "failed"; error: string };

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
}

export interface SessionSummary {
  sessionId: string;
  suiteHash: string;
  /** The model that played the person and the tools and judged. */
  testModel: string;
  runs: RunSummary[];
  dashboard: string;
}
