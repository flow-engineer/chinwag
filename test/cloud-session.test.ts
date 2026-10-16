// covers: testing/src/client.ts testing/src/protocol.ts
// The CLI against a hosted cloud: the open carries the CI key and the synthetic attestation, and the
// session is played at the tunnel the open answers, which never sees the key; the agent's posts reach
// the cloud while the stream is open, also over HTTPS with HTTP/2 as a hosted cloud speaks it, and a
// tool call the cloud has not answered does not hold the later ones.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createSecureServer, type Http2ServerResponse, type Http2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { z } from "zod";
import { cloudHeaders, runInCloud, tunnelBase } from "../testing/src/client.ts";
import type { Agent, Incoming } from "../src/index.ts";

test("a hosted cloud needs the CI key and --synthetic; a local one needs neither", () => {
  const hosted = "https://tests.example.com";
  assert.deepEqual(cloudHeaders({ cloud: "http://127.0.0.1:8900", synthetic: false }), {});
  assert.throws(() => cloudHeaders({ cloud: hosted, synthetic: true }), /CHINWAG_CLOUD_KEY/);
  assert.throws(() => cloudHeaders({ cloud: hosted, ciKey: "oci_x", synthetic: false }), /--synthetic/);
  assert.throws(() => cloudHeaders({ cloud: "http://localhost:8900", ciKey: "oci_x", synthetic: false }), /--synthetic/);
  assert.throws(() => cloudHeaders({ cloud: hosted, ciKey: "oci_x", synthetic: true, environment: "dev" }), /staging or production/);
  assert.throws(() => cloudHeaders({ cloud: hosted, ciKey: "oci_x", synthetic: true, ref: "x".repeat(101) }), /--ref/);
  assert.deepEqual(cloudHeaders({ cloud: hosted, ciKey: "oci_x", synthetic: true, agentVersion: "a1f9c2e", ref: "main", environment: "staging" }), {
    authorization: "Bearer oci_x",
    "x-chinwag-synthetic": "true",
    "x-chinwag-agent-version": "a1f9c2e",
    "x-chinwag-ref": "main",
    "x-chinwag-environment": "staging",
  });
});

test("the session is played at Opened.tunnel, else at the open's address", () => {
  assert.equal(tunnelBase("http://127.0.0.1:8900/", {}), "http://127.0.0.1:8900");
  assert.equal(tunnelBase("http://127.0.0.1:8900", { tunnel: "" }), "http://127.0.0.1:8900");
  assert.equal(tunnelBase("https://tests.example.com", { tunnel: "https://tunnel.example.run.app/t/" }), "https://tunnel.example.run.app/t");
  assert.throws(() => tunnelBase("https://tests.example.com", { tunnel: "ftp://tunnel.example" }), /http\(s\)/);
  assert.throws(() => tunnelBase("https://tests.example.com", { tunnel: "https://user@tunnel.example" }), /http\(s\)/);
});

test("the key goes to the front door only; the files and the stream go to the tunnel", async () => {
  const seen: Array<{ server: string; path: string; headers: IncomingHttpHeaders }> = [];
  const listen = (server: Server) => new Promise<string>((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  const tunnel = createServer((req, res) => {
    seen.push({ server: "tunnel", path: req.url!, headers: req.headers });
    req.resume();
    if (req.url!.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ type: "finished", summary: { runs: [] } })}\n\n`);
    } else res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  const tunnelUrl = await listen(tunnel);
  const door = createServer((req, res) => {
    seen.push({ server: "door", path: req.url!, headers: req.headers });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ sessionId: "ses_1", token: "tok", missing: ["h1"], dashboard: "d", tunnel: `${tunnelUrl}/t` }));
  });
  const doorUrl = await listen(door);
  try {
    const summary = await runInCloud({
      cloud: doorUrl,
      name: "cafe",
      tools: [],
      build: () => ({ channels: () => [] }) as unknown as Agent,
      files: [{ path: "scenarios/a.yaml", hash: "h1", content: "" }],
      openHeaders: { authorization: "Bearer oci_secret", "x-chinwag-synthetic": "true" },
      log: () => {},
    });
    assert.deepEqual(summary, { runs: [] });
  } finally {
    tunnel.close();
    door.close();
  }
  assert.deepEqual(seen.map((s) => `${s.server} ${s.path}`), ["door /api/sessions", "tunnel /t/api/files", "tunnel /t/api/sessions/ses_1/stream"]);
  assert.equal(seen[0].headers.authorization, "Bearer oci_secret");
  assert.equal(seen[0].headers["x-chinwag-synthetic"], "true");
  for (const s of seen.slice(1)) {
    assert.equal(s.headers.authorization, "Bearer tok");
    assert.equal(s.headers["x-chinwag-synthetic"], undefined);
  }
});

test("a file a scenario attaches is read from the tests folder on this machine, and from nowhere else", async () => {
  const testsDir = mkdtempSync(join(tmpdir(), "chinwag-tests-"));
  mkdirSync(join(testsDir, "fixtures"));
  writeFileSync(join(testsDir, "fixtures", "receipt.png"), new Uint8Array([1, 2, 3]));
  const incoming = { conversationId: "c", messageId: "m1", channel: { reactions: false, status: false }, incoming: { text: "my receipt", attachments: [{ kind: "image", file: "fixtures/receipt.png" }, { kind: "document", file: "../../etc/passwd" }] } };
  const server = createServer((req, res) => {
    req.resume();
    if (!req.url!.endsWith("/stream")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d" }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([{ type: "message", ...incoming }, { type: "finished", summary: { runs: [] } }].map((c) => `data: ${JSON.stringify(c)}\n\n`).join(""));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const got: Incoming[] = [];
  try {
    await runInCloud({
      cloud: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      name: "cafe",
      tools: [],
      build: () => ({ channels: () => [], receive: (_id: string, message: Incoming) => (got.push(message), "m1") }) as unknown as Agent,
      files: [],
      testsDir,
      log: () => {},
    });
  } finally {
    server.close();
  }
  const [photo, outside] = got[0].attachments!;
  assert.deepEqual({ kind: photo.kind, mime: photo.mime, name: photo.name }, { kind: "image", mime: "image/png", name: "receipt.png" });
  assert.deepEqual(await photo.data(), new Uint8Array([1, 2, 3]));
  await assert.rejects(outside.data(), /not a file in the tests folder/);
});

test("a late session_closed drops the leftover events instead of failing the run", async () => {
  const logs: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d" }));
      if (req.url === "/api/sessions/s/events") return void res.writeHead(409, { "content-type": "application/json" }).end('{"error":"session_closed"}');
      if (req.url === "/api/sessions/s/outbound") {
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (req.url === "/api/sessions/s/receipts") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "message", conversationId: "c", messageId: "m1", channel: { reactions: false, status: false }, incoming: { text: "hi" } })}\n\n`);
      res.end(`data: ${JSON.stringify({ type: "finished", summary: { runs: [] } })}\n\n`);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const summary = await runInCloud({
      cloud: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      name: "cafe",
      tools: [],
      build: ({ events }) => ({
        channels: () => [],
        receive: (id: string, _message: Incoming, deliver: (o: unknown) => Promise<void>) => {
          events[0]({ type: "turn.start", conversationId: id, at: 1 });
          void deliver({ type: "message", text: "hello" });
          return "m1";
        },
      }) as unknown as Agent,
      files: [],
      log: (line) => logs.push(line),
    });
    assert.deepEqual(summary, { runs: [] });
  } finally {
    server.close();
  }
  assert.match(logs.join("\n"), /session already finished, dropped \d+ events/);
});

test("the agent's posts reach the cloud while the stream is open, over HTTPS with HTTP/2", { timeout: 10_000 }, async (t) => {
  // A hosted cloud speaks HTTP/2, and fetch multiplexes onto one connection per origin: a POST
  // behind the open stream was held until the stream closed, so the cloud heard nothing (agent_quiet).
  const { key, cert } = httpsCert;
  const outbound: unknown[] = [];
  let stream: Http2ServerResponse | undefined;
  const server = createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d" }));
      if (req.url === "/api/sessions/s/outbound") {
        outbound.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return void stream!.end(`data: ${JSON.stringify({ type: "finished", summary: { runs: [] } })}\n\n`);
      }
      if (req.url === "/api/sessions/s/receipts") return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "message", conversationId: "c", messageId: "m1", channel: { reactions: false, status: false }, incoming: { text: "hi" } })}\n\n`);
    });
  });
  const sessions = new Set<Http2Session>();
  server.on("session", (session) => sessions.add(session));
  const close = () => (sessions.forEach((s) => s.destroy()), server.close());
  t.signal.addEventListener("abort", close);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const summary = await runInCloud({
      cloud: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      name: "cafe",
      tools: [],
      build: () => ({ channels: () => [], receive: (_id: string, _message: Incoming, deliver: (o: unknown) => Promise<void>) => (void deliver({ type: "message", text: "hello" }), "m1") }) as unknown as Agent,
      files: [],
      log: () => {},
    });
    assert.deepEqual(summary, { runs: [] });
  } finally {
    close();
  }
  assert.deepEqual(outbound, [{ conversationId: "c", outbound: { type: "message", text: "hello" } }]);
});

test("a tool call the cloud has not answered does not hold later posts, over HTTPS with HTTP/2", { timeout: 10_000 }, async (t) => {
  // The stream test only keeps the stream off fetch's connection. A tool call stays open until the
  // simulator answers, and on one shared HTTP/2 connection that held every later POST, so the
  // cloud never saw the reply or the turn and scored the run agent_quiet.
  const { key, cert } = httpsCert;
  const arrived: string[] = [];
  let stream: Http2ServerResponse | undefined;
  let heldOpen = true;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const path = req.url ?? "";
      if (path === "/api/sessions") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "d" }));
      if (path.endsWith("/tool-calls")) {
        held.then(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, output: {} })));
        stream!.write(`data: ${JSON.stringify({ type: "message", conversationId: "c", messageId: "m2", channel: { reactions: false, status: false }, incoming: { text: "next" } })}\n\n`);
        return;
      }
      if (path.endsWith("/events") || path.endsWith("/outbound")) {
        if (heldOpen) arrived.push(path.endsWith("/events") ? "events" : "outbound");
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        if (arrived.includes("events") && arrived.includes("outbound")) {
          release!();
          stream!.end(`data: ${JSON.stringify({ type: "finished", summary: { runs: [] } })}\n\n`);
        }
        return;
      }
      if (path.endsWith("/receipts") || path.endsWith("/drained")) return void res.writeHead(200, { "content-type": "application/json" }).end("{}");
      stream = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "message", conversationId: "c", messageId: "m1", channel: { reactions: false, status: false }, incoming: { text: "first" } })}\n\n`);
    });
  });
  const sessions = new Set<Http2Session>();
  server.on("session", (session) => sessions.add(session));
  const close = () => (sessions.forEach((s) => s.destroy()), server.close());
  const giveUp = setTimeout(() => {
    heldOpen = false;
    release!();
    stream?.end(`data: ${JSON.stringify({ type: "finished", summary: { runs: [] } })}\n\n`);
  }, 2_000);
  t.signal.addEventListener("abort", close);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    await runInCloud({
      cloud: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
      name: "cafe",
      tools: [{ name: "lookup", description: "Look something up", input: z.object({}), run: () => null }],
      build: ({ tools, events }) => ({
        channels: () => [],
        receive: (id: string, message: Incoming, deliver: (o: unknown) => Promise<void>) => {
          if (message.text === "first") {
            void Promise.resolve(tools[0].run({}, { conversationId: id, person: "p", key: null, channel: "sms", callId: "c1", idempotencyKey: "k1", signal: new AbortController().signal })).catch(() => {});
            return "m1";
          }
          events[0]({ type: "turn.start", conversationId: id, at: 1 });
          void deliver({ type: "message", text: "hello" });
          return "m2";
        },
      }) as unknown as Agent,
      files: [],
      log: () => {},
    });
  } finally {
    clearTimeout(giveUp);
    close();
  }
  assert.deepEqual(arrived.filter((p) => p === "events" || p === "outbound").sort(), ["events", "outbound"]);
});

/** One certificate for both HTTPS tests. Two with the same subject and serial can be mixed up when
 * the connection is checked, and the earlier test's certificate then fails the later one. */
const httpsCert = selfSignedCert();
setDefaultCACertificates([...getCACertificates("default"), httpsCert.cert]);

/** A throwaway self-signed certificate for 127.0.0.1, made here so no key is ever checked in. */
function selfSignedCert(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const tlv = (tag: number, ...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    const n = body.length;
    return Buffer.concat([Buffer.from([tag, ...(n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255])]), body]);
  };
  const hex = (h: string) => Buffer.from(h, "hex");
  const ecdsaSha256 = tlv(0x30, hex("06082a8648ce3d040302"));
  const name = tlv(0x30, tlv(0x31, tlv(0x30, hex("0603550403"), tlv(0x0c, Buffer.from("localhost")))));
  const validity = tlv(0x30, tlv(0x17, Buffer.from("250101000000Z")), tlv(0x17, Buffer.from("491231235959Z")));
  const ipSan = tlv(0x30, hex("0603551d11"), tlv(0x04, tlv(0x30, tlv(0x87, Buffer.from([127, 0, 0, 1])))));
  const spki = publicKey.export({ type: "spki", format: "der" });
  const tbs = tlv(0x30, tlv(0xa0, hex("020102")), hex("020101"), ecdsaSha256, name, validity, name, spki, tlv(0xa3, tlv(0x30, ipSan)));
  const der = tlv(0x30, tbs, ecdsaSha256, tlv(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert: new X509Certificate(der).toString() };
}
