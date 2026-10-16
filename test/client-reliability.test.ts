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
const run = (runId: string, n = 1): Command => ({
  type: "run",
  run: {
    runId, scenario: "hello", run: n, channel: "sms", passed: true, checks: [], ended: "goal",
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
          if (lookup) void Promise.resolve(lookup.run({}, { conversationId: "c", person: "p", key: null, channel: "sms", callId: "c1", idempotencyKey: "k1", signal: new AbortController().signal })).then(() => {}, (error: unknown) => { timed = error; });
          return "m";
        },
      }),
    });
    assert.equal(summary.dashboard, "d");
    assert.ok(timed instanceof TimeoutError);
  } finally { cloud.close(); }
});

test("a tool call the cloud failed, which the agent started and never awaited, is that run's error and the session plays on", { timeout: 10_000 }, async () => {
  // An intercept that hands off with `void tool.run(...)` and answers at once: the cloud's
  // simulator_failed for that call used to crash the CLI as an unhandled rejection.
  const unhandled: unknown[] = [];
  let settled!: () => void;
  const gate = new Promise<void>((done) => { settled = done; });
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); settled(); };
  process.on("unhandledRejection", onUnhandled);
  const logs: string[] = [];
  const received: string[] = [];
  const say = (conversationId: string, messageId: string): Command => ({ type: "message", conversationId, messageId, channel: { reactions: false, status: false }, incoming: { text: "HUMAN" } });
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d" }));
    if (url.endsWith("/tool-calls")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "simulator_failed" }));
    if (url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame(say("sms:a", "m1")));
      // The rest of the session comes once the failed call has been dealt with, one way or the other.
      void gate.then(() => {
        res.write(frame(run("r1")));
        res.write(frame(say("sms:b", "m2")));
        res.write(frame(run("r2", 2)));
        res.end(frame({ type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "fake", runs: [], dashboard: "d" } }));
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const seen: string[] = [];
  try {
    await runInCloud({
      cloud: cloud.url, name: "test", files: [],
      log: (line) => { logs.push(line); if (/simulator_failed/.test(line)) settled(); },
      onRun: (r) => seen.push(r.runId),
      tools: [{ name: "handoff", description: "hand off", input: z.object({}), run: async () => null }],
      build: ({ tools }: { tools: Tool[] }) => ({
        channels: () => [], reacted: () => {},
        receive: (conversationId) => {
          received.push(conversationId);
          if (conversationId === "sms:a") void tools[0]!.run({}, { conversationId, person: "p", channel: "sms", key: null, callId: "c1", idempotencyKey: "k1", signal: new AbortController().signal });
          return null;
        },
      }),
    });
  } finally {
    process.off("unhandledRejection", onUnhandled);
    cloud.close();
  }
  assert.deepEqual(unhandled, [], "a call the cloud failed is never an unhandled rejection");
  assert.deepEqual(received, ["sms:a", "sms:b"], "the next run still plays");
  assert.deepEqual(seen, ["r1", "r2"]);
  assert.match(logs.join("\n"), /sms:a: the cloud failed the tool call handoff \(simulator_failed\)/);
});

test("on a cloud that does not resume, no bytes for the idle window means the stream is dead, and the run already in is kept",{ timeout: 10_000 }, async () => {
  let gets = 0;
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "http://dash/s" }));
    if (url.endsWith("/stream")) {
      gets++;
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
    assert.equal(gets, 1);
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
    assert.equal(JSON.parse(opened?.body ?? "{}").resume, true);
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

const numbered = (id: number, command: unknown) => `id: ${id}\n${frame(command)}`;
const finished = { type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "fake", runs: [], dashboard: "d" } };
const openedResuming = JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d", resume: true });

test("a dropped stream resumes after its last command, and a command sent again is not handled twice", { timeout: 10_000 }, async () => {
  const logs: string[] = [];
  const asked: unknown[] = [];
  const received: string[] = [];
  const streams: ServerResponse[] = [];
  const cloud = await listen(({ url, body }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(openedResuming);
    if (url.endsWith("/stream")) {
      asked.push(res.req.headers["last-event-id"]);
      streams.push(res);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (streams.length === 1) {
        res.write(numbered(1, message("m1")));
        res.write(numbered(2, message("m2")));
      } else {
        // The cloud sends 2 again: the client handled it on the first stream.
        res.write(numbered(2, message("m2")));
        res.write(numbered(3, message("m3")));
      }
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    if (url.endsWith("/receipts")) {
      const id = JSON.parse(body).messageId;
      if (id === "m2") streams[0]?.destroy();
      if (id === "m3") streams[1]?.end(numbered(4, finished));
    }
  });
  try {
    const summary = await runInCloud({
      cloud: cloud.url, name: "test", tools: [], files: [], log: (line) => logs.push(line),
      build: () => ({ channels: () => [], reacted: () => {}, receive: (_id, _incoming, _deliver, options) => { received.push(options?.messageId ?? ""); return "m"; } }),
    });
    assert.equal(summary.sessionId, "s");
    assert.deepEqual(asked, [undefined, "2"]);
    assert.deepEqual(received, ["m1", "m2", "m3"]);
    assert.equal(logs.filter((line) => line.startsWith("stream ")).length, 1);
    assert.match(logs.join("\n"), /stream lost \(.+\); resuming after command 2/);
  } finally { cloud.close(); }
});

test("a silent resumable stream is opened again instead of ending the session", { timeout: 10_000 }, async () => {
  const logs: string[] = [];
  const asked: unknown[] = [];
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(openedResuming);
    if (url.endsWith("/stream")) {
      asked.push(res.req.headers["last-event-id"]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (asked.length === 1) res.write(numbered(1, run("r1"))); // then nothing, not even a ping
      else res.end(numbered(2, finished));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    const summary = await runInCloud({
      cloud: cloud.url, name: "test", tools: [], files: [], log: (line) => logs.push(line), streamIdleMs: 200,
      build: () => ({ channels: () => [], receive: () => null, reacted: () => {} }),
    });
    assert.equal(summary.sessionId, "s");
    assert.deepEqual(asked, [undefined, "1"]);
    assert.match(logs.join("\n"), /stream lost \(no bytes for 0.2s\); resuming after command 1/);
  } finally { cloud.close(); }
});

test("a stream that cannot resume within the window stops the session with the runs already in", { timeout: 10_000 }, async () => {
  let gets = 0;
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(openedResuming);
    if (url.endsWith("/stream")) {
      gets++;
      if (gets > 1) return void res.writeHead(503, { "content-type": "text/html" }).end("<html>503 Server Error</html>");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(numbered(1, run("r1")));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    await assert.rejects(runInCloud({
      cloud: cloud.url, name: "test", tools: [], files: [], log: () => {}, resumeWindowMs: 600,
      build: () => ({ channels: () => [], receive: () => null, reacted: () => {} }),
    }), (error: unknown) => {
      assert.ok(error instanceof SessionStopped);
      assert.match(error.message, /the stream did not resume within 0.6s \(lost \(the cloud closed it\)\); last try: could not open the stream \(503\)/);
      assert.deepEqual(error.runs.map((r) => r.runId), ["r1"]);
      return true;
    });
    assert.ok(gets >= 2, `stream opened ${gets} times`);
  } finally { cloud.close(); }
});

test("a resumable stream is replaced before the tunnel's hour limit", { timeout: 10_000 }, async () => {
  const logs: string[] = [];
  const asked: unknown[] = [];
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(openedResuming);
    if (url.endsWith("/stream")) {
      asked.push(res.req.headers["last-event-id"]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (asked.length === 1) res.write(numbered(1, run("r1")));
      else res.end(numbered(2, finished));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    const summary = await runInCloud({
      cloud: cloud.url, name: "test", tools: [], files: [], log: (line) => logs.push(line), streamRefreshMs: 150,
      build: () => ({ channels: () => [], receive: () => null, reacted: () => {} }),
    });
    assert.equal(summary.sessionId, "s");
    assert.deepEqual(asked, [undefined, "1"]);
    assert.match(logs.join("\n"), /stream refreshed before the tunnel's hour limit; resuming after command 1/);
  } finally { cloud.close(); }
});

const hello = { path: "scenarios/hello.yaml", hash: "h", content: "id: hello\nchannels: [sms]\nperson:\n  persona: a\n  goal: b\nopening:\n  - say: hi\n" };
const summaryOf = (id: string, runs: Command[]) => ({ type: "finished", summary: { sessionId: id, suiteHash: "h", testModel: "fake", runs: runs.map((c) => c.type === "run" ? c.run : null), dashboard: `http://dash/${id}` } });

/** A cloud that loses its first session: the receipt of that session's message answers session_gone.
 * The second open plays run 2 and finishes, loses that session too, or is refused for the spend cap. */
function losingCloud(options: { reopen: boolean; second: "finish" | "gone" | "refused"; firstRuns?: number }) {
  const opens: Array<Record<string, unknown>> = [];
  return listen(({ url, body }, res) => {
    const reply = (status: number, value: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url === "/api/sessions") {
      opens.push(JSON.parse(body));
      const id = `s${opens.length}`;
      if (opens.length === 2 && options.second === "refused") return reply(429, { error: "spend_cap" });
      return reply(200, { sessionId: id, token: id, missing: [], dashboard: `http://dash/${id}`, ...(options.reopen ? { reopen: true } : {}) });
    }
    if (url.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (url.includes("/s1/")) {
        if (options.firstRuns !== 0) res.write(frame(run("r1", 1)));
        res.write(frame(message("m1")));
      } else if (options.second === "gone") {
        res.write(frame(run("r2", 2)));
        res.write(frame(message("m2")));
      } else {
        res.end(frame(run("r2", 2)) + frame(summaryOf("s2", [run("r2", 2)])));
      }
      return;
    }
    if (url.endsWith("/receipts")) return reply(410, { error: "session_gone" });
    reply(200, {});
  }).then((cloud) => ({ ...cloud, opens }));
}

test("a session the cloud lost is opened again once, for only the runs with no result, and the two reports merge", { timeout: 10_000 }, async () => {
  const logs: string[] = [];
  const cloud = await losingCloud({ reopen: true, second: "finish" });
  try {
    const summary = await runInCloud({
      cloud: cloud.url, name: "test", tools: [], files: [hello], runs: 2, log: (line) => logs.push(line),
      build: () => ({ channels: () => [], receive: () => "m", reacted: () => {} }),
    });
    assert.deepEqual(summary.runs.map((r) => [r.runId, r.run]), [["r1", 1], ["r2", 2]]);
    assert.deepEqual(summary.lost, { sessionId: "s1", dashboard: "http://dash/s1" });
    assert.equal(summary.dashboard, "http://dash/s2");
    assert.equal(cloud.opens[0]?.reopen, true);
    assert.equal(cloud.opens[0]?.only, undefined);
    assert.deepEqual(cloud.opens[1]?.only, [{ scenario: "hello", channel: "sms", run: 2 }]);
    assert.match(logs.join("\n"), /The cloud lost session s1 \(.*session_gone.*\)\. Opening a new session to play the 1 run with no result, at the cloud's cost again: hello on sms #2/);
  } finally { cloud.close(); }
});

test("a session lost before any run finished is opened again without only, so the cloud need not have its files stored", { timeout: 10_000 }, async () => {
  const cloud = await losingCloud({ reopen: true, second: "finish", firstRuns: 0 });
  try {
    const summary = await runInCloud({
      cloud: cloud.url, name: "test", tools: [], files: [hello], runs: 2, log: () => {},
      build: () => ({ channels: () => [], receive: () => "m", reacted: () => {} }),
    });
    assert.equal(cloud.opens.length, 2);
    assert.equal(cloud.opens[1]?.only, undefined);
    assert.equal(cloud.opens[1]?.reopen, true);
    assert.deepEqual(summary.lost, { sessionId: "s1", dashboard: "http://dash/s1" });
  } finally { cloud.close(); }
});

test("a lost session is opened again at most once, only on a cloud that says reopen, and stops if the new open is refused", { timeout: 10_000 }, async () => {
  const cases = [
    { reopen: true, second: "gone" as const, opens: 2, runs: ["r1", "r2"], reason: /session_gone/ },
    { reopen: true, second: "refused" as const, opens: 2, runs: ["r1"], reason: /the cloud lost the session, and a new one did not open: .*spend_cap/ },
    { reopen: false, second: "finish" as const, opens: 1, runs: ["r1"], reason: /session_gone/ },
  ];
  for (const item of cases) {
    const cloud = await losingCloud(item);
    try {
      await assert.rejects(runInCloud({
        cloud: cloud.url, name: "test", tools: [], files: [hello], runs: 2, log: () => {},
        build: () => ({ channels: () => [], receive: () => "m", reacted: () => {} }),
      }), (error: unknown) => {
        assert.ok(error instanceof SessionStopped, String(error));
        assert.match(error.message, item.reason);
        assert.deepEqual(error.runs.map((r) => r.runId), item.runs);
        return true;
      });
      assert.equal(cloud.opens.length, item.opens, JSON.stringify(item));
    } finally { cloud.close(); }
  }
});

test("a slow event upload is logged only when verbose", { timeout: 10_000 }, async () => {
  const cloud = await listen(({ url }, res) => {
    if (url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d" }));
    if (url.endsWith("/stream")) return void res.writeHead(200, { "content-type": "text/event-stream" }).end(frame({ type: "drain" }) + frame(finished));
    // An upload the cloud takes a second to answer is slow by the client's measure.
    if (url.endsWith("/events")) return void setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end("{}"), 1_000);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  try {
    for (const verbose of [false, true]) {
      const logs: string[] = [];
      await runInCloud({
        cloud: cloud.url, name: "test", tools: [], files: [], log: (line) => logs.push(line), verbose,
        build: ({ events }) => {
          events[0]!({ type: "turn.started", conversationId: "c", at: 0 } as never);
          return { channels: () => [], receive: () => "m", reacted: () => {} };
        },
      });
      assert.equal(logs.some((line) => line.startsWith("event upload slow")), verbose, logs.join("\n"));
    }
  } finally { cloud.close(); }
});

test("a busy cloud's refused open is sent once more after its Retry-After, only within the cap, and the second open's agent id is passed on", { timeout: 10_000 }, async () => {
  const busy = { "content-type": "application/json", "retry-after": "0" };
  const cases = [
    { refusals: [[503, { error: { type: "capacity", message: "All slots are busy." } }]], cap: 60_000, opens: 2, opened: true },
    { refusals: [[429, { error: { type: "rate_limited" } }], [429, { error: { type: "rate_limited" } }]], cap: 60_000, opens: 2, opened: false },
    { refusals: [[429, { error: { type: "rate_limited" } }]], cap: -1, opens: 1, opened: false },
  ] as const;
  for (const item of cases) {
    let opens = 0;
    const cloud = await listen(({ url }, res) => {
      if (url === "/api/sessions") {
        const refusal = item.refusals[opens++];
        if (refusal) return void res.writeHead(refusal[0], busy).end(JSON.stringify(refusal[1]));
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d", agent: "agt_1" }));
      }
      if (url.endsWith("/stream")) return void res.writeHead(200, { "content-type": "text/event-stream" }).end(frame(finished));
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const logs: string[] = [];
    let agent: string | undefined;
    try {
      const playing = runInCloud({
        cloud: cloud.url, name: "test", tools: [], files: [], log: (line) => logs.push(line), openRetryCapMs: item.cap,
        build: () => ({ channels: () => [], receive: () => "m", reacted: () => {} }),
        onDashboard: (_url, _id, id) => { agent = id; },
      });
      if (item.opened) {
        await playing;
        assert.equal(agent, "agt_1");
        assert.match(logs.join("\n"), /^The cloud is busy \(503 capacity\); trying once more in 0 s\.$/m);
      } else await assert.rejects(playing, /429/);
      assert.equal(opens, item.opens, JSON.stringify(item));
    } finally { cloud.close(); }
  }
});
