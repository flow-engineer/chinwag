import type { RunSummary } from "./protocol.ts";

const usd = (n: number) => `$${n.toFixed(4)}`;

/** Prints each run once. A run already shown as it finished is not printed again with the summary. */
export function runPrinter(log: (line: string) => void = console.log): (run: RunSummary) => void {
  const printed = new Set<string>();
  return (r) => {
    if (printed.has(r.runId)) return;
    printed.add(r.runId);
    const gaveUp = r.passed && r.ended === "gave_up" ? " (passed, the person gave up)" : "";
    const retried = r.retried ? "; tried once more" : "";
    log(`${r.passed ? "PASS" : "FAIL"}  ${r.scenario} #${r.run} (${r.channel}): ${r.turns} turns, ended: ${r.ended}${gaveUp}${retried}; slowest acknowledgement ${r.slowestAckMs === null ? "never" : `${r.slowestAckMs} ms`}; cost ${usd(r.agentUsage.costUsd)} agent + ${usd(r.testUsage.costUsd)} test`);
    for (const c of r.checks.filter((c) => !c.pass)) log(`      ✗ ${c.kind}: ${c.text}\n        ${c.reason}`);
    log(`      watch: ${r.watch}`);
  };
}
