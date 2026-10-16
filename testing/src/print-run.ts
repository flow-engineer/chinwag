import type { RunSummary } from "./protocol.ts";
import { runVerdict } from "./report.ts";

const usd = (n: number) => `$${n.toFixed(4)}`;

/** Prints each run once. A run already shown as it finished is not printed again with the summary. */
export function runPrinter(log: (line: string) => void = console.log): (run: RunSummary) => void {
  const printed = new Set<string>();
  return (r) => {
    if (printed.has(r.runId)) return;
    printed.add(r.runId);
    const verdict = runVerdict(r);
    const gaveUp = verdict === "passed" && r.ended === "gave_up" ? " (passed, the person gave up)" : "";
    const retried = r.retried ? "; tried once more" : "";
    // An errored run: the cloud could not play or judge it, so its checks say nothing about the agent.
    const error = verdict === "errored" ? `; error: ${r.error ?? r.ended} (the cloud could not play or judge this run, not the agent's fault)` : "";
    const label = verdict === "errored" ? "ERROR" : verdict === "passed" ? "PASS" : "FAIL";
    log(`${label}  ${r.scenario} #${r.run} (${r.channel}) ${r.runId}: ${r.turns} turn${r.turns === 1 ? "" : "s"}, ended: ${r.ended}${gaveUp}${retried}${error}; slowest acknowledgement ${r.slowestAckMs === null ? "never" : `${r.slowestAckMs} ms`}; cost ${usd(r.agentUsage.costUsd)} agent + ${usd(r.testUsage.costUsd)} test`);
    if (verdict !== "errored") for (const c of r.checks.filter((c) => !c.pass)) log(`      ✗ ${c.kind}: ${c.text}\n        ${c.reason}`);
    log(`      watch: ${r.watch}`);
  };
}
