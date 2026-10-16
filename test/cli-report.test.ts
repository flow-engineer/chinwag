// covers: testing/src/cli.ts testing/src/suite.ts testing/src/client.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSuite, parseScenario, parseToolFile } from "../testing/src/suite.ts";

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

/** A cloud that opens session `sessionId`, sends `frames` on the stream, then ends it or holds it open; `opens` has each open's body. */
function cloud(hold: boolean, frames: unknown[] = [run], sessionId = "s") {
  let release: (() => void) | undefined;
  const opened = new Promise<void>((done) => { release = done; });
  const opens: Array<{ files: Array<{ path: string }>; runs: number }> = [];
  const server = createServer((req, res) => {
    if (req.url === "/api/sessions") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        opens.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sessionId, token: "t", missing: [], dashboard: `http://dash/${sessionId}` }));
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
  const dir = agentDir();
  const child = runCli(local.url, dir);
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  try {
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.equal(code, 1);
    assert.match(out, /unauthorized/);
    assert.ok(!out.includes("runs finished before"));
    // No session opened, so the last one's results are left as they were.
    assert.ok(!existsSync(join(dir, ".chinwag")));
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
      { kind: "judge", text: "Asks to confirm.", pass: false, reason: "The agent wrote: SECRET-TRANSCRIPT" },
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
      { scenario: "b", channel: "sms", run: 1, verdict: "failed", failedChecks: [{ kind: "judge", text: "Asks to confirm." }] },
      { scenario: "c", channel: "sms", run: 1, verdict: "errored", failedChecks: [] },
      { scenario: "c", channel: "whatsapp", run: 1, verdict: "passed", failedChecks: [] },
      { scenario: "hello", channel: "sms", run: 1, verdict: "passed", failedChecks: [] },
    ],
  });
  assert.match(last.suiteHash, /^[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(last.endedAt)));
  assert.doesNotMatch(readFileSync(join(dir, ".chinwag", "last-session.json"), "utf8"), /SECRET-TRANSCRIPT/);

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

test("test files: old ones parse as before, the clock, calls and never parse, and each mistake is named with its file and line", () => {
  // An old scenario with a stray key, and an old tool file whose {{name}} is not the clock: unchanged.
  const old = "id: x\nchannels: [sms]\nperson:\n  persona: a\n  goal: b\nopening:\n  - say: hi\nnotes: kept\n";
  assert.deepEqual(parseScenario({ path: "scenarios/x.yaml", content: old }), {
    id: "x", channels: ["sms"], person: { persona: "a", goal: "b" }, opening: [{ say: "hi" }], max_turns: 8, expect: {},
  });
  const tool = "tool: t\nresponses:\n  - when: Always\n    latency_ms: 5\n    output: { greeting: 'hi {{name}}' }\n";
  assert.deepEqual(parseToolFile({ path: "tools/t.yaml", content: tool }), { tool: "t", responses: [{ when: "Always", latency_ms: 5, output: { greeting: "hi {{name}}" } }] });

  const scenario = (more: string) => ({ path: "scenarios/x.yaml", content: `${old}${more}` });
  assert.deepEqual(parseScenario(scenario([
    "timezone: America/New_York", "now: 2026-10-16T09:00", "world: The class is on {{now + 6d @ 10:00 | weekday}}.",
    "expect:", "  calls:", "    - cancel_session", "    - tool: move_session", "      args: { slot: { at: '{{now+1w|date}}' } }", "  never: [delete_account]", "",
  ].join("\n"))), {
    id: "x", channels: ["sms"], person: { persona: "a", goal: "b" }, opening: [{ say: "hi" }], max_turns: 8,
    timezone: "America/New_York", now: "2026-10-16T09:00", world: "The class is on {{now + 6d @ 10:00 | weekday}}.",
    expect: { calls: ["cancel_session", { tool: "move_session", args: { slot: { at: "{{now+1w|date}}" } } }], never: ["delete_account"] },
  });
  for (const now of ["2026-10-16T09:00:30Z", "2026-10-16T09:00-04:00"]) assert.equal(parseScenario(scenario(`now: ${now}\n`)).now, now);
  // The café example, as shipped, is valid.
  for (const file of loadSuite(fileURLToPath(new URL("../examples/cafe/tests", import.meta.url)))) (file.path.startsWith("scenarios/") ? parseScenario : parseToolFile)(file);

  const placeholder = (text: string) => `unknown placeholder ${text}: write it like {{now + 3d}}, {{now - 2h | time}} or {{now + 1w @ 10:00 | date}}`;
  const mistakes: Array<[string, string]> = [
    ["timezone: Mars/Base", "scenarios/x.yaml:9: timezone: not a time zone: use an IANA name such as America/New_York or UTC"],
    ["now: 2026-02-30T09:00", "scenarios/x.yaml:9: now: not a date and time: write YYYY-MM-DDTHH:MM, with :SS, Z or an offset such as -04:00 if needed"],
    ["now: 2026-10-16 09:00", "scenarios/x.yaml:9: now: not a date and time: write YYYY-MM-DDTHH:MM, with :SS, Z or an offset such as -04:00 if needed"],
    ["expect:\n  calls:\n    - tool: move_session\n      arg: {}", "scenarios/x.yaml:11: expect.calls[0]: Unrecognized key: \"arg\""],
    ["expect:\n  never:\n    - args: { slot: s-2 }", "scenarios/x.yaml:11: expect.never[0]: a tool name, or { tool: <name>, args: { <field>: <value> } }"],
    ["expect:\n  judge:\n    - It is booked for {{now + 3 days}}.", `scenarios/x.yaml:11: expect.judge[0]: ${placeholder("{{now + 3 days}}")}`],
    ["expect:\n  calls:\n    - tool: t\n      args:\n        at: '{{now @ 9:00}}'", `scenarios/x.yaml:13: expect.calls[0].args.at: ${placeholder("{{now @ 9:00}}")}`],
  ];
  for (const [more, error] of mistakes) assert.throws(() => parseScenario(scenario(`${more}\n`)), { message: error });
  assert.throws(() => parseToolFile({ path: "tools/t.yaml", content: `${tool}    input:\n      days: ['{{now + 1d | year}}']\n` }), {
    message: `tools/t.yaml:7: responses[0].input.days[0]: ${placeholder("{{now + 1d | year}}")}`,
  });
});
