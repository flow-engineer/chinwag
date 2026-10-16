// What `chinwag test --json` prints, how an error that stopped a session is classified into an
// outcome and an exit status, and the pieces `chinwag test` and `chinwag show` share.

import { existsSync } from "node:fs";
import { CloudEnded, isTransportFailure, PostError, SessionStopped } from "./client.ts";

/** How a `chinwag test` ended, one per exit status (0 passed; 1 failed, invalid; 2 errored, transport; 3 refused; 130 interrupted). */
export type Outcome = "passed" | "failed" | "errored" | "transport" | "refused" | "interrupted" | "invalid";

export type Verdict = "passed" | "failed" | "errored" | "not_played";

export interface ReportError {
  message: string;
  /** The cloud's HTTP status, when it answered one. */
  status: number | null;
  /** The cloud's code for it, such as spend_cap or rate_limited. */
  type: string | null;
  retryAfterSeconds: number | null;
}

export interface ReportRun {
  runId: string | null;
  /** The scenario's file name without .yaml, as --only takes it. */
  scenario: string;
  channel: string;
  run: number;
  verdict: Verdict;
  ended: string | null;
  turns: number | null;
  watch: string | null;
  failedChecks: Array<{ kind: string; text: string; reason: string }>;
}

/** `chinwag test --json`: one document on stdout, whatever the exit. */
export interface JsonReport {
  version: 1;
  outcome: Outcome;
  exitCode: number;
  sessionId: string | null;
  /** The cloud's id for the agent, which `chinwag show` reads runs under. */
  agent: string | null;
  dashboard: string | null;
  suiteHash: string | null;
  error: ReportError | null;
  counts: { runs: number; passed: number; failed: number; errored: number; notPlayed: number };
  costUsd: { agent: number; test: number };
  runs: ReportRun[];
}

export const EXIT: Record<Outcome, number> = { passed: 0, failed: 1, invalid: 1, errored: 2, transport: 2, refused: 3, interrupted: 130 };

/** A session that ran to its summary: failed when a run failed, errored when the cloud could not play or judge a run (or never played it). */
export function finishedOutcome(runs: Array<{ verdict: Verdict }>): Outcome {
  if (runs.some((r) => r.verdict === "failed")) return "failed";
  if (runs.some((r) => r.verdict !== "passed")) return "errored";
  return "passed";
}

/** What stopped a session, or the open, as an outcome. `opened`: the session had opened. */
export function stoppedOutcome(error: unknown, opened: boolean): Outcome {
  if (error instanceof SessionStopped) return "transport";
  if (error instanceof CloudEnded) return error.code === "spend_cap" || error.code === "capacity" ? "refused" : "errored";
  const refusal = postErrorOf(error);
  if (refusal) {
    const why = refusal.type ?? refusal.code;
    if (refusal.status === 503 && why === "capacity") return "refused";
    if (refusal.status >= 400 && refusal.status < 500 && why) return "refused";
    return "transport";
  }
  if (isTransportFailure(error) || networkCode(error)) return "transport";
  // Something on this machine: the agent would not build before the open, or broke the session after it.
  return opened ? "failed" : "invalid";
}

/** The error as the JSON report says it: the cloud's status, code and Retry-After when it answered. */
export function reportError(error: unknown, message: string): ReportError {
  const refusal = postErrorOf(error);
  const type = refusal ? refusal.type ?? refusal.code ?? null : error instanceof CloudEnded ? error.code ?? null : null;
  const retry = refusal?.retryAfterMs;
  return { message, status: refusal?.status ?? null, type, retryAfterSeconds: retry === undefined ? null : Math.ceil(retry / 1000) };
}

function postErrorOf(error: unknown): PostError | undefined {
  let current = error;
  for (let guard = 0; current instanceof Error && guard < 6; guard++) {
    if (current instanceof PostError) return current;
    current = current.cause;
  }
  return undefined;
}

/** The connection's error code, from the error or what caused it. */
export function networkCode(error: unknown): string | undefined {
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

/** The agent folder's .env, or the --dotenv given; variables already set win, and no value is ever printed.
 * Returns what is wrong when a named file cannot be read. */
export function loadEnv(file: string | undefined): string | undefined {
  if (file === undefined) {
    if (existsSync(".env")) process.loadEnvFile(".env");
    return undefined;
  }
  if (!existsSync(file)) return `--dotenv ${file}: no such file.`;
  try {
    process.loadEnvFile(file);
  } catch (error) {
    return `--dotenv ${file} could not be read: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}.`;
  }
  return undefined;
}
