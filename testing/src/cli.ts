#!/usr/bin/env node
// The chinwag command. `chinwag new <name>` makes ./<name>/, an agent started from the café example
// (testing/src/new.ts). `chinwag test`, or `chinwag` with flags, runs an agent's tests in the cloud,
// from the agent's folder:
//   chinwag test [--cloud https://flow.engineer/observe] [--runs 3] [--only late-order,refund]
// A hosted cloud (any --cloud off this machine, the default included) needs the
// agent's CI key in CHINWAG_CLOUD_KEY and --synthetic, the attestation that the test files hold no real
// customer or member data. --agent-version (else GITHUB_SHA), --ref (else GitHub's branch) and
// --environment (staging or production) are kept with the session.
// The agent's src/agent.ts exports buildAgent({ model, events, tools }) and its tools; its tests are
// in tests/scenarios and tests/tools. An agent built on anything else is tested through its HTTP
// endpoint instead, with --agent-url (testing/src/http-agent.ts): its own tools run for real.

import { existsSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { OBSERVE_URL } from "../../src/traces.ts";
import { cloudHeaders, runInCloud, SessionStopped, type ConnectOptions } from "./client.ts";
import { runPrinter } from "./print-run.ts";
import { httpAgent } from "./http-agent.ts";
import { newStandalone, packageRoot } from "./new.ts";
import { loadSuite, parseScenario, parseToolFile } from "./suite.ts";
import type { RunSummary } from "./protocol.ts";

const NEW_LINE = "  chinwag new <name>        Make ./<name>/, a new agent started from the café example";
const TEST_LINE = `  chinwag test [options]    Run the agent's tests in a test cloud, from the agent's folder
                            (src/agent.ts exports buildAgent({ model, events, tools }) and tools;
                            the tests are in tests/scenarios and tests/tools)`;
const NEW_USAGE = `Usage:\n${NEW_LINE}\n\n  -h, --help                Show this help`;
const TEST_OPTIONS = `Options for test:
  --cloud <url>            The test cloud (default: CHINWAG_CLOUD, else https://flow.engineer/observe)
  --runs <n>               Runs per scenario (default: 1)
  --only <ids>             Only these scenarios, comma-separated (file names without .yaml)
  --synthetic              Attest the test files hold no real customer data (a hosted cloud needs it)
  --agent-version <v>      Kept with the session (default: GITHUB_SHA)
  --ref <ref>              Kept with the session (default: GitHub's branch)
  --environment <name>     staging or production, kept with the session
  --agent-url <url>        Test an agent you already have, on any framework, through its HTTP
                           endpoint (it may be http://localhost): each message is a POST to it from
                           this machine, and no src/agent.ts is loaded
  --channel <name>         With --agent-url: the channel every message names (default: the
                           platform each run plays, such as whatsapp or sms)
  --agent-timeout <s>      With --agent-url: how long one message waits for its answer (default: 60)
  -h, --help               Show this help

Exit status:
  0    Every run passed
  1    A run failed, the cloud refused the session, or the session never opened.
       The message is printed on its own
  2    The tunnel, the stream, or the connection failed after the session opened.
       The runs that had finished are printed, then "N of M runs finished before: <reason>"
       and the dashboard link
  130  Interrupted (Ctrl-C). The same partial report as exit 2. The cloud keeps
       playing until it is stopped from the dashboard

Environment (also read from the agent folder's .env; variables already set win):
  CHINWAG_CLOUD            The test cloud, when --cloud is not given
  CHINWAG_CLOUD_KEY        The agent's CI key, for a hosted cloud (oci_...: make one at
                           https://flow.engineer/observe, your agent, Developers)
  CHINWAG_AGENT_TOKEN      With --agent-url: sent to it as authorization: Bearer <token>
  OPENROUTER_API_KEY       The agent's model key, or OPENAI_API_KEY, ANTHROPIC_API_KEY or
                           GEMINI_API_KEY: the first with a value is used`;
const TEST_USAGE = `Usage:\n${TEST_LINE}\n\n${TEST_OPTIONS}`;
const USAGE = `Usage:\n${NEW_LINE}\n${TEST_LINE}\n  chinwag --version         Show the version\n\n${TEST_OPTIONS}`;

checkNode(process.versions.node);

// The agent folder's .env (its model key, CHINWAG_CLOUD_KEY), when there is one; variables already
// set win over the file, and no value is ever printed.
if (process.argv[2] !== "new" && existsSync(".env")) process.loadEnvFile(".env");

const TEST_FLAGS = {
  cloud: { type: "string" },
  runs: { type: "string", default: "1" },
  /** Only these scenarios (file names without .yaml, comma-separated); every tool file still goes. */
  only: { type: "string" },
  synthetic: { type: "boolean", default: false },
  "agent-version": { type: "string", default: process.env.GITHUB_SHA },
  ref: { type: "string", default: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME },
  environment: { type: "string" },
  "agent-url": { type: "string" },
  channel: { type: "string" },
  "agent-timeout": { type: "string", default: "60" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", default: false },
} as const satisfies ParseArgsOptionsConfig;

const { values, positionals } = parseCommandLine();
const [command, ...rest] = positionals;

if (values.version) {
  console.log(JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version);
  process.exit(0);
}
if (values.help || process.argv.length <= 2) {
  console.log(command === "new" ? NEW_USAGE : command === "test" ? TEST_USAGE : USAGE);
  process.exit(0);
}

if (command === "new") {
  const name = rest.length === 1 ? rest[0]! : "";
  try {
    newStandalone(name);
  } catch (error) {
    console.error(name ? (error as Error).message : "Usage: chinwag new <name>");
    process.exit(1);
  }
  console.log(`Made ./${name}/ from the café example (Pip). Next:
  1. cd ${name} && npm install
  2. Add one model key: cp .env.example .env; the file says where to make one
  3. npm start, then open the link it prints
  4. Tell your coding agent what to build: its skills are in .claude/skills/`);
  process.exit(0);
}

if (command !== undefined && (command !== "test" || rest.length)) {
  console.error(`chinwag: unknown command "${positionals.join(" ")}".\n\n${USAGE}`);
  process.exit(1);
}

const runs = checkRuns(values.runs);
const cloud = values.cloud || process.env.CHINWAG_CLOUD || OBSERVE_URL;
const ciKey = process.env.CHINWAG_CLOUD_KEY || undefined;

let openHeaders: Record<string, string>;
try {
  openHeaders = cloudHeaders({
    cloud,
    ciKey,
    synthetic: values.synthetic!,
    agentVersion: values["agent-version"] || undefined,
    ref: values.ref || undefined,
    environment: values.environment,
  });
} catch (error) {
  const where = !ciKey && cloud.replace(/\/+$/, "") === OBSERVE_URL ? ` Make a key at ${OBSERVE_URL}: your agent, Developers.` : "";
  console.error(`${(error as Error).message}${where}`);
  process.exit(1);
}

const dir = process.cwd();
const agentUrl = values["agent-url"];
if (!agentUrl && values.channel) {
  console.error("--channel goes with --agent-url.");
  process.exit(1);
}
// The package name keeps the agent's history together; an agent tested by its URL may have none.
const packageJson = join(dir, "package.json");
const name = (existsSync(packageJson) ? (JSON.parse(readFileSync(packageJson, "utf8")) as { name?: string }).name : undefined) ?? (agentUrl ? basename(dir) : "agent");
// The agent's name for people: the first heading of its prompt (agent/AGENTS.md), such as "Pip".
const prompt = join(dir, "agent/AGENTS.md");
const title = existsSync(prompt) ? /^#\s+(.+)$/m.exec(readFileSync(prompt, "utf8"))?.[1]?.trim() : undefined;

let agent: Pick<ConnectOptions, "tools" | "build">;
if (agentUrl) {
  const timeout = Number(values["agent-timeout"]);
  if (!/^https?:\/\/[^/]/.test(agentUrl) || !URL.canParse(agentUrl)) {
    console.error("--agent-url must be an http:// or https:// URL, such as http://localhost:3000/chinwag.");
    process.exit(1);
  }
  if (!(timeout > 0)) {
    console.error("--agent-timeout must be a number of seconds above 0.");
    process.exit(1);
  }
  const token = process.env.CHINWAG_AGENT_TOKEN || undefined;
  agent = { tools: [], build: ({ events }) => httpAgent({ url: agentUrl, token, channel: values.channel, timeoutMs: timeout * 1000, events }) };
} else {
  if (!existsSync(join(dir, "src/agent.ts"))) {
    console.error(`No src/agent.ts in ${dir}. Run chinwag test from your agent's folder, where src/agent.ts exports buildAgent({ model, events, tools }) and tools, or pass --agent-url to test an agent on another framework by its HTTP endpoint.`);
    process.exit(1);
  }
  const module = await import(pathToFileURL(join(dir, "src/agent.ts")).href);
  if (typeof module.buildAgent !== "function" || !Array.isArray(module.tools)) {
    console.error("src/agent.ts must export buildAgent({ model, events, tools }) and tools, or pass --agent-url to test an agent by its HTTP endpoint.");
    process.exit(1);
  }
  agent = { tools: module.tools, build: ({ tools, events }) => module.buildAgent({ tools, events }) };
}

/** With --agent-url the agent's own tools run for real: the suite's tool simulators do not apply. */
function forUrl(files: ReturnType<typeof loadSuite>) {
  if (!agentUrl) return files;
  const toolFiles = files.filter((f) => f.path.startsWith("tools/"));
  if (toolFiles.length) console.warn(`Not sent: ${toolFiles.map((f) => f.path).join(", ")}. Tool simulators play a Chinwag agent's tools; your agent's own tools run for real.`);
  for (const f of files.filter((f) => f.path.startsWith("scenarios/"))) {
    const scenario = parseScenario(f); // checkSuite has read it already
    if (scenario.world || scenario.expect.outcome?.length) {
      console.warn(`${scenario.id}: its world and outcome checks are for simulated tools; your agent's tools run on its side, so the judge sees no tool calls. Running it anyway.`);
    }
  }
  return files.filter((f) => !f.path.startsWith("tools/"));
}

function only(files: ReturnType<typeof loadSuite>) {
  if (!values.only) return files;
  const ids = new Set(values.only.split(",").map((s) => s.trim()));
  const kept = files.filter((f) => !f.path.startsWith("scenarios/") || ids.has(f.path.slice("scenarios/".length, -".yaml".length)));
  const missing = [...ids].filter((id) => !kept.some((f) => f.path === `scenarios/${id}.yaml`));
  if (missing.length) {
    console.error(`No scenario named ${missing.join(", ")}.`);
    process.exit(1);
  }
  return kept;
}

const usd = (n: number) => `$${n.toFixed(4)}`;
const printRun = runPrinter();
const chosen = only(loadSuite(join(dir, "tests")));
checkSuite(chosen);
const files = forUrl(chosen);
if (agentUrl) await checkAgentReachable(agentUrl);
const perScenario = runs;
const expected = expectedRuns(files, perScenario);
const seen: RunSummary[] = [];
let dashboard = "";

function reportStop(done: RunSummary[], reason: string, link: string) {
  for (const run of done) printRun(run);
  console.error(`${done.length} of ${expected} runs finished before: ${reason}`);
  if (link) console.error(link);
}

process.on("SIGINT", () => {
  reportStop(seen, "interrupted", dashboard);
  if (dashboard) console.error(`the cloud keeps playing; stop it from the dashboard: ${dashboard}`);
  process.exit(130);
});

let summary: Awaited<ReturnType<typeof runInCloud>>;
try {
  summary = await runInCloud({
    cloud,
    name,
    title,
    ...agent,
    files,
    testsDir: join(dir, "tests"),
    runs: perScenario,
    openHeaders,
    onRun: (run) => { seen.push(run); printRun(run); },
    onDashboard: (url) => { dashboard = url; },
  });
} catch (error) {
  if (error instanceof SessionStopped) {
    reportStop(error.runs, stoppedReason(error, cloud), error.dashboard || dashboard);
    process.exit(2);
  }
  console.error(stoppedReason(error, cloud));
  process.exit(1);
}

console.log("");
for (const r of summary.runs) printRun(r);
const passed = summary.runs.filter((r) => r.passed).length;
const total = (pick: (r: (typeof summary.runs)[number]) => number) => summary.runs.reduce((n, r) => n + pick(r), 0);
const agentModels = [...new Set(summary.runs.flatMap((r) => r.agentModels))].join(", ") || "unknown";
const noModel = summary.runs.filter((r) => r.agentModels.length === 0 && r.agentUsage.input + r.agentUsage.output === 0).length;
const checkFails = summary.runs.filter((r) => r.checks.some((c) => !c.pass)).length;
console.log(`\n${passed} of ${summary.runs.length} runs passed. ${noModel} received no agent model call. ${checkFails} failed a check. Agent: ${agentModels}; person, tools and judge: ${summary.testModel}.`);
for (const channel of [...new Set(summary.runs.map((r) => r.channel))]) {
  const runs = summary.runs.filter((r) => r.channel === channel);
  console.log(`  ${channel}: ${runs.filter((r) => r.passed).length} of ${runs.length} passed`);
}
console.log(`Cost: ${usd(total((r) => r.agentUsage.costUsd))} agent (${total((r) => r.agentUsage.input).toLocaleString()} in, ${total((r) => r.agentUsage.output).toLocaleString()} out) + ${usd(total((r) => r.testUsage.costUsd))} test models.\n${summary.dashboard}`);
process.exit(passed === summary.runs.length ? 0 : 1);

/** Scenarios actually sent, times the channels each one plays, times --runs. */
function expectedRuns(sent: ReturnType<typeof loadSuite>, runs: number): number {
  if (!(runs > 0)) return 0;
  let count = 0;
  for (const file of sent) {
    if (!file.path.startsWith("scenarios/")) continue;
    count += parseScenario(file).channels.length * runs;
  }
  return count;
}

/** Why the session stopped or never opened; a network failure names the address and its code. */
function stoppedReason(error: unknown, cloud: string): string {
  const code = networkCode(error);
  if (!code) return error instanceof Error ? error.message : String(error);
  return `Could not reach ${cloud}: ${code}.`;
}

/** The connection's error code, from the error or what caused it. */
function networkCode(error: unknown): string | undefined {
  let current = error;
  for (let guard = 0; current instanceof Error && guard < 6; guard++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ETIMEDOUT" || code === "ECONNRESET") return code;
    for (const inner of current instanceof AggregateError ? current.errors : []) {
      const innerCode = networkCode(inner);
      if (innerCode) return innerCode;
    }
    current = current.cause;
  }
  return undefined;
}

/** The command's flags, or exits 1 with what is wrong and that command's usage. */
function parseCommandLine() {
  const isNew = process.argv[2] === "new";
  const options = isNew ? { help: TEST_FLAGS.help, version: TEST_FLAGS.version } : TEST_FLAGS;
  try {
    return parseArgs({ allowPositionals: true, strict: true, options: options as typeof TEST_FLAGS });
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    const unknown = code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /'([^']+)'/.exec(message)?.[1] : undefined;
    const usage = isNew ? NEW_USAGE : process.argv[2] === "test" ? TEST_USAGE : USAGE;
    console.error(`chinwag: ${unknown ? `unknown option ${unknown}` : message.split(". ")[0]}\n\n${usage}`);
    process.exit(1);
  }
}

/** --runs as a whole number above 0, or exits 1. */
function checkRuns(runs: string): number {
  if (/^[1-9]\d*$/.test(runs)) return Number(runs);
  console.error(`--runs must be a whole number above 0, such as 3 (got "${runs}").`);
  process.exit(1);
}

/** Every scenario and tool file read as the cloud reads it, before anything is sent; exits 1 with each problem at its line. */
function checkSuite(sent: ReturnType<typeof loadSuite>): void {
  const problems: string[] = [];
  for (const file of sent) {
    const named = { path: join("tests", file.path), content: file.content };
    try {
      if (file.path.startsWith("scenarios/")) parseScenario(named);
      else if (!agentUrl) parseToolFile(named);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (!problems.length) return;
  console.error(`${problems.join("\n")}\n\nNothing was sent: fix the test files above.`);
  process.exit(1);
}

/** One HEAD request to the agent's URL, which a turn never is: any HTTP answer means it is listening. */
async function checkAgentReachable(url: string): Promise<void> {
  const request = url.startsWith("https:") ? httpsRequest : httpRequest;
  const problem = await new Promise<string | undefined>((resolve) => {
    const req = request(url, { method: "HEAD", agent: false, timeout: 10_000 }, (response) => {
      response.resume();
      resolve(undefined);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("no answer in 10 s"), { code: "ETIMEDOUT" })));
    req.on("error", (error) => resolve(networkCode(error) ?? error.message));
    req.end();
  });
  if (!problem) return;
  console.error(`Could not reach your agent at ${url}: ${problem}. Start it first, or check --agent-url.`);
  process.exit(1);
}

/** Chinwag runs agents' TypeScript as it is, which needs Node 22.18 or newer. */
function checkNode(version: string): void {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 18)) return;
  console.error(`Chinwag needs Node 22.18 or newer (you have ${version}).`);
  process.exit(1);
}
