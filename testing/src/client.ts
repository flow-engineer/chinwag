// The developer's side of the tunnel: connects a local agent to the test cloud. The agent keeps its
// own model and key; its tools are replaced by calls the cloud simulates, its replies go to the
// cloud's platform simulators, and the person's messages arrive over one stream.

import { readFile } from "node:fs/promises";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { basename, relative, resolve } from "node:path";
import { toSpec, type Agent, type Incoming, type EventSink, type Outbound, type ChinwagEvent, type Tool } from "../../src/index.ts";
import type { Command, Opened, WireIncoming, OpenSession, Receipt, RunSummary, SessionSummary, ToolCallRequest, ToolCallResult } from "./protocol.ts";
import { mimeOf, suiteHash, type SuiteFile } from "./suite.ts";

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
  const base = options.cloud.replace(/\/$/, "");

  // The session's address is known once it opens; tools and events only use it after that.
  let session = "";
  let auth: Record<string, string> = {};
  const controller = new AbortController();
  let stream: IncomingMessage | undefined;
  let stopped = false;
  let failure: Error | undefined;
  const fail = (context: string, error: unknown) => {
    if (stopped || failure) return;
    failure = new Error(`${context}: ${error instanceof Error ? error.message : String(error)}`);
    stream?.destroy(failure);
    controller.abort();
  };
  const pending = new Set<Promise<void>>();
  const watch = (work: Promise<unknown>, context: string, allowRefusal = false) => {
    const handled = work.then(() => {}, (error) => {
      if (allowRefusal && error instanceof PostError && error.status === 409 && error.code === "platform_refused") return;
      fail(context, error);
    });
    pending.add(handled);
    void handled.then(() => pending.delete(handled));
  };

  // Tools: same name, description and input; running one asks the cloud, which holds the request
  // until its simulator has answered and the chosen latency has passed.
  const tools: Tool[] = options.tools.map((t) => ({
    ...t,
    run: async (input: unknown, context: { conversationId: string }) => {
      const request: ToolCallRequest = { conversationId: context.conversationId, tool: t.name, input };
      const result = await post<ToolCallResult>(`${session}/tool-calls`, request, auth, controller.signal);
      if (!result.ok) throw new Error(result.error);
      return result.output;
    },
  }));

  // Events go up in small batches, so the cloud can show the trace and time the agent.
  const queued: Array<{ json: string; bytes: number; at: number }> = [];
  let flushing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = async () => {
    while (queued.length) {
      let bytes = Buffer.byteLength('{"events":[]}');
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
        await post(`${session}/events`, undefined, auth, controller.signal, `{"events":[${batch.map((e) => e.json).join(",")}]}`);
        // Keep the batch until acknowledged. An ambiguous failure ends the session, never retries
        // lifecycle events which the cloud might already have applied.
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
        throw new Error("event upload failed; acceptance unknown, not retried");
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
  };
  const opened = await post<Opened>(`${base}/api/sessions`, open, options.openHeaders, controller.signal);
  const tunnel = tunnelBase(base, opened);
  auth = { authorization: `Bearer ${opened.token}` };
  const missing = new Set(opened.missing);
  const uploads = options.files.filter((f) => missing.has(f.hash));
  if (uploads.length) await post(`${tunnel}/api/files`, { files: uploads }, auth, controller.signal);
  log(`Session ${opened.sessionId}: suite ${suiteHash(options.files).slice(0, 12)}, ${options.files.length} files (${uploads.length} uploaded).`);
  log(`Watch it: ${opened.dashboard}`);
  session = `${tunnel}/api/sessions/${opened.sessionId}`;

  if (failure) throw failure;
  startFlush();
  stream = await openStream(`${session}/stream`, auth, controller.signal);
  if (failure) throw failure;
  let buffer = "";
  let draining = false;
  let drained = false;
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
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (!data) continue;
      const command = JSON.parse(data) as Command;
      if (draining && (command.type === "message" || command.type === "reaction")) throw new Error("the cloud sent a command after drain");
      if (command.type === "message") {
        const deliveries: Promise<unknown>[] = [];
        // Not async: register the promise during receive(), before its fire-and-forget
        // interceptor returns null. Each command owns its deliveries, even in a burst.
        const deliver = (outbound: Outbound): Promise<void> => {
          const delivery = post(`${session}/outbound`, { conversationId: command.conversationId, outbound }, auth, controller.signal).then(() => {});
          deliveries.push(delivery);
          // Keep the rejection for the normal conversation's delivery recovery, but
          // attach a handler immediately for fire-and-forget interceptor sends too.
          watch(delivery, "outbound delivery", true);
          return delivery;
        };
        let taken: string | null;
        try {
          taken = agent.receive(command.conversationId, withFiles(command.incoming, options.testsDir), deliver, {
          channel: command.channel,
          channelName: command.channelName,
          messageId: command.messageId,
          });
        } catch (error) { fail("receive", error); throw failure; }
        const receipt: Receipt = { conversationId: command.conversationId, messageId: command.messageId, status: taken === null ? "intercepted" : "taken" };
        const sendReceipt = () => post(`${session}/receipts`, receipt, auth, controller.signal);
        watch(taken === null ? Promise.all(deliveries).then(sendReceipt) : sendReceipt(), "delivery receipt");
      } else if (command.type === "reaction") {
        agent.reacted(command.conversationId, command.emoji, command.toText);
      } else if (command.type === "run") {
        options.onRun?.(command.run);
      } else if (command.type === "drain") {
        if (draining) throw new Error("the cloud sent drain twice");
        draining = true;
        await drainWork();
        await post(`${session}/drained`, {}, auth, controller.signal);
        drained = true;
      } else if (command.type === "finished") {
        if (!drained) await drainWork();
        return command.summary;
      } else if (command.type === "failed") {
        throw new Error(`the cloud stopped the session: ${command.error}`);
      }
    }
  }
  throw new Error("the cloud closed the stream before the session finished");
  } catch (error) {
    throw failure ?? error;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    stream?.destroy();
    controller.abort();
    await Promise.all(pending);
    await flushing;
  }
}

/** The stream on a connection of its own. fetch shares one HTTP/2 connection per origin, and over
 * HTTPS a request behind another open one on it waits until that one finishes: a tool call the
 * cloud has not answered held every later event and reply, and the run ended agent_quiet. */
function openStream(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<IncomingMessage> {
  const request = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    request(url, { headers, agent: false, signal }, (response) => {
      if (response.statusCode === 200) return resolve(response);
      response.resume();
      reject(new Error(`could not open the stream (${response.statusCode})`));
    })
      .on("error", reject)
      .end();
  });
}

class PostError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(url: string, status: number, text: string, code?: string) {
    super(`${url}: ${status} ${text}`);
    this.status = status;
    this.code = code;
  }
}

/** POSTs share a keep-alive agent and speak HTTP/1.1, so each request still in flight has its own
 * socket. A tool call the cloud has not answered cannot hold the later ones, and a finished
 * connection is reused. The stream stays on a connection of its own (openStream). */
const httpPosts = new HttpAgent({ keepAlive: true });
const httpsPosts = new HttpsAgent({ keepAlive: true });

function requestOnce(url: string, payload: string, headers: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  const secure = url.startsWith("https:");
  const request = secure ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers, "content-length": Buffer.byteLength(payload) },
      agent: secure ? httpsPosts : httpPosts,
      signal,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("error", fail);
      response.on("aborted", () => fail(new Error("The request was aborted")));
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", fail);
    req.end(payload);
  });
}

async function post<T = unknown>(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal, serialized?: string): Promise<T> {
  const { status, text } = await requestOnce(url, serialized ?? JSON.stringify(body ?? {}), headers, signal);
  if (status < 200 || status >= 300) {
    let code: string | undefined;
    try { code = JSON.parse(text).error; } catch { /* the body was not JSON */ }
    throw new PostError(url, status, text, code);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** The person's message with the files it names read from the tests folder, and only from there. */
function withFiles(incoming: WireIncoming, testsDir: string | undefined): Incoming {
  const { attachments, ...rest } = incoming;
  if (!attachments?.length) return rest;
  return {
    ...rest,
    attachments: attachments.map((a) => ({
      kind: a.kind,
      mime: mimeOf(a.file),
      name: basename(a.file),
      data: async () => {
        const path = testsDir ? resolve(testsDir, a.file) : "";
        const inside = testsDir && !relative(resolve(testsDir), path).startsWith("..") && path !== resolve(testsDir);
        if (!inside) throw new Error(`${a.file} is not a file in the tests folder`);
        return new Uint8Array(await readFile(path));
      },
    })),
  };
}
