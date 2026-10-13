// The developer's side of the tunnel: connects a local agent to the test cloud. The agent keeps its
// own model and key; its tools are replaced by calls the cloud simulates, its replies go to the
// cloud's platform simulators, and the person's messages arrive over one stream.

import { toSpec, type Agent, type EventSink, type Outbound, type ParleyEvent, type Tool } from "../../src/index.ts";
import type { Command, Opened, OpenSession, SessionSummary, ToolCallRequest, ToolCallResult } from "./protocol.ts";
import { suiteHash, type SuiteFile } from "./suite.ts";

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
  runs?: number;
  log?: (line: string) => void;
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
  let queued: ParleyEvent[] = [];
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
  const opened = await post<Opened>(`${base}/api/sessions`, open);
  auth = { authorization: `Bearer ${opened.token}` };
  const missing = new Set(opened.missing);
  const uploads = options.files.filter((f) => missing.has(f.hash));
  if (uploads.length) await post(`${base}/api/files`, { files: uploads }, auth);
  log(`Session ${opened.sessionId}: suite ${suiteHash(options.files).slice(0, 12)}, ${options.files.length} files (${uploads.length} uploaded).`);
  log(`Watch it: ${opened.dashboard}`);
  session = `${base}/api/sessions/${opened.sessionId}`;

  const deliverTo = (conversationId: string) => async (outbound: Outbound) => {
    const response = await fetch(`${session}/outbound`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ conversationId, outbound }),
    });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `refused (${response.status})`);
  };

  const response = await fetch(`${session}/stream`, { headers: auth });
  if (!response.ok || !response.body) throw new Error(`could not open the stream (${response.status})`);
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
      if (!data) continue;
      const command = JSON.parse(data) as Command;
      if (command.type === "message") {
        agent.receive(command.conversationId, command.incoming, deliverTo(command.conversationId), {
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

async function post<T = unknown>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url}: ${response.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}
