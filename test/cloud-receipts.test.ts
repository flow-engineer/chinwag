// covers: testing/src/client.ts testing/src/protocol.ts
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, type ChinwagEvent, type EventSink } from "../src/index.ts";
import { scriptedModel, respond, say } from "./helpers.ts";
import { runInCloud, SessionStopped, type AgentUnderTest } from "../testing/src/client.ts";
import type { Command, Receipt } from "../testing/src/protocol.ts";

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const message = (messageId: string): Command => ({ type: "message", conversationId: "c", messageId, incoming: { text: "hi" }, channel: { reactions: false, status: false } });
const frame = (command: Command | { type: "finished"; summary: { runs: never[] } }) => `data: ${JSON.stringify(command)}\n\n`;
const ok = (res: ServerResponse) => res.writeHead(200, { "content-type": "application/json" }).end("{}");

async function tunnel(handler: (path: string, body: string, res: ServerResponse) => void) {
  const connected = gate<ServerResponse>();
  const closed = gate();
  let stream: ServerResponse | undefined;
  let capability: unknown;
  let finished = false;
  const latePosts: string[] = [];
  const posts: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url === "/api/sessions") {
        capability = JSON.parse(body).deliveryReceipts;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d" }));
      } else if (req.url!.endsWith("/stream")) {
        stream = res;
        res.on("close", () => closed.resolve());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        connected.resolve(res);
      } else {
        posts.push(req.url!);
        if (finished) {
          latePosts.push(req.url!);
          res.writeHead(410).end('{"error":"session_closed"}');
        } else if (req.url!.endsWith("/drained")) {
          ok(res);
          finished = true;
          stream!.write(frame({ type: "finished", summary: { runs: [] } }));
        } else handler(req.url!, body, res);
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    cloud: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connected: connected.promise, closed: closed.promise,
    capability: () => capability,
    posts, latePosts,
    finish: () => stream!.write(frame({ type: "drain" })),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

test("receipts bypass a blocked event upload; intercepted waits for all outbound bodies, silence acknowledges independently", { timeout: 10_000 }, async () => {
  const upload = gate<ServerResponse>();
  const outbounds = gate<ServerResponse[]>();
  const receipts = gate();
  const seen: Receipt[] = [];
  const responses: ServerResponse[] = [];
  const uploaded: unknown[] = [];
  let emit!: EventSink;
  const cloud = await tunnel((path, body, res) => {
    if (path.endsWith("/events")) {
      uploaded.push(...JSON.parse(body).events);
      if (uploaded.length === 1) upload.resolve(res);
      else ok(res);
    }
    else if (path.endsWith("/outbound")) {
      // A success header is not enough: the entire response body must be consumed.
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      responses.push(res);
      if (responses.length === 2) outbounds.resolve(responses);
    } else {
      seen.push(JSON.parse(body));
      ok(res);
      if (seen.length === 2) receipts.resolve();
    }
  });
  try {
    const running = runInCloud({ cloud: cloud.cloud, name: "test", tools: [], files: [], log: () => {}, build: ({ events }) => {
      emit = events[0];
      events[0]({ type: "turn.end", conversationId: "c", at: 1, data: {} });
      return { channels: () => [], reacted: () => {}, receive: (_id, _incoming, deliver, options) => {
        if (options?.messageId === "intercept") {
          void deliver({ type: "message", text: "one" });
          void deliver({ type: "message", text: "two" });
          return null;
        }
        return options?.messageId === "silent" ? null : "local-id";
      } };
    } });
    const stream = await cloud.connected;
    const eventResponse = await upload.promise;
    emit({ type: "turn.start", conversationId: "c", at: 2, data: {} });
    emit({ type: "turn.end", conversationId: "c", at: 3, data: {} });
    stream.write([message("intercept"), message("taken"), message("silent")].map(frame).join(""));
    const replies = await outbounds.promise;
    await receipts.promise;
    assert.equal(cloud.capability(), true);
    assert.deepEqual([...seen].sort((a, b) => a.messageId.localeCompare(b.messageId)), [
      { conversationId: "c", messageId: "silent", status: "intercepted" },
      { conversationId: "c", messageId: "taken", status: "taken" },
    ]);
    // Drain arrives with receipts, response bodies and event uploads still outstanding.
    cloud.finish();
    replies[0].end("}");
    replies[1].end("}");
    ok(eventResponse);
    assert.deepEqual(await running, { runs: [] });
    assert.deepEqual(seen[2], { conversationId: "c", messageId: "intercept", status: "intercepted" });
    assert.equal(uploaded.length, 3);
    assert.deepEqual(cloud.latePosts, []);
    assert.ok(cloud.posts.at(-1)!.endsWith("/drained"));
    await cloud.closed; // finished does not leave the SSE socket open
  } finally { cloud.close(); }
});

test("drained authentication failure rejects explicitly and cleans up the stream", { timeout: 10_000 }, async () => {
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === "/api/sessions") return void res.end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d" }));
    if (req.url!.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame({ type: "drain" }));
    } else res.writeHead(401).end('{"error":"unauthorized"}');
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    await assert.rejects(runInCloud({ cloud: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, name: "test", tools: [], files: [], log: () => {}, build: () => ({ channels: () => [], receive: () => null, reacted: () => {} }) }), /drained: 401/);
  } finally { server.closeAllConnections(); server.close(); }
});

test("platform_refused reaches the real agent's recovery loop; message.in carries the command ID before turn.end and final drain", { timeout: 10_000 }, async () => {
  const scripted = scriptedModel();
  const ended = gate();
  const received: ChinwagEvent[] = [];
  const outbound: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "chinwag-receipts-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const cloud = await tunnel((path, body, res) => {
    if (path.endsWith("/outbound")) {
      const reply = JSON.parse(body).outbound;
      if (reply.type === "message") {
        outbound.push(reply.text);
        if (outbound.length === 1) return void res.writeHead(409).end('{"error":"platform_refused"}');
      }
    }
    if (path.endsWith("/events")) received.push(...JSON.parse(body).events);
    ok(res);
  });
  try {
    const running = runInCloud({ cloud: cloud.cloud, name: "test", tools: [], files: [], log: () => {}, build: ({ events }) => createAgent({
      dir, model: scripted.model, debounceMs: 0, scheduleCheckMs: 0,
      events: [...events, (event) => { if (event.type === "turn.end") ended.resolve(); }],
    }) });
    (await cloud.connected).write(frame(message("cloud-command-42")));
    (await scripted.nextCall(0)).answer(respond(say("refused")));
    const recovery = await scripted.nextCall(1);
    assert.match(JSON.stringify(recovery.request.messages), /platform_refused/);
    recovery.answer(respond(say("recovered")));
    await ended.promise;
    cloud.finish();
    await running;
    assert.deepEqual(outbound, ["refused", "recovered"]);
    const incoming = received.findIndex((event) => event.type === "message.in");
    const completion = received.findIndex((event) => event.type === "turn.end");
    assert.equal(received[incoming].messageId, "cloud-command-42");
    assert.ok(incoming >= 0 && completion > incoming);
    assert.deepEqual(cloud.latePosts, []);
    assert.ok(cloud.posts.at(-1)!.endsWith("/drained"));
  } finally { cloud.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a fire-and-forget interceptor platform refusal rejects explicitly without an intercepted receipt", { timeout: 10_000 }, async () => {
  let receiptPosts = 0;
  const cloud = await tunnel((path, _body, res) => {
    if (path.endsWith("/receipts")) receiptPosts++;
    res.writeHead(409).end('{"error":"platform_refused"}');
  });
  try {
    const running = runInCloud({ cloud: cloud.cloud, name: "test", tools: [], files: [], log: () => {}, build: () => ({
      channels: () => [], reacted: () => {}, receive: (_id, _incoming, deliver) => { void deliver({ type: "message", text: "fixed" }); return null; },
    }) });
    const rejected = assert.rejects(running, /delivery receipt:.*platform_refused/);
    (await cloud.connected).write(frame(message("intercept")));
    await rejected;
    await cloud.closed;
    assert.equal(receiptPosts, 0);
  } finally { cloud.close(); }
});

test("a premature stream close rejects rather than returning a quiet result", { timeout: 10_000 }, async () => {
  const cloud = await tunnel((_path, _body, res) => ok(res));
  try {
    const running = runInCloud({ cloud: cloud.cloud, name: "test", tools: [], files: [], log: () => {}, build: () => ({ channels: () => [], receive: () => null, reacted: () => {} }) });
    const rejected = assert.rejects(running, /closed the stream before the session finished/);
    (await cloud.connected).end();
    await rejected;
    await cloud.closed;
  } finally { cloud.close(); }
});

test("an event backlog is byte/count bounded and retains lifecycle order", { timeout: 10_000 }, async () => {
  const batches: Array<{ bytes: number; events: Array<{ type: string; data: { index: number } }> }> = [];
  const cloud = await tunnel((path, body, res) => {
    assert.ok(path.endsWith("/events"));
    batches.push({ bytes: Buffer.byteLength(body), events: JSON.parse(body).events });
    ok(res);
  });
  try {
    const running = runInCloud({ cloud: cloud.cloud, name: "test", tools: [], files: [], log: () => {}, build: ({ events }) => {
      for (let index = 0; index < 1200; index++) events[0]({ type: index % 2 ? "turn.end" : "turn.start", conversationId: "c", at: index, data: { index, text: index < 700 ? "界".repeat(5000) : "small" } });
      return { channels: () => [], receive: () => null, reacted: () => {} };
    } });
    await cloud.connected;
    cloud.finish();
    await running;
    assert.ok(batches.length >= 4);
    for (const batch of batches) { assert.ok(batch.bytes <= 5_000_000); assert.ok(batch.events.length <= 500); }
    assert.deepEqual(batches.flatMap((batch) => batch.events.map((event) => event.data.index)), Array.from({ length: 1200 }, (_, i) => i));
  } finally { cloud.close(); }
});

for (const kind of ["receipt", "events", "oversized"] as const) {
  test(`${kind} failure rejects explicitly, closes the stream and never retries ambiguous events`, { timeout: 10_000 }, async () => {
    const logs: string[] = [];
    let eventPosts = 0;
    let receiptPosts = 0;
    let emit!: EventSink;
    const cloud = await tunnel((path, _body, res) => {
      if (path.endsWith("/events")) eventPosts++;
      if (path.endsWith("/receipts")) receiptPosts++;
      res.writeHead(503).end("private response content");
    });
    try {
      const running = runInCloud({ cloud: cloud.cloud, name: "test", tools: [], files: [], log: (line) => logs.push(line), build: ({ events }) => {
        emit = events[0];
        return { channels: () => [], reacted: () => {}, receive: () => "m" } satisfies AgentUnderTest;
      } });
      // Attach the rejection assertion before triggering any fire-and-forget work.
      const rejected = assert.rejects(running, kind === "events" ? /event upload failed/ : kind === "oversized" ? /5MB/ : /delivery receipt/);
      const stream = await cloud.connected;
      if (kind === "events" || kind === "oversized") {
        emit({ type: "turn.end", conversationId: "c", at: 1, data: { text: kind === "oversized" ? "x".repeat(5_000_000) : "private event content" } });
        cloud.finish();
      } else stream.write(frame(message("m1")));
      await rejected;
      await cloud.closed;
      if (kind === "events") {
        assert.equal(eventPosts, 1);
        const diagnostic = logs.find((line) => line.startsWith("event upload failed:"));
        assert.match(diagnostic!, /roundtrip_ms=\d+ count=1 bytes=\d+ queue_wait_ms=\d+/);
        assert.ok(!diagnostic!.includes("private"));
      }
      if (kind === "oversized") assert.equal(eventPosts, 0);
    } finally { cloud.close(); }
  });
}

test("a 503 from the tunnel frontend is tried again, and the suite still finishes", { timeout: 10_000 }, async () => {
  const logs: string[] = [];
  let outbound = 0;
  const cloud = await tunnel((path, _body, res) => {
    if (!path.endsWith("/outbound")) return ok(res);
    outbound++;
    if (outbound === 1) return void res.writeHead(503).end("<html><title>503 Server Error</title><h1>Error: Server Error</h1>Service error -27.</html>");
    ok(res);
  });
  try {
    const running = runInCloud({ cloud: cloud.cloud, name: "test", tools: [], files: [], log: (line) => logs.push(line), build: () => ({
      channels: () => [], reacted: () => {}, receive: (_id, _incoming, deliver) => {
        void deliver({ type: "message", text: "reply" });
        return "m";
      },
    }) });
    const stream = await cloud.connected;
    stream.write(frame(message("m1")));
    cloud.finish();
    assert.deepEqual(await running, { runs: [] });
    assert.equal(outbound, 2);
    assert.match(logs.join("\n"), /outbound delivery unavailable \(503\), trying again/);
    assert.ok(!logs.join("\n").includes("Server Error"));
  } finally { cloud.close(); }
});

test("an outbound the tunnel keeps refusing does not discard the rest of the session", { timeout: 10_000 }, async () => {
  let outbound = 0;
  const cloud = await tunnel((path, _body, res) => {
    if (path.endsWith("/outbound")) {
      outbound++;
      return void res.writeHead(503).end("<html><h1>Error: Server Error</h1></html>");
    }
    ok(res);
  });
  try {
    const running = runInCloud({ cloud: cloud.cloud, name: "test", tools: [], files: [], log: () => {}, build: () => ({
      channels: () => [], reacted: () => {}, receive: (_id, _incoming, deliver) => {
        void deliver({ type: "message", text: "reply" });
        return null;
      },
    }) });
    const stream = await cloud.connected;
    stream.write(frame(message("m1")));
    cloud.finish();
    assert.deepEqual(await running, { runs: [] });
    assert.equal(outbound, 3);
    assert.ok(!cloud.posts.some((path) => path.endsWith("/receipts")), "a reply the tunnel never took is not acknowledged");
  } finally { cloud.close(); }
});

test("a JSON refusal on outbound ends the session", { timeout: 10_000 }, async () => {
  const cloud = await tunnel((path, _body, res) => {
    if (path.endsWith("/outbound")) return void res.writeHead(400).end('{"error":"invalid_request"}');
    ok(res);
  });
  try {
    const running = runInCloud({ cloud: cloud.cloud, name: "test", tools: [], files: [], log: () => {}, build: () => ({
      channels: () => [], reacted: () => {}, receive: (_id, _incoming, deliver) => {
        void deliver({ type: "message", text: "reply" });
        return "m";
      },
    }) });
    const stream = await cloud.connected;
    stream.write(frame(message("m1")));
    await assert.rejects(running, (error: unknown) => {
      assert.ok(!(error instanceof SessionStopped));
      assert.match((error as Error).message, /invalid_request/);
      return true;
    });
  } finally { cloud.close(); }
});

test("an outbound timeout is not sent again", { timeout: 10_000 }, async () => {
  const logs: string[] = [];
  let outbound = 0;
  const cloud = await tunnel((path, _body, res) => {
    if (path.endsWith("/outbound")) { outbound++; return; }
    ok(res);
  });
  try {
    const running = runInCloud({ cloud: cloud.cloud, name: "test", tools: [], files: [], log: (line) => logs.push(line), postTimeoutMs: 120, build: () => ({
      channels: () => [], reacted: () => {}, receive: (_id, _incoming, deliver) => {
        void deliver({ type: "message", text: "reply" });
        return "m";
      },
    }) });
    const stream = await cloud.connected;
    stream.write(frame(message("m1")));
    cloud.finish();
    assert.deepEqual(await running, { runs: [] });
    assert.equal(outbound, 1);
    assert.match(logs.join("\n"), /outbound delivery failed \(timed out\)/);
    assert.ok(!logs.join("\n").includes("trying again"));
  } finally { cloud.close(); }
});
