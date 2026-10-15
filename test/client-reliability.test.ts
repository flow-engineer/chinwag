// covers: testing/src/client.ts test/fault-proxy.ts
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z, type Tool } from "../src/index.ts";
import { runInCloud, SessionStopped, TimeoutError, toolTimeoutMs } from "../testing/src/client.ts";
import type { Command } from "../testing/src/protocol.ts";
import { rollFault, startFaultProxy } from "./fault-proxy.ts";

const message = (messageId: string, file?: string): Command => ({
  type: "message", conversationId: "c", messageId, channel: { reactions: false, status: false },
  incoming: file ? { text: "hi", attachments: [{ kind: "image", file }] } : { text: "hi" },
});
const frame = (command: unknown) => `data: ${JSON.stringify(command)}\n\n`;
const run = (runId: string): Command => ({
  type: "run",
  run: {
    runId, scenario: "hello", run: 1, channel: "sms", passed: true, checks: [], ended: "goal",
    turns: 1, messagesIn: 1, messagesOut: 1, toolCalls: 0, slowestAckMs: 1,
    agentUsage: { input: 0, output: 0, costUsd: 0 }, agentModels: [],
    testUsage: { input: 0, output: 0, costUsd: 0 }, watch: `http://watch/${runId}`,
  },
});

function listen(handler: (req: { url: string; body: string }, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => handler({ url: req.url ?? "", body }, res));
  });
  return new Promise<{ url: string; close: () => void }>((done) => {
    server.listen(0, "127.0.0.1", () => done({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

test("a thrown receive, a bad frame and an unreadable attachment leave the session open", { timeout: 10_000 }, async () => {
  const logs: string[] = [];
  let receipts = 0;
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "http://dash/s" }));
    if (url.endsWith("/receipts")) receipts++;
    if (url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(message("broken")));
      res.write("data: {not json}\n\n");
      res.write(frame(message("file", "../../etc/passwd")));
      res.write(frame(run("r1")));
      res.end(frame({ type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "fake", runs: [], dashboard: "http://dash/s" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    const summary = await runInCloud({
      cloud: cloud.url, name: "test", tools: [], files: [], testsDir: mkdtempSync(join(tmpdir(), "chinwag-files-")), log: (line) => logs.push(line),
      build: () => ({
        channels: () => [], reacted: () => {},
        receive: (_id, incoming, _deliver, options) => {
          if (options?.messageId === "broken") throw new Error("broken receive");
          if (typeof incoming !== "string") void incoming.attachments?.[0]?.data();
          return "m";
        },
      }),
    });
    assert.equal(summary.sessionId, "s");
    assert.equal(receipts, 1, "the thrown receive is not acknowledged; the attachment message is");
    const text = logs.join("\n");
    assert.match(text, /receive failed: broken receive/);
    assert.match(text, /a stream frame was not valid JSON/);
    assert.match(text, /attachment could not be read: \.\.\/\.\.\/etc\/passwd/);
  } finally { cloud.close(); }
});

test("a tool call waits out the simulator's latency, then the POST budget, and a timeout is a timeout", { timeout: 10_000 }, async () => {
  const slow = "tool: lookup\nresponses:\n  - { when: slow, latency_ms: 11000 }\n  - { when: ok, latency_ms: 400 }\n";
  assert.equal(toolTimeoutMs([{ path: "tools/lookup.yaml", hash: "h", content: slow }], "lookup", 30_000), 41_000);
  assert.equal(toolTimeoutMs([], "lookup", 30_000), 90_000);
  let timed: unknown;
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d" }));
    if (url.endsWith("/tool-calls")) return; // held open until the client gives up
    if (url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(message("m1")));
      setTimeout(() => res.end(frame({ type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "fake", runs: [], dashboard: "d" } })), 400);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    const summary = await runInCloud({
      cloud: cloud.url, name: "test", log: () => {}, postTimeoutMs: 150,
      tools: [{ name: "lookup", description: "look", input: z.object({}), run: async () => null }],
      files: [{ path: "tools/lookup.yaml", hash: "h", content: "tool: lookup\nresponses:\n  - { when: ok, latency_ms: 0 }\n" }],
      build: ({ tools }: { tools: Tool[] }) => ({
        channels: () => [], reacted: () => {},
        receive: () => {
          const lookup = tools[0];
          if (lookup) void Promise.resolve(lookup.run({}, { conversationId: "c", person: "p", channel: "sms" })).then(() => {}, (error: unknown) => { timed = error; });
          return "m";
        },
      }),
    });
    assert.equal(summary.dashboard, "d");
    assert.ok(timed instanceof TimeoutError);
  } finally { cloud.close(); }
});

test("no bytes for the idle window means the stream is dead, and the run already in is kept", { timeout: 10_000 }, async () => {
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "http://dash/s" }));
    if (url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(run("r1")));
      return; // no ping, no finished
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    await assert.rejects(runInCloud({
      cloud: cloud.url, name: "test", tools: [], files: [], log: () => {}, streamIdleMs: 200,
      build: () => ({ channels: () => [], receive: () => null, reacted: () => {} }),
    }), (error: unknown) => {
      assert.ok(error instanceof SessionStopped);
      assert.match(error.message, /the stream is dead: no bytes for 0.2s/);
      assert.equal(error.dashboard, "http://dash/s");
      assert.equal(error.runs[0]?.runId, "r1");
      return true;
    });
  } finally { cloud.close(); }
});

test("rollFault covers a 503 page, a reset, a delay and a cut stream", () => {
  const posts = new Set<string>();
  const streams = new Set<string>();
  for (let index = 0; index < 40; index++) {
    posts.add(rollFault(1, index, "post"));
    streams.add(rollFault(1, index, "stream"));
  }
  for (const fault of ["html503", "reset", "delay", "ok"]) assert.ok(posts.has(fault), fault);
  assert.ok(streams.has("cut"));
});

test("a faulting proxy still reports every run once and delivers no reply twice", { timeout: 10_000 }, async () => {
  let outbound = 0;
  let stream: ServerResponse | undefined;
  const upstream = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "http://dash/s" }));
    if (url.endsWith("/stream")) {
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(message("m1")));
      res.write(frame(message("m2")));
      setTimeout(() => {
        res.write(frame(run("r1")));
        res.write(frame(run("r2")));
        res.write(frame({ type: "drain" }));
      }, 1200);
      return;
    }
    if (url.endsWith("/drained")) {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      const kept = (id: string) => { const command = run(id); if (command.type !== "run") throw new Error("run"); return command.run; };
      stream?.end(frame({ type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "fake", runs: [kept("r1"), kept("r2")], dashboard: "http://dash/s" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  // Hold the stream response so drained can finish it. The listen helper ends nothing itself.
  const proxy = await startFaultProxy(upstream.url, {
    seed: 1,
    fault: ({ kind, path }) => {
      if (kind === "stream" || !path.endsWith("/outbound")) return "ok";
      const which = outbound++;
      if (which === 0) return "html503";
      if (which === 1) return "reset";
      if (which === 2) return "delay";
      return "ok";
    },
  });
  try {
    const summary = await runInCloud({
      cloud: proxy.url, name: "test", tools: [], files: [], log: () => {},
      build: () => ({
        channels: () => [], reacted: () => {},
        receive: (_id, _incoming, deliver, options) => {
          void deliver({ type: "message", text: `reply ${options?.messageId}` });
          return "m";
        },
      }),
    });
    assert.deepEqual(summary.runs.map((r) => r.runId), ["r1", "r2"]);
    const bodies = proxy.posts.filter((post) => post.path.endsWith("/outbound")).map((post) => JSON.parse(post.body).outbound.text as string);
    assert.deepEqual([...new Set(bodies)].sort(), ["reply m1", "reply m2"]);
    assert.equal(bodies.length, 2);
  } finally { proxy.close(); upstream.close(); }
});
