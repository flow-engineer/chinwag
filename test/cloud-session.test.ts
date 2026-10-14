// covers: testing/src/client.ts
// The CLI against a hosted cloud: the open carries the CI key and the synthetic attestation, and the
// session is played at the tunnel the open answers, which never sees the key.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
