// covers: testing/src/client.ts test/fault-proxy.ts
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z, type Tool } from "../src/index.ts";
import { CLOUD_MODEL_BUDGET_MS, postBudgetMs, RETRY_BUDGET_MS, runInCloud, SessionStopped, TimeoutError, toolTimeoutMs } from "../testing/src/client.ts";
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
  assert.equal(CLOUD_MODEL_BUDGET_MS, 210_000);
  assert.equal(RETRY_BUDGET_MS, 30_000);
  assert.equal(toolTimeoutMs([{ path: "tools/lookup.yaml", hash: "h", content: slow }], "lookup"), 11_000 + CLOUD_MODEL_BUDGET_MS);
  assert.equal(toolTimeoutMs([], "lookup"), 60_000 + CLOUD_MODEL_BUDGET_MS);
  assert.equal(postBudgetMs(30_000, 5_000_000), 80_000);
  assert.equal(postBudgetMs(30_000, 99_999), 30_000);
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
          if (lookup) void Promise.resolve(lookup.run({}, { conversationId: "c", person: "p", channel: "sms", callId: "c1", idempotencyKey: "k1", signal: new AbortController().signal })).then(() => {}, (error: unknown) => { timed = error; });
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
      // A reset is not tried again: the cloud may already have the reply. Only the HTML 503 is.
      if (which === 0 || which === 2) return "html503";
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

test("a drain waits out work longer than the idle window", { timeout: 10_000 }, async () => {
  let stream: ServerResponse | undefined;
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "http://dash/s" }));
    if (url.endsWith("/stream")) {
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(message("m1")));
      res.write(frame({ type: "drain" }));
      return;
    }
    if (url.endsWith("/outbound")) {
      setTimeout(() => {
        stream?.write(": ping\n\n");
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      }, 250);
      return;
    }
    if (url.endsWith("/drained")) {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      stream?.end(frame({ type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "fake", runs: [], dashboard: "http://dash/s" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    const summary = await runInCloud({
      cloud: cloud.url, name: "test", tools: [], files: [], log: () => {}, streamIdleMs: 80,
      build: () => ({
        channels: () => [], reacted: () => {},
        receive: (_id, _incoming, deliver) => {
          void deliver({ type: "message", text: "held" });
          return "m";
        },
      }),
    });
    assert.equal(summary.sessionId, "s");
  } finally { cloud.close(); }
});

test("a reset after the outbound was forwarded is not sent again", { timeout: 10_000 }, async () => {
  const logs: string[] = [];
  let stream: ServerResponse | undefined;
  const upstream = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "http://dash/s" }));
    if (url.endsWith("/stream")) {
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(message("m1")));
      res.write(frame(run("r1")));
      res.write(frame({ type: "drain" }));
      return;
    }
    if (url.endsWith("/drained")) {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      const command = run("r1");
      const one = command.type === "run" ? [command.run] : [];
      stream?.end(frame({ type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "fake", runs: one, dashboard: "http://dash/s" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const proxy = await startFaultProxy(upstream.url, {
    seed: 1,
    fault: ({ path }) => path.endsWith("/outbound") ? "resetAfter" : "ok",
  });
  try {
    const summary = await runInCloud({
      cloud: proxy.url, name: "test", tools: [], files: [], log: (line) => logs.push(line),
      build: () => ({
        channels: () => [], reacted: () => {},
        receive: (_id, _incoming, deliver) => {
          void deliver({ type: "message", text: "once" });
          return "m";
        },
      }),
    });
    assert.deepEqual(summary.runs.map((r) => r.runId), ["r1"]);
    const bodies = proxy.posts.filter((post) => post.path.endsWith("/outbound"));
    assert.equal(bodies.length, 1);
    assert.equal(JSON.parse(bodies[0]!.body).outbound.text, "once");
    assert.ok(!logs.join("\n").includes("trying again"));
    assert.match(logs.join("\n"), /outbound delivery failed \(no response\)/);
  } finally { proxy.close(); upstream.close(); }
});

test("seed 1 with mixed faults reports every run once and delivers no reply twice", { timeout: 10_000 }, async () => {
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
  const proxy = await startFaultProxy(upstream.url, {
    seed: 1,
    fault: ({ kind, path, index }) => {
      const rolled = rollFault(1, index, kind === "stream" ? "stream" : "post");
      // A cut stream, or a 503 on a call that is not retried, still ends the session.
      // A reset on outbound can mean the reply already landed, so it is left through.
      if (kind === "stream") return "ok";
      if (path.endsWith("/outbound")) return rolled === "reset" ? "ok" : rolled;
      return rolled === "html503" || rolled === "reset" ? "ok" : rolled;
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
    assert.ok(proxy.faults.includes("html503"));
    const bodies = proxy.posts.filter((post) => post.path.endsWith("/outbound")).map((post) => JSON.parse(post.body).outbound.text as string);
    for (const text of ["reply m1", "reply m2"]) assert.ok(bodies.filter((body) => body === text).length <= 1, text);
  } finally { proxy.close(); upstream.close(); }
});

test("a large upload outlives the base POST budget", { timeout: 10_000 }, async () => {
  const content = "x".repeat(100_000);
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: ["h"], dashboard: "d" }));
    if (url === "/api/files") return void setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), 200);
    if (url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(frame({ type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "fake", runs: [], dashboard: "d" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    const summary = await runInCloud({
      cloud: cloud.url, name: "test", tools: [], files: [{ path: "scenarios/a.yaml", hash: "h", content }],
      log: () => {}, postTimeoutMs: 80,
      build: () => ({ channels: () => [], receive: () => null, reacted: () => {} }),
    });
    assert.equal(summary.sessionId, "s");
  } finally { cloud.close(); }
});

test("three receives in a row that throw stop the session", { timeout: 10_000 }, async () => {
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d" }));
    if (url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(message("a")));
      res.write(frame(message("b")));
      res.write(frame(message("c")));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    await assert.rejects(runInCloud({
      cloud: cloud.url, name: "test", tools: [], files: [], log: () => {},
      build: () => ({ channels: () => [], reacted: () => {}, receive: () => { throw new Error("nope"); } }),
    }), (error: unknown) => {
      assert.ok(!(error instanceof SessionStopped));
      assert.match((error as Error).message, /the agent throws on every message: nope/);
      return true;
    });
  } finally { cloud.close(); }
});

test("finished posts do not keep their abort listeners", { timeout: 10_000 }, async () => {
  const proto = AbortSignal.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  let live = 0;
  let peak = 0;
  proto.addEventListener = function (this: AbortSignal, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
    if (type === "abort") peak = Math.max(peak, ++live);
    return add.call(this, type, listener, options);
  } as typeof add;
  proto.removeEventListener = function (this: AbortSignal, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
    if (type === "abort") live--;
    return remove.call(this, type, listener, options);
  } as typeof remove;
  let later = 0;
  let receipts = 0;
  let stream: ServerResponse | undefined;
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d" }));
    if (url.endsWith("/stream")) {
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      setTimeout(() => res.write(frame(message("m1"))), 30);
      return;
    }
    if (url.endsWith("/receipts")) {
      receipts++;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      if (receipts < 12) stream?.write(frame(message(`m${receipts}`)));
      else setTimeout(() => {
        later = live;
        stream?.end(frame({ type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "fake", runs: [], dashboard: "d" } }));
      }, 30);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    await runInCloud({
      cloud: cloud.url, name: "test", tools: [], files: [], log: () => {},
      build: () => ({ channels: () => [], receive: () => "m", reacted: () => {} }),
    });
    assert.equal(later, 0);
    assert.ok(peak > 0 && peak < 5, `peak abort listeners ${peak}`);
  } finally {
    proto.addEventListener = add;
    proto.removeEventListener = remove;
    cloud.close();
  }
});

test("a cloud that stores keys retries a 503 on events, receipts and outbound, and a reset after forward once", { timeout: 10_000 }, async () => {
  const applied: string[] = [];
  const seen = new Set<string>();
  let stream: ServerResponse | undefined;
  const upstream = await listen(({ url }, res) => {
    const key = res.req.headers["idempotency-key"];
    const idem = typeof key === "string" ? key : "";
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "http://dash/s", idempotency: true }));
    if (url.endsWith("/stream")) {
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(message("m1")));
      res.write(frame(message("m2")));
      setTimeout(() => {
        res.write(frame(run("r1")));
        res.write(frame(run("r2")));
        res.write(frame({ type: "drain" }));
      }, 1500);
      return;
    }
    if (url.endsWith("/drained")) {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      const kept = (id: string) => { const command = run(id); if (command.type !== "run") throw new Error("run"); return command.run; };
      stream?.end(frame({ type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "fake", runs: [kept("r1"), kept("r2")], dashboard: "http://dash/s" } }));
      return;
    }
    if (!seen.has(idem)) {
      seen.add(idem);
      applied.push(idem);
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const counts = new Map<string, number>();
  const proxy = await startFaultProxy(upstream.url, {
    seed: 1,
    fault: ({ kind, path }) => {
      if (kind === "stream") return "ok";
      if (!path.endsWith("/events") && !path.endsWith("/receipts") && !path.endsWith("/outbound")) return "ok";
      const n = counts.get(path) ?? 0;
      counts.set(path, n + 1);
      if (n === 0) return "html503";
      if (path.endsWith("/outbound") && n === 1) return "resetAfter";
      return "ok";
    },
  });
  try {
    const summary = await runInCloud({
      cloud: proxy.url, name: "test", tools: [], files: [], log: () => {}, retryBudgetMs: 5_000,
      build: ({ events }) => ({
        channels: () => [], reacted: () => {},
        receive: (_id, _incoming, deliver, options) => {
          events[0]?.({ type: "turn.end", conversationId: "c", at: 1, data: { messageId: options?.messageId } });
          void deliver({ type: "message", text: `reply ${options?.messageId}` });
          return "m";
        },
      }),
    });
    assert.deepEqual(summary.runs.map((item) => item.runId), ["r1", "r2"]);
    const opened = proxy.posts.find((post) => post.path === "/api/sessions");
    assert.equal(JSON.parse(opened?.body ?? "{}").retries, true);
    const outboundKeys = applied.filter((key) => key.startsWith("outbound:")).sort();
    assert.deepEqual(outboundKeys, ["outbound:c:m1:0", "outbound:c:m2:0"]);
    assert.ok(applied.some((key) => key.startsWith("events:")));
    assert.ok(applied.some((key) => key.startsWith("receipt:")));
  } finally { proxy.close(); upstream.close(); }
});

test("with keys, an outbound timeout longer than the retry budget is sent again with its key; a JSON refusal is not", { timeout: 10_000 }, async () => {
  const keys: unknown[] = [];
  let refused = 0;
  let stream: ServerResponse | undefined;
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d", idempotency: true }));
    if (url.endsWith("/stream")) {
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(message("m1")));
      res.write(frame({ type: "drain" }));
      return;
    }
    if (url.endsWith("/outbound")) {
      keys.push(res.req.headers["idempotency-key"]);
      if (keys.length === 1) return;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (url.endsWith("/drained")) {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      stream?.end(frame({ type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "fake", runs: [], dashboard: "d" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    const summary = await runInCloud({
      // The first try sits its whole 400ms, longer than the 300ms budget; the budget starts at that failure.
      cloud: cloud.url, name: "test", tools: [], files: [], log: () => {}, postTimeoutMs: 400, retryBudgetMs: 300,
      build: () => ({
        channels: () => [], reacted: () => {},
        receive: (_id, _incoming, deliver) => { void deliver({ type: "message", text: "again" }); return "m"; },
      }),
    });
    assert.equal(summary.sessionId, "s");
    assert.deepEqual(keys, ["outbound:c:m1:0", "outbound:c:m1:0"]);
  } finally { cloud.close(); }

  const refusing = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d", idempotency: true }));
    if (url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(message("m1")));
      return;
    }
    if (url.endsWith("/outbound")) {
      refused++;
      res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid_request"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    await assert.rejects(runInCloud({
      cloud: refusing.url, name: "test", tools: [], files: [], log: () => {},
      build: () => ({
        channels: () => [], reacted: () => {},
        receive: (_id, _incoming, deliver) => { void deliver({ type: "message", text: "no" }); return "m"; },
      }),
    }), (error: unknown) => {
      assert.ok(!(error instanceof SessionStopped));
      assert.match((error as Error).message, /invalid_request/);
      return true;
    });
    assert.equal(refused, 1);
  } finally { refusing.close(); }
});
