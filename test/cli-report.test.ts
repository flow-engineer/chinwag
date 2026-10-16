// covers: testing/src/cli.ts testing/src/suite.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function runCli(url: string, dir: string, extra: string[] = []) {
  const env = { ...process.env };
  delete env.CHINWAG_CLOUD;
  delete env.CHINWAG_CLOUD_KEY;
  return spawn(process.execPath, [cli, "test", "--cloud", url, ...extra], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
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

/** Runs the CLI with these arguments, without the developer's cloud settings, and gives its exit code and output. */
async function cliOutput(args: string[], dir: string, node: string[] = []): Promise<{ code: number | null; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENROUTER_API_KEY: "test-key" };
  delete env.CHINWAG_CLOUD;
  delete env.CHINWAG_CLOUD_KEY;
  const child = spawn(process.execPath, [...node, cli, ...args], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { code, out };
}

test("the command line: --version, each command's own --help, and a plain line for a wrong flag", { timeout: 15_000 }, async () => {
  const dir = agentDir();
  const version = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version;
  assert.deepEqual(await cliOutput(["--version"], dir), { code: 0, out: `${version}\n` });
  const testHelp = await cliOutput(["test", "--help"], dir);
  assert.equal(testHelp.code, 0);
  assert.match(testHelp.out, /chinwag test \[options\]/);
  assert.doesNotMatch(testHelp.out, /chinwag new <name>/);
  const newHelp = await cliOutput(["new", "--help"], dir);
  assert.match(newHelp.out, /chinwag new <name>/);
  assert.doesNotMatch(newHelp.out, /--cloud/);
  const bogus = await cliOutput(["test", "--bogus"], dir);
  assert.equal(bogus.code, 1);
  assert.match(bogus.out, /^chinwag: unknown option --bogus\n\nUsage:\n {2}chinwag test/);
  assert.doesNotMatch(bogus.out, /ERR_PARSE_ARGS|\n\s+at /);
  assert.deepEqual(await cliOutput(["test", "--runs", "abc"], dir), { code: 1, out: '--runs must be a whole number above 0, such as 3 (got "abc").\n' });
  const old = await cliOutput(["new", "x"], dir, ["--import", 'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"22.17.0"})']);
  assert.deepEqual(old, { code: 1, out: "Chinwag needs Node 22.18 or newer (you have 22.17.0).\n" });
  assert.ok(!existsSync(join(dir, "x")));
});

test("what is wrong on this machine is said before the cloud is called, an address that does not answer is named, and the default cloud asks for its key", { timeout: 15_000 }, async () => {
  const closed = "http://127.0.0.1:9";
  const empty = mkdtempSync(join(tmpdir(), "chinwag-cli-"));
  const noAgent = await cliOutput(["test", "--cloud", closed], empty);
  assert.equal(noAgent.code, 1);
  assert.match(noAgent.out, /^No src\/agent\.ts in .+ Run chinwag test from your agent's folder/);
  const dir = agentDir();
  writeFileSync(join(dir, "tests", "scenarios", "bad.yaml"), "id: bad\nchannels: [sms, fax]\nperson:\n  persona: a\nopening:\n  - say: hi\n");
  assert.deepEqual(await cliOutput(["test", "--cloud", closed], dir), {
    code: 1,
    out: `${join("tests", "scenarios", "bad.yaml")}:2: channels[1]: Invalid option: expected one of "sms"|"whatsapp"|"imessage"|"telegram"|"web"\n${join("tests", "scenarios", "bad.yaml")}:3: person.goal: missing\n\nNothing was sent: fix the test files above.\n`,
  });
  const good = agentDir();
  assert.match((await cliOutput(["test", "--cloud", closed, "--agent-url", "http://127.0.0.1:9/chinwag"], good)).out, /^Could not reach your agent at http:\/\/127\.0\.0\.1:9\/chinwag: ECONNREFUSED\. Start it first/m);
  const named = await cliOutput(["test", "--cloud", closed], good);
  assert.equal(named.code, 1);
  assert.match(named.out, /^Could not reach http:\/\/127\.0\.0\.1:9: ECONNREFUSED\.$/m);
  // No cloud named: the hosted one, which needs a key before anything is sent.
  assert.match((await cliOutput(["test"], good)).out, /^A hosted cloud needs the agent's CI key: set CHINWAG_CLOUD_KEY\. Make a key at https:\/\/flow\.engineer\/observe: your agent, Developers\.$/m);
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
