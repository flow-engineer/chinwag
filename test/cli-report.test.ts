// covers: testing/src/cli.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../testing/src/cli.ts", import.meta.url));
const run = {
  type: "run",
  run: {
    runId: "r1", scenario: "hello", run: 1, channel: "sms", passed: false, checks: [], ended: "goal",
    turns: 1, messagesIn: 1, messagesOut: 0, toolCalls: 0, slowestAckMs: null,
    agentUsage: { input: 0, output: 0, costUsd: 0 }, agentModels: [],
    testUsage: { input: 0, output: 0, costUsd: 0 }, watch: "http://watch/r1",
  },
};

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "chinwag-cli-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "tests", "scenarios"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(dir, "src", "agent.ts"), "export const tools = [];\nexport function buildAgent() {\n  return { channels: () => [], receive: () => \"m\", reacted: () => {} };\n}\n");
  writeFileSync(join(dir, "tests", "scenarios", "hello.yaml"), "id: hello\nchannels: [sms]\nperson:\n  persona: a\n  goal: b\nopening:\n  - say: hi\n");
  return dir;
}

function cloud(hold: boolean) {
  let release: (() => void) | undefined;
  const opened = new Promise<void>((done) => { release = done; });
  const server = createServer((req, res) => {
    if (req.url === "/api/sessions") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId: "s", token: "t", missing: [], dashboard: "http://dash/s" }));
      return;
    }
    if (req.url?.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(run)}\n\n`);
      release?.();
      if (!hold) res.end();
      return;
    }
    req.resume();
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  return new Promise<{ url: string; opened: Promise<void>; close: () => void }>((done) => {
    server.listen(0, "127.0.0.1", () => done({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      opened,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

function runCli(url: string, dir: string) {
  const env = { ...process.env };
  delete env.CHINWAG_CLOUD;
  delete env.CHINWAG_CLOUD_KEY;
  return spawn(process.execPath, [cli, "test", "--cloud", url], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
}

test("a stream that dies prints the runs already in and exits 2", { timeout: 15_000 }, async () => {
  const local = await cloud(false);
  const child = runCli(local.url, agentDir());
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  try {
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 2);
    assert.match(out, /FAIL {2}hello #1/);
    assert.match(out, /1 of 1 runs finished before: the cloud closed the stream before the session finished/);
    assert.match(out, /http:\/\/dash\/s/);
  } finally { child.kill(); local.close(); }
});

test("Ctrl-C prints the same partial report and exits 130", { timeout: 15_000 }, async () => {
  const local = await cloud(true);
  const child = runCli(local.url, agentDir());
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  try {
    await local.opened;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no run printed:\n${out}`)), 5_000);
      child.stdout.on("data", () => {
        if (!out.includes("FAIL")) return;
        clearTimeout(timer);
        resolve();
      });
      if (out.includes("FAIL")) { clearTimeout(timer); resolve(); }
    });
    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 130);
    assert.match(out, /1 of 1 runs finished before: interrupted/);
    assert.match(out, /http:\/\/dash\/s/);
    assert.match(out, /the cloud keeps playing; stop it from the dashboard: http:\/\/dash\/s/);
  } finally { child.kill(); local.close(); }
});

test("a refused open exits 1 and prints only the message", { timeout: 15_000 }, async () => {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
  });
  const local = await new Promise<{ url: string; close: () => void }>((done) => {
    server.listen(0, "127.0.0.1", () => done({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
  const child = runCli(local.url, agentDir());
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  try {
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 1);
    assert.match(out, /unauthorized/);
    assert.ok(!out.includes("runs finished before"));
  } finally { child.kill(); local.close(); }
});

test("an agent that fails to build exits 1 and prints only the message", { timeout: 15_000 }, async () => {
  const dir = agentDir();
  writeFileSync(join(dir, "src", "agent.ts"), "export const tools = [];\nexport function buildAgent() { throw new Error(\"agent broke\"); }\n");
  const child = runCli("http://127.0.0.1:9", dir);
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  try {
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 1);
    assert.match(out, /agent broke/);
    assert.ok(!out.includes("runs finished before"));
  } finally { child.kill(); }
});
