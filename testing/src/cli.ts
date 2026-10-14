#!/usr/bin/env node
// The chinwag command. `chinwag new <name>` makes ./<name>/, an agent started from the café example
// (testing/src/new.ts). `chinwag test`, or `chinwag` with flags, runs an agent's tests in the cloud,
// from the agent's folder:
//   chinwag test --cloud http://127.0.0.1:8900 [--runs 3] [--only late-order,refund]
// A hosted cloud (any --cloud off this machine, such as https://tests.example.com) needs the
// agent's CI key in CHINWAG_CLOUD_KEY and --synthetic, the attestation that the test files hold no real
// customer or member data. --agent-version (else GITHUB_SHA), --ref (else GitHub's branch) and
// --environment (staging or production) are kept with the session.
// The agent's src/agent.ts exports buildAgent({ model, events, tools }) and its tools; its tests are
// in tests/scenarios and tests/tools.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { cloudHeaders, runInCloud } from "./client.ts";
import { newStandalone } from "./new.ts";
import { loadSuite } from "./suite.ts";

const USAGE = `Usage:
  chinwag new <name>        Make ./<name>/, a new agent started from the café example
  chinwag test [options]    Run the agent's tests in a test cloud, from the agent's folder
                            (src/agent.ts exports buildAgent({ model, events, tools }) and tools;
                            the tests are in tests/scenarios and tests/tools)

Options for test:
  --cloud <url>            The test cloud (default: CHINWAG_CLOUD, else http://127.0.0.1:8900)
  --runs <n>               Runs per scenario (default: 1)
  --only <ids>             Only these scenarios, comma-separated (file names without .yaml)
  --synthetic              Attest the test files hold no real customer data (a hosted cloud needs it)
  --agent-version <v>      Kept with the session (default: GITHUB_SHA)
  --ref <ref>              Kept with the session (default: GitHub's branch)
  --environment <name>     staging or production, kept with the session
  -h, --help               Show this help

Environment (also read from the agent folder's .env; variables already set win):
  CHINWAG_CLOUD            The test cloud, when --cloud is not given
  CHINWAG_CLOUD_KEY        The agent's CI key, for a hosted cloud`;

// The agent folder's .env (its model key, CHINWAG_CLOUD_KEY), when there is one; variables already
// set win over the file, and no value is ever printed.
if (process.argv[2] !== "new" && existsSync(".env")) process.loadEnvFile(".env");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cloud: { type: "string", default: process.env.CHINWAG_CLOUD ?? "http://127.0.0.1:8900" },
    runs: { type: "string", default: "1" },
    /** Only these scenarios (file names without .yaml, comma-separated); every tool file still goes. */
    only: { type: "string" },
    synthetic: { type: "boolean", default: false },
    "agent-version": { type: "string", default: process.env.GITHUB_SHA },
    ref: { type: "string", default: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME },
    environment: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});
const [command, ...rest] = positionals;

if (values.help || process.argv.length <= 2) {
  console.log(USAGE);
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
  2. Add your key: cp .env.example .env, then put your OpenRouter key in it
  3. npm start, then open the link it prints
  4. Tell your coding agent what to build: its skills are in .claude/skills/`);
  process.exit(0);
}

if (command !== undefined && (command !== "test" || rest.length)) {
  console.error(`chinwag: unknown command "${positionals.join(" ")}".\n\n${USAGE}`);
  process.exit(1);
}

let openHeaders: Record<string, string>;
try {
  openHeaders = cloudHeaders({
    cloud: values.cloud!,
    ciKey: process.env.CHINWAG_CLOUD_KEY || undefined,
    synthetic: values.synthetic!,
    agentVersion: values["agent-version"] || undefined,
    ref: values.ref || undefined,
    environment: values.environment,
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const dir = process.cwd();
const name = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string }).name ?? "agent";
// The agent's name for people: the first heading of its prompt (agent/AGENTS.md), such as "Pip".
const prompt = join(dir, "agent/AGENTS.md");
const title = existsSync(prompt) ? /^#\s+(.+)$/m.exec(readFileSync(prompt, "utf8"))?.[1]?.trim() : undefined;
const module = await import(pathToFileURL(join(dir, "src/agent.ts")).href);
if (typeof module.buildAgent !== "function" || !Array.isArray(module.tools)) {
  console.error("src/agent.ts must export buildAgent({ model, events, tools }) and tools.");
  process.exit(1);
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

const summary = await runInCloud({
  cloud: values.cloud!,
  name,
  title,
  tools: module.tools,
  build: ({ tools, events }) => module.buildAgent({ tools, events }),
  files: only(loadSuite(join(dir, "tests"))),
  testsDir: join(dir, "tests"),
  runs: Number(values.runs),
  openHeaders,
});

const usd = (n: number) => `$${n.toFixed(4)}`;
console.log("");
for (const r of summary.runs) {
  console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.scenario} #${r.run} (${r.channel}): ${r.turns} turns, ended: ${r.ended}; slowest acknowledgement ${r.slowestAckMs === null ? "never" : `${r.slowestAckMs} ms`}; cost ${usd(r.agentUsage.costUsd)} agent + ${usd(r.testUsage.costUsd)} test`);
  for (const c of r.checks.filter((c) => !c.pass)) console.log(`      ✗ ${c.kind}: ${c.text}\n        ${c.reason}`);
  console.log(`      watch: ${r.watch}`);
}
const passed = summary.runs.filter((r) => r.passed).length;
const total = (pick: (r: (typeof summary.runs)[number]) => number) => summary.runs.reduce((n, r) => n + pick(r), 0);
const agentModels = [...new Set(summary.runs.flatMap((r) => r.agentModels))].join(", ") || "unknown";
console.log(`\n${passed} of ${summary.runs.length} runs passed. Agent: ${agentModels}; person, tools and judge: ${summary.testModel}.`);
for (const channel of [...new Set(summary.runs.map((r) => r.channel))]) {
  const runs = summary.runs.filter((r) => r.channel === channel);
  console.log(`  ${channel}: ${runs.filter((r) => r.passed).length} of ${runs.length} passed`);
}
console.log(`Cost: ${usd(total((r) => r.agentUsage.costUsd))} agent (${total((r) => r.agentUsage.input).toLocaleString()} in, ${total((r) => r.agentUsage.output).toLocaleString()} out) + ${usd(total((r) => r.testUsage.costUsd))} test models.\n${summary.dashboard}`);
process.exit(passed === summary.runs.length ? 0 : 1);
