// The developer's side of the tunnel: connects a local agent to the test cloud. The agent keeps its
// own model and key; its tools are replaced by calls the cloud simulates, its replies go to the
// cloud's platform simulators, and the person's messages arrive over one stream.

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { basename, relative, resolve } from "node:path";
import { toSpec, type Agent, type Incoming, type EventSink, type Outbound, type ChinwagEvent, type Tool } from "../../src/index.ts";
import type { Command, Opened, WireIncoming, OpenSession, Receipt, RunSummary, SessionSummary, ToolCallRequest, ToolCallResult } from "./protocol.ts";
import { mimeOf, parseToolFile, suiteHash, type SuiteFile } from "./suite.ts";

export interface ConnectOptions {
  /** The cloud's address, such as http://127.0.0.1:8900. */
  cloud: string;
  /** A stable key for the agent (its package name), which keeps its history together. */
  name: string;
  /** The agent's name for people, shown in the dashboard. */
  title?: string;
  /** The agent's real tools: only their names, descriptions and inputs are used. */
  tools: Tool[];
  /** Builds the agent with the tools and events it is given: a Chinwag Agent, or anything that answers like one (http-agent.ts). */
  build: (options: { tools: Tool[]; events: EventSink[] }) => AgentUnderTest;
  files: SuiteFile[];
  /** The tests folder: files a scenario attaches are read from here, and never leave this machine. */
  testsDir?: string;
  runs?: number;
  log?: (line: string) => void;
  /** Headers for the open only (cloudHeaders: the CI key and the attestation); never sent to the tunnel. */
  openHeaders?: Record<string, string>;
  /** Called as each run finishes, before the session's summary. An older cloud sends none. */
  onRun?: (run: RunSummary) => void;
  /** Called once the session has a dashboard link. */
  onDashboard?: (url: string) => void;
  /** How long one POST waits before the size allowance. Default 30s, plus 1s per 100KB of body. A tool call waits {@link CLOUD_MODEL_BUDGET_MS} plus the simulator's latency, unless this is set. */
  postTimeoutMs?: number;
  /** How long the stream may sit with no bytes, including the cloud's 15s ping. Default 45s. */
  streamIdleMs?: number;
  /** How long one call keeps trying after its first failure. Default 30s. */
  retryBudgetMs?: number;
  /** How long a lost stream keeps trying to resume, on a cloud that resumes (Opened.resume). Default 2 minutes, as long as the cloud holds its commands. */
  resumeWindowMs?: number;
  /** How often a resumable stream is replaced, before the tunnel's one-hour request cap. Default 50 minutes. */
  streamRefreshMs?: number;
}

/** The tunnel, the stream, or the connection failed after the session opened. `runs` are the ones already received. The CLI prints them and exits 2. */
export class SessionStopped extends Error {
  readonly runs: RunSummary[];
  readonly dashboard: string;
  constructor(reason: string, runs: RunSummary[], dashboard: string) {
    super(reason);
    this.name = "SessionStopped";
    this.runs = runs;
    this.dashboard = dashboard;
  }
}

/** A POST that sat until its own deadline. It fails that one call. Only a cloud that stores keys sends it again. The session abort is not one of these. */
export class TimeoutError extends Error {
  constructor() {
    super("timed out");
    this.name = "TimeoutError";
  }
}

/** The stream stopped carrying bytes: the idle watch fired, or the cloud closed it before finished. */
export class StreamLost extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StreamLost";
  }
}

const POST_TIMEOUT_MS = 30_000;
const STREAM_IDLE_MS = 45_000;
const RESUME_WINDOW_MS = 120_000;
const STREAM_REFRESH_MS = 50 * 60_000;
/** How long one call keeps trying after its first failure. The first try's own wait does not count, so a timed-out try is still sent again. */
export const RETRY_BUDGET_MS = 30_000;
/** The cloud abandons one model attempt at 90s and tries a timeout once more, then this POST has its 30s. */
export const CLOUD_MODEL_BUDGET_MS = 90_000 * 2 + POST_TIMEOUT_MS;

/** How long a tool call may take: the longest latency its suite file declares, plus {@link CLOUD_MODEL_BUDGET_MS} (210s).
 * A tool with no file gets the simulator's own cap (60s) plus that 210s.
 *
 * The cloud asks its model before the declared latency, and the model's own time counts toward it.
 * 210s is two 90s attempts plus the 30s POST budget, so a stuck model can finish before this POST gives up.
 * When it runs out, the agent sees an error while the cloud may still record the call in the world log once the model returns. */
export function toolTimeoutMs(files: SuiteFile[], tool: string, budgetMs = CLOUD_MODEL_BUDGET_MS): number {
  let declared = 0;
  let known = false;
  for (const file of files) {
    if (!file.path.startsWith("tools/") || !file.path.endsWith(".yaml")) continue;
    try {
      const parsed = parseToolFile(file);
      if (parsed.tool !== tool) continue;
      known = true;
      for (const response of parsed.responses) declared = Math.max(declared, response.latency_ms);
    } catch { /* the cloud refuses the file; the call still waits the simulator's cap */ }
  }
  return budgetMs + (known ? declared : 60_000);
}

/** The base budget plus 1s per 100KB, so a 5MB event batch or file upload is not cut off at 30s. */
export function postBudgetMs(baseMs: number, bytes: number): number {
  return baseMs + Math.floor(Math.max(0, bytes) / 100_000) * 1_000;
}

/** What the cloud plays: a Chinwag Agent's channels, messages in and reactions. */
export type AgentUnderTest = Pick<Agent, "channels" | "receive" | "reacted">;

export interface CloudAccess {
  /** The cloud's front door, as given to --cloud. */
  cloud: string;
  /** The agent's CI key (CHINWAG_CLOUD_KEY). */
  ciKey?: string;
  /** Whoever runs the tests attests that the test files hold no real people's data. */
  synthetic: boolean;
  agentVersion?: string;
  ref?: string;
  environment?: string;
}

/** The open's headers. A cloud off this machine needs the CI key and the synthetic attestation;
 * a local one needs neither, and gets them when they are given. */
export function cloudHeaders(access: CloudAccess): Record<string, string> {
  const local = isLoopback(access.cloud);
  if (!local && !access.ciKey) throw new Error("A hosted cloud needs the agent's CI key: set CHINWAG_CLOUD_KEY.");
  if ((!local || access.ciKey) && !access.synthetic) {
    throw new Error("A hosted cloud runs synthetic tests only: pass --synthetic to attest that your test files hold no real customer or member data.");
  }
  if (access.environment && access.environment !== "staging" && access.environment !== "production") {
    throw new Error("--environment must be staging or production.");
  }
  const headers: Record<string, string> = {};
  if (access.ciKey) headers.authorization = `Bearer ${access.ciKey}`;
  if (access.synthetic) headers["x-chinwag-synthetic"] = "true";
  const optional: Array<[string, string, string | undefined]> = [
    ["x-chinwag-agent-version", "--agent-version", access.agentVersion],
    ["x-chinwag-ref", "--ref", access.ref],
    ["x-chinwag-environment", "--environment", access.environment],
  ];
  for (const [header, flag, value] of optional) {
    if (!value) continue;
    if (!/^[\x20-\x7e]{1,100}$/.test(value)) throw new Error(`${flag} must be 1 to 100 printable ASCII characters.`);
    headers[header] = value;
  }
  return headers;
}

/** Where the session is played: Opened.tunnel when the cloud answers one, else the open's own address. */
export function tunnelBase(cloud: string, opened: Pick<Opened, "tunnel">): string {
  if (!opened.tunnel) return cloud.replace(/\/$/, "");
  let url: URL | null = null;
  try {
    url = new URL(opened.tunnel);
  } catch {}
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new Error(`the cloud answered a tunnel that is not an http(s) URL: ${opened.tunnel}`);
  }
  return opened.tunnel.replace(/\/$/, "");
}

function isLoopback(cloud: string): boolean {
  const host = new URL(cloud).hostname;
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

export async function runInCloud(options: ConnectOptions): Promise<SessionSummary> {
  const log = options.log ?? ((line: string) => console.log(line));
  const postTimeoutMs = options.postTimeoutMs ?? POST_TIMEOUT_MS;
  const streamIdleMs = options.streamIdleMs ?? STREAM_IDLE_MS;
  const retryBudgetMs = options.retryBudgetMs ?? RETRY_BUDGET_MS;
  const resumeWindowMs = options.resumeWindowMs ?? RESUME_WINDOW_MS;
  const streamRefreshMs = options.streamRefreshMs ?? STREAM_REFRESH_MS;
  let idempotent = false;
  const base = options.cloud.replace(/\/$/, "");

  // The session's address is known once it opens; tools and events only use it after that.
  let session = "";
  let auth: Record<string, string> = {};
  const controller = new AbortController();
  let stream: IncomingMessage | undefined;
  let stopped = false;
  let failure: Error | undefined;
  let dashboard = "";
  const runs: RunSummary[] = [];
  let idle: ReturnType<typeof setTimeout> | undefined;
  let refresh: ReturnType<typeof setTimeout> | undefined;
  const fail = (context: string, error: unknown) => {
    if (stopped || failure) return;
    failure = new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    stream?.destroy(failure);
    controller.abort();
  };
  const pending = new Set<Promise<void>>();
  const watch = (work: Promise<unknown>, context: string, allowRefusal = false) => {
    const handled = work.then(() => {}, (error) => {
      if (allowRefusal && error instanceof PostError && error.status === 409 && error.code === "platform_refused") return;
      // Retried already. The send fails for this reply; the stream stays up for the other runs.
      if (allowRefusal && unavailable(error)) return;
      fail(context, error);
    });
    pending.add(handled);
    void handled.then(() => pending.delete(handled));
  };

  // Tools: same name, description and input; running one asks the cloud, which holds the request
  // until its simulator has answered and the chosen latency has passed.
  // 210s already includes the default POST budget. A session that sets its own uses that instead, so a test can still watch a timeout.
  const toolBudget = options.postTimeoutMs == null ? CLOUD_MODEL_BUDGET_MS : postTimeoutMs;
  const toolWait = new Map(options.tools.map((t) => [t.name, toolTimeoutMs(options.files, t.name, toolBudget)]));
  const tools: Tool[] = options.tools.map((t) => ({
    ...t,
    run: async (input: unknown, context: { conversationId: string }) => {
      const request: ToolCallRequest = { conversationId: context.conversationId, tool: t.name, input };
      const result = await postRetry<ToolCallResult>(`${session}/tool-calls`, request, auth, controller.signal, log, toolWait.get(t.name) ?? postTimeoutMs, {
        mode: idempotent ? "idempotent" : "never", key: `tool:${randomUUID()}`, budgetMs: retryBudgetMs, what: "tool call",
      });
      if (!result.ok) throw new Error(result.error);
      return result.output;
    },
  }));

  // Events go up in small batches, so the cloud can show the trace and time the agent.
  const queued: Array<{ json: string; bytes: number; at: number }> = [];
  let flushing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let eventSeq = 0;
  const flush = async () => {
    while (queued.length) {
      const seq = ++eventSeq;
      let bytes = Buffer.byteLength(`{"seq":${seq},"events":[]}`);
      let count = 0;
      while (count < queued.length && count < 500) {
        const next = queued[count].bytes + (count ? 1 : 0);
        if (bytes + next > 5_000_000) break;
        bytes += next;
        count++;
      }
      if (!count) throw new Error("one event exceeds the 5MB upload limit");
      const batch = queued.slice(0, count);
      const started = Date.now();
      const wait = started - batch[0].at;
      let failed = false;
      try {
        await postRetry(`${session}/events`, undefined, auth, controller.signal, log, postTimeoutMs, {
          mode: idempotent ? "idempotent" : "never",
          key: `events:${seq}`,
          serialized: `{"seq":${seq},"events":[${batch.map((e) => e.json).join(",")}]}`,
          budgetMs: retryBudgetMs,
          what: "event upload",
        });
        queued.splice(0, count);
      } catch (error) {
        const closed = error instanceof PostError && error.status === 409 && error.code === "session_closed";
        const aborted = stopped && error instanceof Error && error.name === "AbortError";
        if (closed || aborted) {
          log(`session already finished, dropped ${count} events`);
          queued.splice(0, count);
          continue;
        }
        failed = true;
        // An older cloud does not store the key, so a retry might apply the batch twice.
        const again = idempotent ? "retried" : "not retried";
        throw new Error(`event upload failed; acceptance unknown, ${again}`, { cause: error });
      } finally {
        const roundtrip = Date.now() - started;
        if (failed || roundtrip >= 1_000 || wait >= 1_000) {
          log(`event upload ${failed ? "failed" : "slow"}: roundtrip_ms=${roundtrip} count=${count} bytes=${bytes} queue_wait_ms=${wait}`);
        }
      }
    }
  };
  const startFlush = () => {
    if (flushing || stopped || failure || !session) return;
    flushing = flush().catch((error) => fail("events", error)).finally(() => { flushing = null; });
  };
  const events: EventSink = (event) => {
    if (stopped || failure) return;
    try {
      const json = JSON.stringify(event);
      queued.push({ json, bytes: Buffer.byteLength(json), at: Date.now() });
      if (!flushing && !timer) timer = setTimeout(() => { timer = undefined; startFlush(); }, 100);
    } catch (error) { fail("event serialization", error); }
  };
  // The test cloud judges from this. Other sinks do not get it unless they ask.
  events.context = true;
  try {
  const agent = options.build({ tools, events: [events] });

  const open: OpenSession = {
    agent: { name: options.name, title: options.title, tools: options.tools.map(toSpec), channels: agent.channels() },
    files: options.files.map(({ path, hash }) => ({ path, hash })),
    runs: options.runs ?? 1,
    deliveryReceipts: true,
    retries: true,
    resume: true,
  };
  const opened = await post<Opened>(`${base}/api/sessions`, open, options.openHeaders, controller.signal, undefined, postTimeoutMs);
  idempotent = opened.idempotency === true;
  const tunnel = tunnelBase(base, opened);
  auth = { authorization: `Bearer ${opened.token}` };
  const missing = new Set(opened.missing);
  const uploads = options.files.filter((f) => missing.has(f.hash));
  if (uploads.length) {
    await postRetry(`${tunnel}/api/files`, { files: uploads }, auth, controller.signal, log, postTimeoutMs, {
      mode: idempotent ? "idempotent" : "never",
      key: `files:${createHash("sha256").update(uploads.map((file) => file.hash).join("\n")).digest("hex")}`,
      budgetMs: retryBudgetMs,
      what: "file upload",
    });
  }
  log(`Session ${opened.sessionId}: suite ${suiteHash(options.files).slice(0, 12)}, ${options.files.length} files (${uploads.length} uploaded).`);
  dashboard = opened.dashboard;
  options.onDashboard?.(dashboard);
  log(`Watch it: ${opened.dashboard}`);
  session = `${tunnel}/api/sessions/${opened.sessionId}`;

  if (failure) throw failure;
  startFlush();
  const streamUrl = `${session}/stream`;
  stream = await openStream(streamUrl, auth, controller.signal);
  if (failure) throw failure;
  // A cloud that resumes numbers its commands: a lost stream is opened again after the last one
  // handled, and a command the cloud sends again is skipped.
  const resume = opened.resume === true;
  let lastId = 0;
  let refreshing = false;
  // The cloud writes ": ping" every 15s. Three missed pings and the stream is dead.
  const arm = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      const lost = new StreamLost(`no bytes for ${streamIdleMs / 1000}s`);
      if (resume) stream?.destroy(lost);
      else fail("the stream is dead", lost);
    }, streamIdleMs);
  };
  // The tunnel cuts a request at an hour, so a resumable stream is replaced before then.
  const scheduleRefresh = () => {
    if (refresh) clearTimeout(refresh);
    if (resume) refresh = setTimeout(() => { refreshing = true; stream?.destroy(); }, streamRefreshMs);
  };
  arm();
  scheduleRefresh();
  let draining = false;
  let drained = false;
  let receiveFails = 0;
  // Drain and the drained POST wait on deliveries that can outlast the idle window. Pings
  // still arrive, and sit unread until that wait ends, so the timer must be down for it.
  const pauseIdle = () => {
    if (idle) clearTimeout(idle);
    idle = undefined;
  };
  const drainWork = async () => {
    // Delivery completion may enqueue recovery events or another outbound, so keep
    // draining until both lanes are empty. Event batches remain strictly serial.
    do {
      while (pending.size) await Promise.all(pending);
      if (failure) throw failure;
      if (timer) { clearTimeout(timer); timer = undefined; }
      startFlush();
      await flushing;
      if (failure) throw failure;
    } while (pending.size || queued.length);
  };
  /** One command from the stream. Returns the summary once the session has finished. */
  const handle = async (command: Command): Promise<SessionSummary | undefined> => {
    if (draining && (command.type === "message" || command.type === "reaction")) throw new Error("the cloud sent a command after drain");
    if (command.type === "message") {
      const deliveries: Promise<unknown>[] = [];
      // Not async: register the promise during receive(), before its fire-and-forget
      // interceptor returns null. Each command owns its deliveries, even in a burst.
      let outboundIndex = 0;
      const deliver = (outbound: Outbound): Promise<void> => {
        const index = outboundIndex++;
        const delivery = postRetry(`${session}/outbound`, { conversationId: command.conversationId, outbound }, auth, controller.signal, log, postTimeoutMs, {
          mode: idempotent ? "idempotent" : "outbound",
          key: `outbound:${command.conversationId}:${command.messageId}:${index}`,
          budgetMs: retryBudgetMs,
          what: "outbound delivery",
        }).then(() => {});
        deliveries.push(delivery);
        // Keep the rejection for the normal conversation's delivery recovery, but
        // attach a handler immediately for fire-and-forget interceptor sends too.
        // A tunnel blip (no JSON from the cloud) is not a reason to end the session.
        watch(delivery, "outbound delivery", true);
        return delivery;
      };
      let taken: string | null;
      try {
        taken = agent.receive(command.conversationId, withFiles(command.incoming, options.testsDir, log), deliver, {
        channel: command.channel,
        channelName: command.channelName,
        messageId: command.messageId,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        receiveFails++;
        // One broken message can time out. An agent that throws on every message would
        // wait out the whole suite, one run at a time.
        if (receiveFails >= 3) throw new Error(`the agent throws on every message: ${detail}`);
        log(`receive failed: ${detail}`);
        return;
      }
      receiveFails = 0;
      const receipt: Receipt = { conversationId: command.conversationId, messageId: command.messageId, status: taken === null ? "intercepted" : "taken" };
      const sendReceipt = () => postRetry(`${session}/receipts`, receipt, auth, controller.signal, log, postTimeoutMs, {
        mode: idempotent ? "idempotent" : "never",
        key: `receipt:${receipt.conversationId}:${receipt.messageId}`,
        budgetMs: retryBudgetMs,
        what: "delivery receipt",
      });
      // An intercepted reply waits until its outbound bodies land. A tunnel blip on one of them
      // is not a receipt failure: this run can time out, and the later runs still play. A real
      // refusal still ends the session, the same as a receipt the tunnel rejected.
      const receiptWork = taken === null
        ? Promise.all(deliveries).then(sendReceipt, (error: unknown) => { if (!unavailable(error)) throw error; })
        : sendReceipt();
      watch(receiptWork, "delivery receipt");
    } else if (command.type === "reaction") {
      agent.reacted(command.conversationId, command.emoji, command.toText);
    } else if (command.type === "run") {
      runs.push(command.run);
      options.onRun?.(command.run);
    } else if (command.type === "drain") {
      if (draining) throw new Error("the cloud sent drain twice");
      draining = true;
      pauseIdle();
      await drainWork();
      await postRetry(`${session}/drained`, {}, auth, controller.signal, log, postTimeoutMs, {
        mode: idempotent ? "idempotent" : "never",
        key: `drained:${opened.sessionId}`,
        budgetMs: retryBudgetMs,
        what: "drained",
      });
      drained = true;
      arm();
    } else if (command.type === "finished") {
      pauseIdle();
      if (!drained) await drainWork();
      return command.summary;
    } else if (command.type === "failed") {
      throw new Error(`the cloud stopped the session: ${command.error}`);
    }
  };
  /** The stream opened again after the last command handled, with backoff, until the resume window closes. */
  const reconnect = async (why: string): Promise<IncomingMessage> => {
    log(`stream ${why}; resuming after command ${lastId}`);
    const deadline = Date.now() + resumeWindowMs;
    let last: unknown;
    for (let attempt = 0; ; attempt++) {
      const backoff = attempt === 0 ? 0 : Math.min(10_000, 250 * 2 ** attempt) * (0.8 + Math.random() * 0.4);
      const refused = last instanceof Error && last.cause instanceof PostError ? last.cause : undefined;
      const wait = Math.max(backoff, refused?.retryAfterMs ?? 0);
      if (Date.now() + wait >= deadline) {
        const detail = last instanceof Error ? `; last try: ${last.message}` : "";
        throw new StreamLost(`the stream did not resume within ${resumeWindowMs / 1000}s (${why})${detail}`);
      }
      await pause(wait, controller.signal);
      if (failure) throw failure;
      try {
        return await openStream(streamUrl, { ...auth, "last-event-id": String(lastId) }, controller.signal, Math.max(1, Math.min(postTimeoutMs, deadline - Date.now())));
      } catch (error) {
        if (failure) throw failure;
        const cause = error instanceof Error && error.cause instanceof PostError ? error.cause : error;
        const code = cause instanceof PostError && cause.code ? ` ${cause.code}` : "";
        if (!retryable(cause, "idempotent")) throw new StreamLost(`the stream could not resume: ${error instanceof Error ? error.message : String(error)}${code}`, { cause: error });
        last = error;
      }
    }
  };
  for (;;) {
    const decoder = new TextDecoder();
    const chunks = stream[Symbol.asyncIterator]();
    let buffer = "";
    let lost: unknown;
    for (;;) {
      let next: IteratorResult<Buffer>;
      try {
        next = await chunks.next();
      } catch (error) {
        lost = error;
        break;
      }
      if (next.done) break;
      arm();
      buffer += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end).split("\n");
        buffer = buffer.slice(end + 2);
        const data = frame.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
        if (!data) continue;
        const idLine = frame.find((l) => l.startsWith("id:"));
        const id = idLine === undefined ? NaN : Number(idLine.slice(3).trim());
        if (Number.isSafeInteger(id) && id > 0) {
          // Sent again after a resume: it was handled on the stream before.
          if (id <= lastId) continue;
          lastId = id;
        }
        let command: Command;
        try {
          command = JSON.parse(data) as Command;
        } catch {
          log("a stream frame was not valid JSON");
          continue;
        }
        const summary = await handle(command);
        if (summary) return summary;
      }
    }
    if (failure) throw failure;
    const closed = new StreamLost("the cloud closed the stream before the session finished");
    if (!resume) throw lost ?? closed;
    pauseIdle();
    const why = refreshing ? "refreshed before the tunnel's hour limit" : `lost (${lost instanceof Error ? lost.message : "the cloud closed it"})`;
    refreshing = false;
    stream.destroy();
    stream = await reconnect(why);
    arm();
    scheduleRefresh();
  }
  } catch (error) {
    if (error instanceof SessionStopped) throw error;
    const reason = failure ?? (error instanceof Error ? error : new Error(String(error)));
    // Exit 2 is a transport failure after the session exists. A refusal, or anything
    // before the open answers, is the error itself (the CLI exits 1 and prints it alone).
    if (dashboard && isTransportFailure(reason)) throw new SessionStopped(reason.message, runs, dashboard);
    throw reason;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (idle) clearTimeout(idle);
    if (refresh) clearTimeout(refresh);
    stream?.destroy();
    controller.abort();
    await Promise.all(pending);
    await flushing;
  }
}

/** The stream on a connection of its own. fetch shares one HTTP/2 connection per origin, and over
 * HTTPS a request behind another open one on it waits until that one finishes: a tool call the
 * cloud has not answered held every later event and reply, and the run ended agent_quiet.
 * A refusal's status and JSON code are its cause, a PostError. A resume waits at most `timeoutMs` for the answer. */
function openStream(url: string, headers: Record<string, string>, signal: AbortSignal, timeoutMs?: number): Promise<IncomingMessage> {
  const request = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, agent: false, signal }, (response) => {
      if (timer) clearTimeout(timer);
      if (response.statusCode === 200) return resolve(response);
      const status = response.statusCode ?? 0;
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { if (text.length < 4_096) text += chunk; });
      response.on("error", () => {});
      response.on("end", () => {
        let code: string | undefined;
        try { code = JSON.parse(text).error; } catch { /* the body was not JSON */ }
        const cause = new PostError(url, status, text, typeof code === "string" ? code : undefined, retryAfterOf(flatHeaders(response.headers)));
        reject(new Error(`could not open the stream (${status})`, { cause }));
      });
    });
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => req.destroy(new TimeoutError()), timeoutMs);
    req.on("error", (error) => { if (timer) clearTimeout(timer); reject(error); }).end();
  });
}

class PostError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterMs?: number;
  constructor(url: string, status: number, text: string, code?: string, retryAfterMs?: number) {
    super(`${url}: ${status} ${shown(text)}`);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** This call can be dropped and the session continues: a frontend page with no JSON, a
 * timeout, or a connection that died. */
function unavailable(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (error instanceof PostError) return !error.code && (error.status === 502 || error.status === 503 || error.status === 504);
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE" || code === "ETIMEDOUT" || code === "EAI_AGAIN" || error.message === "socket hang up";
}

/** The tunnel, the stream, or the connection, as opposed to a refusal the cloud wrote as JSON. */
function isTransportFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let guard = 0; current instanceof Error && guard < 6; guard++) {
    if (current instanceof TimeoutError || current instanceof StreamLost) return true;
    if (current instanceof PostError) return !current.code && (current.status === 502 || current.status === 503 || current.status === 504);
    if (/^could not open the stream \((502|503|504)\)$/.test(current.message)) return true;
    const code = (current as NodeJS.ErrnoException).code;
    if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE" || code === "ETIMEDOUT" || code === "EAI_AGAIN" || code === "ENOTFOUND" || current.message === "socket hang up") return true;
    current = current.cause;
  }
  return false;
}

/** Safe to send again, until the cloud stores an idempotency key. A 502/503/504 with no JSON
 * never reached the container. A failure before the connection was made did not either.
 * A timeout or a reset may mean the reply was already delivered. */
function retryableOutbound(error: unknown): boolean {
  if (error instanceof PostError) return !error.code && (error.status === 502 || error.status === 503 || error.status === 504);
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ECONNREFUSED" || code === "EAI_AGAIN" || code === "ENOTFOUND";
}

function shown(text: string): string {
  const plain = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain.slice(0, 180);
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

type RetryMode = "never" | "outbound" | "idempotent";

/** Whether this failure may be sent again. A JSON refusal never is. An older cloud retries an
 * outbound only when the body cannot have arrived. A cloud that stores keys also retries a
 * timeout, a reset, a 429, and its own 503 unavailable. */
function retryable(error: unknown, mode: RetryMode): boolean {
  if (mode === "never") return false;
  if (mode === "outbound") return retryableOutbound(error);
  if (error instanceof TimeoutError) return true;
  if (error instanceof PostError) {
    if (error.status === 429) return true;
    if (error.status === 503 && error.code === "unavailable") return true;
    return !error.code && (error.status === 502 || error.status === 503 || error.status === 504);
  }
  if (!(error instanceof Error) || error.name === "AbortError") return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE" || code === "ETIMEDOUT" || code === "EAI_AGAIN" || code === "ENOTFOUND" || error.message === "socket hang up";
}

function retryStatus(error: unknown): string {
  if (error instanceof PostError) return String(error.status);
  if (error instanceof TimeoutError) return "timed out";
  return "no response";
}

/** Wait between tries: Retry-After when the cloud set one, otherwise exponential with jitter. */
function retryWaitMs(attempt: number, error: unknown): number {
  if (error instanceof PostError && error.retryAfterMs !== undefined) return error.retryAfterMs;
  const base = 200 * 2 ** attempt;
  return base + Math.random() * base * 0.2;
}

/** One call, sent again when that is safe, until the budget has passed since its first failure.
 * The same Idempotency-Key goes on every try. */
async function postRetry<T>(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal | undefined, log: (line: string) => void, timeoutMs: number, options: { mode: RetryMode; key: string; budgetMs: number; what: string; serialized?: string }): Promise<T> {
  let firstFailure: number | undefined;
  let attempt = 0;
  const headersWithKey = { ...headers, "idempotency-key": options.key };
  for (;;) {
    try {
      return await post<T>(url, body, headersWithKey, signal, options.serialized, timeoutMs);
    } catch (error) {
      const again = retryable(error, options.mode);
      firstFailure ??= Date.now();
      const elapsed = Date.now() - firstFailure;
      const wait = again ? retryWaitMs(attempt, error) : 0;
      if (!again || elapsed + wait > options.budgetMs) {
        if (again) log(`${options.what} failed after ${attempt + 1} tries`);
        else if (options.mode !== "never" && unavailable(error)) log(`${options.what} failed (${retryStatus(error)})`);
        throw error;
      }
      log(`${options.what} unavailable (${retryStatus(error)}), trying again`);
      await pause(wait, signal);
      attempt++;
    }
  }
}

/** POSTs share a keep-alive agent and speak HTTP/1.1, so each request still in flight has its own
 * socket. A tool call the cloud has not answered cannot hold the later ones, and a finished
 * connection is reused. The stream stays on a connection of its own (openStream). */
const httpPosts = new HttpAgent({ keepAlive: true });
const httpsPosts = new HttpsAgent({ keepAlive: true });

function requestOnce(url: string, payload: string, headers: Record<string, string>, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ status: number; text: string; headers: Record<string, string> }> {
  const secure = url.startsWith("https:");
  const request = secure ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const finish = (error?: Error, result?: { status: number; text: string; headers: Record<string, string> }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };
    const req = request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers, "content-length": Buffer.byteLength(payload) },
      agent: secure ? httpsPosts : httpPosts,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("error", finish);
      response.on("aborted", () => finish(new Error("The request was aborted")));
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => finish(undefined, { status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers: flatHeaders(response.headers) }));
    });
    timer = setTimeout(() => { finish(new TimeoutError()); req.destroy(); }, timeoutMs);
    if (signal) {
      onAbort = () => { finish(abortError(signal)); req.destroy(); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    req.on("error", (error) => finish(signal?.aborted ? abortError(signal) : error));
    req.end(payload);
  });
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}

function flatHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") out[name] = value;
    else if (Array.isArray(value)) out[name] = value.join(", ");
  }
  return out;
}

function retryAfterOf(headers: Record<string, string>): number | undefined {
  const value = headers["retry-after"];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

async function post<T = unknown>(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal, serialized?: string, timeoutMs = POST_TIMEOUT_MS): Promise<T> {
  const payload = serialized ?? JSON.stringify(body ?? {});
  const { status, text, headers: responseHeaders } = await requestOnce(url, payload, headers, signal, postBudgetMs(timeoutMs, Buffer.byteLength(payload)));
  if (status < 200 || status >= 300) {
    let code: string | undefined;
    try { code = JSON.parse(text).error; } catch { /* the body was not JSON */ }
    throw new PostError(url, status, text, code, retryAfterOf(responseHeaders));
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** The person's message with the files it names read from the tests folder, and only from there. */
function withFiles(incoming: WireIncoming, testsDir: string | undefined, log: (line: string) => void): Incoming {
  const { attachments, ...rest } = incoming;
  if (!attachments?.length) return rest;
  return {
    ...rest,
    attachments: attachments.map((a) => ({
      kind: a.kind,
      mime: mimeOf(a.file),
      name: basename(a.file),
      data: () => {
        const reading = readAttachment(testsDir, a.file);
        // A caller that never awaits still must not become an uncaught exception.
        reading.catch((error) => log(`attachment could not be read: ${a.file}: ${error instanceof Error ? error.message : String(error)}`));
        return reading;
      },
    })),
  };
}

function readAttachment(testsDir: string | undefined, file: string): Promise<Uint8Array> {
  const path = testsDir ? resolve(testsDir, file) : "";
  const inside = testsDir && !relative(resolve(testsDir), path).startsWith("..") && path !== resolve(testsDir);
  if (!inside) return Promise.reject(new Error(`${file} is not a file in the tests folder`));
  return readFile(path).then((bytes) => new Uint8Array(bytes));
}
