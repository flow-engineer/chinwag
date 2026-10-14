// The developer's side of the tunnel: connects a local agent to the test cloud. The agent keeps its
// own model and key; its tools are replaced by calls the cloud simulates, its replies go to the
// cloud's platform simulators, and the person's messages arrive over one stream.

import { readFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, relative, resolve } from "node:path";
import { toSpec, type Agent, type Incoming, type EventSink, type Outbound, type ChinwagEvent, type Tool } from "../../src/index.ts";
import type { Command, Opened, WireIncoming, OpenSession, SessionSummary, ToolCallRequest, ToolCallResult } from "./protocol.ts";
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
  /** Builds the agent with the tools and events it is given. */
  build: (options: { tools: Tool[]; events: EventSink[] }) => Agent;
  files: SuiteFile[];
  /** The tests folder: files a scenario attaches are read from here, and never leave this machine. */
  testsDir?: string;
  runs?: number;
  log?: (line: string) => void;
  /** Headers for the open only (cloudHeaders: the CI key and the attestation); never sent to the tunnel. */
  openHeaders?: Record<string, string>;
}

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

  // Tools: same name, description and input; running one asks the cloud, which holds the request
  // until its simulator has answered and the chosen latency has passed.
  const tools: Tool[] = options.tools.map((t) => ({
    ...t,
    run: async (input: unknown, context: { conversationId: string }) => {
      const request: ToolCallRequest = { conversationId: context.conversationId, tool: t.name, input };
      const result = await post<ToolCallResult>(`${session}/tool-calls`, request, auth);
      if (!result.ok) throw new Error(result.error);
      return result.output;
    },
  }));

  // Events go up in small batches, so the cloud can show the trace and time the agent.
  let queued: ChinwagEvent[] = [];
  let flushing: Promise<void> | null = null;
  const flush = async () => {
    while (queued.length) {
      const events = queued;
      queued = [];
      await post(`${session}/events`, { events }, auth).catch((error) => log(`events not sent: ${error}`));
    }
    flushing = null;
  };
  const events: EventSink = (event) => {
    queued.push(event);
    flushing ??= new Promise((r) => setTimeout(r, 100)).then(flush);
  };
  const agent = options.build({ tools, events: [events] });

  const open: OpenSession = {
    agent: { name: options.name, title: options.title, tools: options.tools.map(toSpec), channels: agent.channels() },
    files: options.files.map(({ path, hash }) => ({ path, hash })),
    runs: options.runs ?? 1,
  };
  const opened = await post<Opened>(`${base}/api/sessions`, open, options.openHeaders);
  const tunnel = tunnelBase(base, opened);
  auth = { authorization: `Bearer ${opened.token}` };
  const missing = new Set(opened.missing);
  const uploads = options.files.filter((f) => missing.has(f.hash));
  if (uploads.length) await post(`${tunnel}/api/files`, { files: uploads }, auth);
  log(`Session ${opened.sessionId}: suite ${suiteHash(options.files).slice(0, 12)}, ${options.files.length} files (${uploads.length} uploaded).`);
  log(`Watch it: ${opened.dashboard}`);
  session = `${tunnel}/api/sessions/${opened.sessionId}`;

  const deliverTo = (conversationId: string) => async (outbound: Outbound) => {
    const response = await fetch(`${session}/outbound`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ conversationId, outbound }),
    });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `refused (${response.status})`);
  };

  const stream = await openStream(`${session}/stream`, auth);
  let buffer = "";
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
      if (command.type === "message") {
        agent.receive(command.conversationId, withFiles(command.incoming, options.testsDir), deliverTo(command.conversationId), {
          channel: command.channel,
          channelName: command.channelName,
          messageId: command.messageId,
        });
      } else if (command.type === "reaction") {
        agent.reacted(command.conversationId, command.emoji, command.toText);
      } else if (command.type === "finished") {
        await flushing;
        return command.summary;
      } else if (command.type === "failed") {
        throw new Error(`the cloud stopped the session: ${command.error}`);
      }
    }
  }
  throw new Error("the cloud closed the stream before the session finished");
}

/** The stream on a connection of its own. fetch shares one HTTP/2 connection per origin, and over
 * HTTPS a POST behind an open stream on it was held until the stream closed: the cloud heard no
 * reply and ended every run agent_quiet. */
function openStream(url: string, headers: Record<string, string>): Promise<IncomingMessage> {
  const request = url.startsWith("https:") ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    request(url, { headers, agent: false }, (response) => {
      if (response.statusCode === 200) return resolve(response);
      response.resume();
      reject(new Error(`could not open the stream (${response.statusCode})`));
    })
      .on("error", reject)
      .end();
  });
}

async function post<T = unknown>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url}: ${response.status} ${text}`);
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
