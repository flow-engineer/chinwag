// covers: testing/src/print-run.ts testing/src/cli.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { runPrinter } from "../testing/src/print-run.ts";
import type { RunSummary } from "../testing/src/protocol.ts";

const run = (extra: Partial<RunSummary> = {}): RunSummary => ({
  runId: "run_1",
  scenario: "s",
  run: 1,
  channel: "sms",
  passed: true,
  checks: [],
  ended: "goal_met",
  turns: 1,
  messagesIn: 1,
  messagesOut: 1,
  toolCalls: 0,
  slowestAckMs: 10,
  agentUsage: { input: 0, output: 0, costUsd: 0 },
  agentModels: [],
  testUsage: { input: 0, output: 0, costUsd: 0 },
  watch: "https://example.test/watch",
  ...extra,
});

test("a run is printed once when it finishes, and not again with the summary", () => {
  const lines: string[] = [];
  const print = runPrinter((line) => lines.push(line));
  print(run());
  print(run());
  const passes = lines.filter((line) => line.startsWith("PASS"));
  assert.equal(passes.length, 1);
});

test("a run's line names its id, for chinwag show", () => {
  const lines: string[] = [];
  runPrinter((line) => lines.push(line))(run({ passed: false, runId: "trn_ABC", turns: 6 }));
  assert.match(lines[0], /^FAIL {2}s #1 \(sms\) trn_ABC: 6 turns, ended: goal_met;/);
});

test("a retry is named on the line", () => {
  const lines: string[] = [];
  runPrinter((line) => lines.push(line))(run({ retried: true }));
  assert.match(lines[0], /tried once more/);
});

test("a run the cloud names an error for prints ERROR with its code, even when it ended goal_met, and not its checks", () => {
  const lines: string[] = [];
  const checks = [{ kind: "judge", text: "Asks to confirm.", pass: false, reason: "not judged" }] as RunSummary["checks"];
  runPrinter((line) => lines.push(line))(run({ passed: false, ended: "goal_met", error: "judge_failed", checks }));
  assert.match(lines[0], /^ERROR {2}s #1 \(sms\) run_1: 1 turn, ended: goal_met; error: judge_failed \(the cloud could not play or judge this run, not the agent's fault\);/);
  assert.equal(lines.some((line) => line.includes("not judged")), false);
  const failed: string[] = [];
  runPrinter((line) => failed.push(line))(run({ passed: false, ended: "run_failed" }));
  assert.match(failed[0], /^ERROR .*error: run_failed/);
});
