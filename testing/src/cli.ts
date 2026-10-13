// Run an agent's tests in the cloud, from the agent's folder:
//   node <parley>/testing/src/cli.ts --cloud http://127.0.0.1:8900 [--runs 3] [--only latte-correction,order-fails]
// The agent's src/agent.ts exports buildAgent({ model, events, tools }) and its tools; its tests are
// in tests/scenarios and tests/tools.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runInCloud } from "./client.ts";
import { loadSuite } from "./suite.ts";

const { values } = parseArgs({
  options: {
    cloud: { type: "string", default: process.env.PARLEY_CLOUD ?? "http://127.0.0.1:8900" },
    runs: { type: "string", default: "1" },
    /** Only these scenarios (file names without .yaml, comma-separated); every tool file still goes. */
    only: { type: "string" },
  },
});

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
  runs: Number(values.runs),
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
