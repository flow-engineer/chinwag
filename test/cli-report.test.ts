// covers: testing/src/cli.ts testing/src/suite.ts testing/src/client.ts testing/src/report.ts testing/src/show.ts
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

/** A run as the cloud reports it: hello's first run on sms, failed, unless `over` says otherwise. */
const runOf = (over: Record<string, unknown>) => ({ ...run.run, ...over });
const scenarioYaml = (id: string, channels: string) => `id: ${id}\nchannels: [${channels}]\nperson:\n  persona: a\n  goal: b\nopening:\n  - say: hi\n`;
const lastSession = (dir: string) => JSON.parse(readFileSync(join(dir, ".chinwag", "last-session.json"), "utf8"));

/** An agent folder with hello.yaml (sms) and any more scenarios, as file name to YAML. */
function agentDir(more: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "chinwag-cli-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "tests", "scenarios"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(dir, "src", "agent.ts"), "export const tools = [];\nexport function buildAgent() {\n  return { channels: () => [], receive: () => \"m\", reacted: () => {} };\n}\n");
  writeFileSync(join(dir, "tests", "scenarios", "hello.yaml"), scenarioYaml("hello", "sms"));
  for (const [name, yaml] of Object.entries(more)) writeFileSync(join(dir, "tests", "scenarios", `${name}.yaml`), yaml);
  return dir;
}

/** A cloud that opens session `sessionId` (its open's answer with `answer` added), sends `frames` on the stream, then ends it or holds it open; `opens` has each open's body. */
function cloud(hold: boolean, frames: unknown[] = [run], sessionId = "s", answer: Record<string, unknown> = {}) {
  let release: (() => void) | undefined;
  const opened = new Promise<void>((done) => { release = done; });
  const opens: Array<{ files: Array<{ path: string }>; runs: number }> = [];
  const server = createServer((req, res) => {
    if (req.url === "/api/sessions") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        opens.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId, token: "t", missing: [], dashboard: `http://dash/${sessionId}`, ...answer }));
      });
      return;
    }
    if (req.url?.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`);
      release?.();
      if (!hold) res.end();
      return;
    }
    req.resume();
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  return new Promise<{ url: string; opened: Promise<void>; opens: typeof opens; close: () => void }>((done) => {
    server.listen(0, "127.0.0.1", () => done({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      opened,
      opens,
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

test("a stream that dies prints the runs already in, keeps them with the rest as not played, and exits 2", { timeout: 15_000 }, async () => {
  const local = await cloud(false);
  const dir = agentDir({ bye: scenarioYaml("bye", "sms, whatsapp") });
  const child = runCli(local.url, dir);
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  try {
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 2);
    assert.match(out, /FAIL {2}hello #1/);
    assert.match(out, /1 of 3 runs finished before: the cloud closed the stream before the session finished/);
    assert.match(out, /http:\/\/dash\/s/);
    assert.match(out, /^Results: \.chinwag\/last-session\.json/m);
    const last = lastSession(dir);
    assert.equal(last.ended, "stopped");
    assert.deepEqual(last.runs.map((r: { scenario: string; channel: string; verdict: string }) => `${r.scenario} ${r.channel} ${r.verdict}`), ["bye sms not_played", "bye whatsapp not_played", "hello sms failed"]);
  } finally { child.kill(); local.close(); }
  // A run that never played counts as not passed.
  const again = await cliOutput(["test", "--failed", "--cloud", "http://127.0.0.1:9"], dir);
  assert.match(again.out, /^Running again what did not pass in session s, on every channel each plays: bye, hello\.$/m);
});

/** Runs the CLI with these arguments, without the developer's cloud settings, and gives its exit code and output. */
async function cliOutput(args: string[], dir: string, node: string[] = []): Promise<{ code: number | null; out: string }> {
  const { code, out } = await cliStreams(args, dir, {}, node);
  return { code, out };
}

/** The same, with `env` added, and stdout and stderr also apart. */
async function cliStreams(args: string[], dir: string, env: NodeJS.ProcessEnv = {}, node: string[] = []) {
  const full: NodeJS.ProcessEnv = { ...process.env, OPENROUTER_API_KEY: "test-key" };
  delete full.CHINWAG_CLOUD;
  delete full.CHINWAG_CLOUD_KEY;
  const child = spawn(process.execPath, [...node, cli, ...args], { cwd: dir, env: { ...full, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { out += chunk; stdout += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; stderr += chunk; });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, out, stdout, stderr };
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
  // A cloud that does not answer is a connection failure (2), not a failed run.
  const named = await cliOutput(["test", "--cloud", closed], good);
  assert.equal(named.code, 2);
  assert.match(named.out, /^Could not reach http:\/\/127\.0\.0\.1:9: ECONNREFUSED\.$/m);
  // No cloud named: the hosted one, which needs a key before anything is sent.
  assert.match((await cliOutput(["test"], good)).out, /^A hosted cloud needs the agent's CI key: set CHINWAG_CLOUD_KEY\. Make a key at https:\/\/flow\.engineer\/observe: your agent, Developers\.$/m);
});

test("Ctrl-C prints the same partial report, keeps what finished, and exits 130", { timeout: 15_000 }, async () => {
  const local = await cloud(true);
  const dir = agentDir();
  const child = runCli(local.url, dir);
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
    assert.match(out, /^Results: \.chinwag\/last-session\.json/m);
    const last = lastSession(dir);
    assert.equal(last.ended, "interrupted");
    assert.deepEqual(last.runs.map((r: { scenario: string; verdict: string }) => `${r.scenario} ${r.verdict}`), ["hello failed"]);
  } finally { child.kill(); local.close(); }
});

test("the cloud's refusal exits 3: an open refused for the spend cap is not sent again, and a session it ends for the spend cap", { timeout: 15_000 }, async () => {
  let opens = 0;
  const server = createServer((req, res) => {
    req.resume();
    opens++;
    res.writeHead(429, { "content-type": "application/json", "retry-after": "0" }).end('{"error":{"type":"spend_cap","message":"The daily spend cap is reached."}}');
  });
  const local = await new Promise<{ url: string; close: () => void }>((done) => {
    server.listen(0, "127.0.0.1", () => done({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
  const dir = agentDir();
  try {
    const refused = await cliStreams(["test", "--cloud", local.url, "--json"], dir);
    assert.equal(refused.code, 3, refused.out);
    assert.equal(opens, 1);
    assert.match(refused.stderr, /spend cap is reached/);
    assert.ok(!refused.out.includes("runs finished before"));
    const report = JSON.parse(refused.stdout);
    assert.deepEqual({ outcome: report.outcome, exitCode: report.exitCode, sessionId: report.sessionId, runs: report.runs }, { outcome: "refused", exitCode: 3, sessionId: null, runs: [] });
    assert.deepEqual({ ...report.error, message: undefined }, { message: undefined, status: 429, type: "spend_cap", retryAfterSeconds: 0 });
    // No session opened, so the last one's results are left as they were.
    assert.ok(!existsSync(join(dir, ".chinwag")));
  } finally { local.close(); }

  const ended = await cloud(false, [run, { type: "failed", error: "spend_cap: the daily spend cap is reached" }]);
  try {
    const result = await cliOutput(["test", "--cloud", ended.url], dir);
    assert.equal(result.code, 3, result.out);
    assert.match(result.out, /the cloud stopped the session: spend_cap/);
    assert.equal(lastSession(dir).ended, "stopped");
  } finally { ended.close(); }
});

test("with --json, every exit prints one report on stdout and every other line on stderr", { timeout: 20_000 }, async () => {
  const dir = agentDir({ b: scenarioYaml("bee", "sms") });
  const runs = [
    runOf({ runId: "trn_1", scenario: "hello", passed: true, agentUsage: { input: 10, output: 5, costUsd: 0.25 }, testUsage: { input: 1, output: 1, costUsd: 0.5 } }),
    runOf({ runId: "trn_2", scenario: "bee", turns: 6, checks: [{ kind: "judge", text: "Asks to confirm.", pass: false, reason: "It never asked." }], agentUsage: { input: 1, output: 1, costUsd: 0.25 } }),
  ];
  const finished = { type: "finished", summary: { sessionId: "s1", suiteHash: "h", testModel: "m", runs, dashboard: "http://dash/s1" } };
  const local = await cloud(false, [finished], "s1", { agent: "agt_1" });
  let result;
  try {
    result = await cliStreams(["test", "--cloud", local.url, "--json"], dir);
  } finally { local.close(); }
  assert.equal(result.code, 1, result.out);
  assert.match(result.stderr, /^FAIL {2}bee #1 \(sms\) trn_2: 6 turns/m);
  assert.match(result.stderr, /^Results: \.chinwag\/last-session\.json/m);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const report = JSON.parse(result.stdout);
  assert.match(report.suiteHash, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...report, suiteHash: undefined }, {
    version: 1, outcome: "failed", exitCode: 1, sessionId: "s1", agent: "agt_1", dashboard: "http://dash/s1", suiteHash: undefined, error: null,
    counts: { runs: 2, passed: 1, failed: 1, errored: 0, notPlayed: 0 },
    costUsd: { agent: 0.5, test: 0.5 },
    runs: [
      { runId: "trn_2", scenario: "b", channel: "sms", run: 1, verdict: "failed", error: null, ended: "goal", turns: 6, watch: "http://watch/r1", failedChecks: [{ kind: "judge", text: "Asks to confirm.", reason: "It never asked." }] },
      { runId: "trn_1", scenario: "hello", channel: "sms", run: 1, verdict: "passed", error: null, ended: "goal", turns: 1, watch: "http://watch/r1", failedChecks: [] },
    ],
  });
  // The results file agrees with the report, and keeps the cloud's agent id for chinwag show.
  const last = lastSession(dir);
  assert.equal(last.agent, "agt_1");
  assert.deepEqual(last.runs.map((r: { runId: string; verdict: string }) => `${r.runId} ${r.verdict}`), ["trn_2 failed", "trn_1 passed"]);

  // Nothing sent, and a cloud that does not answer: still one report each.
  const invalid = await cliStreams(["test", "--json", "--runs", "abc"], dir);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stderr, '--runs must be a whole number above 0, such as 3 (got "abc").\n');
  assert.deepEqual([JSON.parse(invalid.stdout).outcome, JSON.parse(invalid.stdout).exitCode], ["invalid", 1]);
  const unreachable = await cliStreams(["test", "--json", "--cloud", "http://127.0.0.1:9"], dir);
  assert.equal(unreachable.code, 2);
  assert.deepEqual([JSON.parse(unreachable.stdout).outcome, JSON.parse(unreachable.stdout).error.message], ["transport", "Could not reach http://127.0.0.1:9: ECONNREFUSED."]);
});

test("a run the cloud names an error for is errored, whatever it ended as: ERROR on its line, errored in --json and the results, and exit 2 when none failed", { timeout: 20_000 }, async () => {
  const dir = agentDir({ b: scenarioYaml("bee", "sms") });
  // The judge failed after the person met their goal: the checks it left say nothing about the agent.
  const judged = runOf({ runId: "trn_2", scenario: "bee", ended: "goal_met", error: "judge_failed", checks: [{ kind: "judge", text: "Asks to confirm.", pass: false, reason: "not judged" }] });
  const runs = [runOf({ runId: "trn_1", scenario: "hello", passed: true, ended: "goal_met" }), judged];
  const finished = (extra: unknown[] = []) => ({ type: "finished", summary: { sessionId: "s1", suiteHash: "h", testModel: "m", runs: [...runs, ...extra], dashboard: "http://dash/s1" } });
  const local = await cloud(false, [finished()], "s1", { agent: "agt_1" });
  let result;
  try {
    result = await cliStreams(["test", "--cloud", local.url, "--json"], dir);
  } finally { local.close(); }
  assert.equal(result.code, 2, result.out);
  assert.match(result.stderr, /^ERROR {2}bee #1 \(sms\) trn_2: 1 turn, ended: goal_met; error: judge_failed \(the cloud could not play or judge this run, not the agent's fault\);/m);
  assert.doesNotMatch(result.stderr, /FAIL {2}bee|not judged/);
  assert.match(result.stderr, /^1 of 2 runs passed\. 1 errored \(the cloud could not play or judge it\)\. .* 0 failed a check\./m);
  const report = JSON.parse(result.stdout);
  assert.deepEqual([report.outcome, report.exitCode, report.counts], ["errored", 2, { runs: 2, passed: 1, failed: 0, errored: 1, notPlayed: 0 }]);
  assert.deepEqual(report.runs.map((r: { runId: string; verdict: string; error: string | null; ended: string }) => `${r.runId} ${r.verdict} ${r.error} ${r.ended}`), ["trn_2 errored judge_failed goal_met", "trn_1 passed null goal_met"]);
  assert.deepEqual(lastSession(dir).runs.map((r: { runId: string; verdict: string }) => `${r.runId} ${r.verdict}`), ["trn_2 errored", "trn_1 passed"]);

  // An error beats passed too, and without --json the exit is the same.
  const capped = await cloud(false, [{ type: "finished", summary: { ...finished().summary, runs: [runs[0], { ...judged, passed: true, error: "spend_cap", checks: [] }] } }], "s2");
  try {
    const plain = await cliStreams(["test", "--cloud", capped.url], dir);
    assert.equal(plain.code, 2, plain.out);
    assert.match(plain.stdout, /^ERROR {2}bee #1 \(sms\) trn_2: .*error: spend_cap/m);
    assert.match(plain.stdout, /^ {2}sms: 1 of 2 passed$/m);
  } finally { capped.close(); }

  // A run that failed still makes the session fail (exit 1), beside an errored one.
  const mixed = await cloud(false, [finished([runOf({ runId: "trn_3", scenario: "hello", run: 2 })])], "s3");
  try {
    assert.equal((await cliStreams(["test", "--cloud", mixed.url], dir)).code, 1);
  } finally { mixed.close(); }
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

test("a session the cloud lost and a second one played prints both dashboards", { timeout: 15_000 }, async () => {
  let opens = 0;
  const second = { ...run, run: { ...run.run, runId: "r2", run: 2 } };
  const server = createServer((req, res) => {
    req.resume();
    const reply = (status: number, value: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (req.url === "/api/sessions") {
      opens++;
      return reply(200, { sessionId: `s${opens}`, token: `t${opens}`, missing: [], dashboard: `http://dash/s${opens}`, reopen: true });
    }
    if (req.url?.endsWith("/stream")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (req.url.includes("/s1/")) return void res.write(`data: ${JSON.stringify(run)}\n\ndata: ${JSON.stringify({ type: "drain" })}\n\n`);
      const finished = { type: "finished", summary: { sessionId: "s2", suiteHash: "h", testModel: "fake", runs: [second.run], dashboard: "http://dash/s2" } };
      return void res.end(`data: ${JSON.stringify(second)}\n\ndata: ${JSON.stringify(finished)}\n\n`);
    }
    if (req.url?.endsWith("/drained")) return reply(410, { error: "session_gone" });
    reply(200, {});
  });
  const local = await new Promise<{ url: string; close: () => void }>((done) => {
    server.listen(0, "127.0.0.1", () => done({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
  const child = runCli(local.url, agentDir(), ["--runs", "2"]);
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  try {
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 1, out);
    assert.match(out, /0 of 2 runs passed/);
    assert.match(out, /The cloud lost session s1 part way; a second session played its unfinished runs\. The first: http:\/\/dash\/s1/);
    assert.match(out, /http:\/\/dash\/s2/);
  } finally { child.kill(); local.close(); }
});

test("a finished session's results are kept, and --failed runs again only what did not pass, with --runs, until nothing has failed", { timeout: 20_000 }, async () => {
  // b.yaml's id is not its file name: the results and --failed use the file name, as --only does.
  const dir = agentDir({ b: scenarioYaml("bee", "sms"), c: scenarioYaml("c", "sms, whatsapp") });
  const first = [
    runOf({ runId: "r1", scenario: "hello", passed: true }),
    runOf({ runId: "r2", scenario: "bee", checks: [
      { kind: "judge", text: "Asks to confirm.", pass: false, reason: "It never asked." },
      { kind: "outcome", text: "One order.", pass: true, reason: "ok" },
    ] }),
    runOf({ runId: "r3", scenario: "c", ended: "run_failed" }),
    runOf({ runId: "r4", scenario: "c", channel: "whatsapp", passed: true }),
  ];
  const finished = (sessionId: string, runs: unknown[]) => ({ type: "finished", summary: { sessionId, suiteHash: "h", testModel: "m", runs, dashboard: `http://dash/${sessionId}` } });
  const full = await cloud(false, [finished("s1", first)], "s1");
  try {
    const result = await cliOutput(["test", "--cloud", full.url], dir);
    assert.equal(result.code, 1);
    assert.match(result.out, /^Results: \.chinwag\/last-session\.json/m);
  } finally { full.close(); }
  const last = lastSession(dir);
  assert.deepEqual({ ...last, endedAt: undefined, suiteHash: undefined }, {
    sessionId: "s1", dashboard: "http://dash/s1", ended: "finished", only: null, endedAt: undefined, suiteHash: undefined,
    runs: [
      { scenario: "b", channel: "sms", run: 1, runId: "r2", verdict: "failed", failedChecks: [{ kind: "judge", text: "Asks to confirm.", reason: "It never asked." }] },
      { scenario: "c", channel: "sms", run: 1, runId: "r3", verdict: "errored", failedChecks: [] },
      { scenario: "c", channel: "whatsapp", run: 1, runId: "r4", verdict: "passed", failedChecks: [] },
      { scenario: "hello", channel: "sms", run: 1, runId: "r1", verdict: "passed", failedChecks: [] },
    ],
  });
  assert.match(last.suiteHash, /^[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(last.endedAt)));

  const passing = ["b", "c"].flatMap((scenario) => [1, 2].flatMap((n) => (scenario === "c" ? ["sms", "whatsapp"] : ["sms"]).map((channel) =>
    runOf({ runId: `${scenario}${n}${channel}`, scenario: scenario === "b" ? "bee" : scenario, run: n, channel, passed: true }))));
  const rerun = await cloud(false, [finished("s2", passing)], "s2");
  try {
    const result = await cliOutput(["test", "--failed", "--runs", "2", "--cloud", rerun.url], dir);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /^Running again what did not pass in session s1, on every channel each plays: b, c\.$/m);
    assert.deepEqual(rerun.opens.map((o) => [o.files.map((f) => f.path), o.runs]), [[["scenarios/b.yaml", "scenarios/c.yaml"], 2]]);
  } finally { rerun.close(); }
  assert.deepEqual(lastSession(dir).only, ["b", "c"]);

  assert.deepEqual(await cliOutput(["test", "--failed", "--cloud", "http://127.0.0.1:9"], dir), {
    code: 0,
    out: "Nothing failed in the last session (s2).\nIt ran only b, c: run chinwag test for the whole suite.\n",
  });
});

test("--failed with no last session, or with --only, stops before anything is sent", { timeout: 15_000 }, async () => {
  const dir = agentDir();
  const none = await cliOutput(["test", "--failed", "--cloud", "http://127.0.0.1:9"], dir);
  assert.equal(none.code, 1);
  assert.match(none.out, /^No \.chinwag\/last-session\.json in .+: run chinwag test first/);
  assert.deepEqual(await cliOutput(["test", "--failed", "--only", "hello", "--cloud", "http://127.0.0.1:9"], dir), {
    code: 1,
    out: "--failed picks its scenarios from the last session and does not go with --only: run one or the other.\n",
  });
});

test("the summary reads the same on every machine: token counts in one format, and whether every run called the agent's model", { timeout: 15_000 }, async () => {
  const dir = agentDir({ b: scenarioYaml("bee", "sms") });
  const runs = [
    runOf({ runId: "r1", scenario: "hello", passed: true, agentModels: ["m"], agentUsage: { input: 194_620, output: 1_200, costUsd: 0 } }),
    runOf({ runId: "r2", scenario: "bee", passed: true }),
  ];
  const local = await cloud(false, [{ type: "finished", summary: { sessionId: "s", suiteHash: "h", testModel: "m", runs, dashboard: "http://dash/s" } }]);
  try {
    const result = await cliStreams(["test", "--cloud", local.url], dir, { LC_ALL: "en_IN.UTF-8", LANG: "en_IN.UTF-8" });
    assert.equal(result.code, 0, result.out);
    assert.match(result.stdout, /2 of 2 runs passed\. 1 run never called the agent's model\./);
    assert.match(result.stdout, /\(194,620 in, 1,200 out\)/);
  } finally { local.close(); }
});

test("--dotenv is read in place of the folder's .env, and variables already set win", { timeout: 15_000 }, async () => {
  const dir = agentDir();
  writeFileSync(join(dir, ".env"), "CHINWAG_CLOUD=http://127.0.0.1:7\n");
  writeFileSync(join(dir, "ci.env"), "CHINWAG_CLOUD=http://127.0.0.1:9\n");
  assert.match((await cliOutput(["test"], dir)).out, /^Could not reach http:\/\/127\.0\.0\.1:7: ECONNREFUSED\.$/m);
  assert.match((await cliOutput(["test", "--dotenv", "ci.env"], dir)).out, /^Could not reach http:\/\/127\.0\.0\.1:9: ECONNREFUSED\.$/m);
  assert.match((await cliStreams(["test", "--dotenv", "ci.env"], dir, { CHINWAG_CLOUD: "http://127.0.0.1:8" })).out, /^Could not reach http:\/\/127\.0\.0\.1:8: ECONNREFUSED\.$/m);
  assert.deepEqual(await cliOutput(["test", "--dotenv", "none.env"], dir), { code: 1, out: "--dotenv none.env: no such file.\n" });
});

/** A run's record as the cloud keeps it: a judge check failed, one tool call between the messages. */
const record = {
  runId: "trn_2", sessionId: "s1", agent: "agt_1", scenario: { id: "bee", path: "scenarios/b.yaml", hash: "h" }, run: 1, channel: "whatsapp",
  startedAt: 1_000, finishedAt: 9_000,
  transcript: [
    { kind: "in", id: "m1", text: "a large latte please", at: 1_000 },
    { kind: "out", id: "a1", text: "Placed! Anything else?", at: 4_000, buttons: [{ title: "No thanks" }, "Yes"] },
    { kind: "reaction", messageId: "a1", emoji: "👍", at: 5_000, by: "person" },
  ],
  toolCalls: [{ tool: "place_order", input: { size: "large" }, ok: true, output: { order: 7 }, latencyMs: 800, changes: ["order 7 placed"], kind: "write", at: 2_000, overheadMs: 3 }],
  checks: [
    { kind: "outcome", text: "One order is placed.", pass: true, reason: "Order 7." },
    { kind: "judge", text: "Asks to confirm before ordering.", pass: false, reason: "It placed the order without asking." },
  ],
  summary: { passed: false, ended: "goal_met", turns: 2, watch: "http://watch/trn_2" },
};

test("chinwag show prints a run's record from the cloud with the CI key: checks with reasons, then messages and tool calls in time order", { timeout: 15_000 }, async () => {
  const asked: Array<{ path: string; authorization?: string }> = [];
  const server = createServer((req, res) => {
    asked.push({ path: req.url!, authorization: req.headers.authorization });
    if (req.url === "/v1/agents/agt_1/tests/runs/trn_2") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(record));
    if (req.url === "/v1/agents/agt_1/tests/runs/trn_4") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...record, runId: "trn_4", error: "judge_failed" }));
    if (req.url === "/v1/agents/agt_1/tests/runs/trn_5") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...record, runId: "trn_5", summary: { ...record.summary, passed: true, error: "simulator_failed" } }));
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":{"type":"not_found","message":"No such run."}}');
  });
  const url = await new Promise<string>((done) => server.listen(0, "127.0.0.1", () => done(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  const dir = agentDir();
  mkdirSync(join(dir, ".chinwag"));
  const runs = [
    { scenario: "hello", channel: "sms", run: 1, runId: "trn_1", verdict: "passed", failedChecks: [] },
    { scenario: "b", channel: "whatsapp", run: 1, runId: "trn_2", verdict: "failed", failedChecks: [] },
    { scenario: "c", channel: "sms", run: 1, runId: "trn_3", verdict: "errored", failedChecks: [] },
  ];
  writeFileSync(join(dir, ".chinwag", "last-session.json"), JSON.stringify({ sessionId: "s1", agent: "agt_1", dashboard: "d", suiteHash: "h", endedAt: "t", ended: "finished", only: null, runs }));
  const key = { CHINWAG_CLOUD_KEY: "oci_test" };
  try {
    const shown = await cliStreams(["show", "last", "--cloud", url], dir, key);
    assert.equal(shown.code, 0, shown.out);
    assert.match(shown.stderr, /^Showing b #1 \(whatsapp\), failed: trn_2$/m);
    assert.match(shown.stderr, /also did not pass: chinwag show trn_3/);
    assert.deepEqual(asked, [{ path: "/v1/agents/agt_1/tests/runs/trn_2", authorization: "Bearer oci_test" }]);
    assert.equal(shown.stdout, [
      "FAIL  scenarios/b.yaml",
      "  channel whatsapp, run 1, trn_2; ended: goal_met, 2 turns",
      "",
      "Checks:",
      "  ✗ judge: Asks to confirm before ordering.",
      "      It placed the order without asking.",
      "  ✓ outcome: One order is placed.",
      "      Order 7.",
      "",
      "Conversation:",
      "   +0.0s person: a large latte please",
      '   +1.0s tool place_order({"size":"large"}) → {"order":7} [write, simulated, 800 ms]',
      "           changes: order 7 placed",
      "   +3.0s agent: Placed! Anything else? [buttons: No thanks | Yes]",
      "   +4.0s person reacted 👍 to a1",
      "",
      "Watch: http://watch/trn_2",
      "",
    ].join("\n"));

    const json = await cliStreams(["show", "trn_2", "--json", "--cloud", url], dir, key);
    assert.equal(json.code, 0);
    assert.equal(json.stdout, JSON.stringify(record));

    // A run the cloud could not judge reads ERROR, though it ended goal_met, with its code.
    const errored = await cliStreams(["show", "trn_4", "--cloud", url], dir, key);
    assert.equal(errored.code, 0, errored.out);
    assert.deepEqual(errored.stdout.split("\n").slice(0, 3), [
      "ERROR  scenarios/b.yaml",
      "  channel whatsapp, run 1, trn_4; ended: goal_met, 2 turns",
      "  error: judge_failed (the cloud could not play or judge this run; it says nothing about the agent)",
    ]);
    const summaryOnly = await cliStreams(["show", "trn_5", "--cloud", url], dir, key);
    assert.match(summaryOnly.stdout, /^ERROR {2}scenarios\/b\.yaml\n.*\n {2}error: simulator_failed /);

    const missing = await cliStreams(["show", "trn_9", "--cloud", url], dir, key);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^The cloud answered 404 not_found: No such run\. No run trn_9 for this agent\.$/m);
  } finally { server.closeAllConnections(); server.close(); }
});
