// `chinwag show <run-id|watch-link|last>`: one run's full record from the test cloud (the transcript, the tool
// calls the simulator played, every check with the judge's reason), so a coding agent can read why a
// run failed without a browser. The agent's id comes from .chinwag/last-session.json (or the run's
// watch link), and the read carries the agent's CI key: GET {cloud}/v1/agents/{agent}/tests/runs/{run}.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { OBSERVE_URL } from "../../src/traces.ts";
import { loadEnv } from "./report.ts";

/** Where every session's results go, in the agent's folder; `chinwag new` git-ignores .chinwag/. */
export const LAST_SESSION = join(".chinwag", "last-session.json");

/** .chinwag/last-session.json: what each run ended as, for `--failed`, `chinwag show` and coding agents. */
export interface LastSession {
  sessionId: string;
  /** The cloud's id for the agent, from the open (an older cloud names none). */
  agent?: string;
  dashboard: string;
  suiteHash: string;
  /** When the session ended, as an ISO time. */
  endedAt: string;
  ended: "finished" | "stopped" | "interrupted";
  /** The scenarios this session was limited to (--only, --failed); null when it ran the whole suite. */
  only: string[] | null;
  runs: Array<{
    /** The scenario's file name without .yaml, as --only takes it. */
    scenario: string;
    channel: string;
    run: number;
    /** The cloud's id for the run, for `chinwag show`; null when it was not played. */
    runId?: string | null;
    verdict: "passed" | "failed" | "errored" | "not_played";
    /** The checks as the test file says them, with the judge's reason. The file is local and
     * git-ignored, and the suite is synthetic by attestation; the messages themselves are never kept. */
    failedChecks: Array<{ kind: string; text: string; reason?: string }>;
  }>;
}

export const SHOW_LINE = `  chinwag show <run-id|watch-link|last> [--json]
                            Print one run's record from the test cloud: its checks with the
                            judge's reasons, the transcript and the tool calls (chinwag show --help)`;

const SHOW_USAGE = `Usage:
  chinwag show <run-id|watch-link|last> [options]

Prints one run of the last \`chinwag test\` (or any run of this agent, by the id on its PASS or
FAIL line, or by its watch link, which needs no last session): verdict, every check with the judge's reason, then the conversation in time order with
each tool call the simulator played and what it changed. \`last\` is the first run that did not
pass in .chinwag/last-session.json (its first run when all passed).

Options:
  --json                   The record exactly as the cloud answered it, on stdout
  --cloud <url>            The test cloud (default: CHINWAG_CLOUD, else https://flow.engineer/observe)
  --dotenv <path>          Read the environment from this file instead of the folder's .env
  -h, --help               Show this help

Needs CHINWAG_CLOUD_KEY (the agent's CI key, also read from .env), and, unless given a watch link
on that cloud, the agent's id that \`chinwag test\` keeps in .chinwag/last-session.json.

Exit status:
  0    Printed
  1    A wrong flag, no key or last session, no such run (404), or past the 30 days a run is kept (410)
  2    The cloud did not answer, answered 5xx, or answered something that is not a run's record
  3    The cloud refused the key (401, 403) or is busy (429)`;

/** A run's record as the cloud answers it; only what the text view reads. */
interface RunRecord {
  runId?: string;
  scenario?: { id?: string; path?: string; title?: string };
  run?: number;
  channel?: string;
  startedAt?: number;
  transcript?: Line[];
  toolCalls?: Array<{ tool?: string; input?: unknown; ok?: boolean; output?: unknown; error?: unknown; latencyMs?: number; changes?: string[]; kind?: string; at?: number }>;
  checks?: Array<{ kind?: string; text?: string; pass?: boolean; reason?: string }>;
  error?: unknown;
  detail?: unknown;
  summary?: { passed?: boolean; ended?: string; turns?: number; watch?: string; error?: string };
}

type Line =
  | { kind: "in"; id?: string; text?: string; at?: number; attachments?: unknown[] }
  | { kind: "out"; id?: string; text?: string; at?: number; buttons?: unknown; list?: unknown; link?: unknown; image?: unknown; template?: unknown }
  | { kind: "reaction"; messageId?: string; emoji?: string; at?: number; by?: string };

/** `chinwag show`: returns the exit status. */
export async function showCli(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      json: { type: "boolean", default: false },
      cloud: { type: "string" },
      dotenv: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    } });
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    const unknown = code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /'([^']+)'/.exec(message)?.[1] : undefined;
    console.error(`chinwag: ${unknown ? `unknown option ${unknown}` : message.split(". ")[0]}\n\n${SHOW_USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(SHOW_USAGE);
    return 0;
  }
  if (positionals.length !== 1) {
    console.error(`chinwag show takes one run id, or last.\n\n${SHOW_USAGE}`);
    return 1;
  }
  const envProblem = loadEnv(values.dotenv);
  if (envProblem) {
    console.error(envProblem);
    return 1;
  }
  const cloud = (values.cloud || process.env.CHINWAG_CLOUD || OBSERVE_URL).replace(/\/+$/, "");
  const key = process.env.CHINWAG_CLOUD_KEY || undefined;
  if (!key) {
    console.error(`chinwag show reads the run with the agent's CI key: set CHINWAG_CLOUD_KEY.${cloud === OBSERVE_URL ? ` Make a key at ${OBSERVE_URL}: your agent, Developers.` : ""}`);
    return 1;
  }
  let runId = positionals[0]!;
  let agent: string;
  const link = /^(https?:\/\/.+)\/agents\/([A-Za-z0-9_-]{1,100})\/tests\/runs\/([A-Za-z0-9_-]{1,100})\/?$/.exec(runId);
  if (link) {
    // A run's watch link names its agent, so it needs no last session (CI, a teammate's link). The
    // key goes only to the configured cloud, never to a host a pasted link names.
    if (link[1] !== cloud) {
      console.error(`That link is not on ${cloud}, the cloud chinwag show reads with your key: pass --cloud ${link[1]} if it is yours.`);
      return 1;
    }
    agent = link[2]!;
    runId = link[3]!;
  } else {
    const last = readLast();
    if (typeof last === "string") {
      console.error(last);
      return 1;
    }
    if (runId === "last") {
      const pickedRun = pickLast(last);
      if (!pickedRun) {
        console.error(`${LAST_SESSION} has no run ids: run chinwag test again, then chinwag show last.`);
        return 1;
      }
      runId = pickedRun;
    }
    agent = last.agent!;
  }
  const id = /^[A-Za-z0-9_-]{1,100}$/;
  if (!id.test(runId)) {
    console.error(`"${runId}" is not a run id: use the id on a run's PASS or FAIL line (trn_...), its watch link, or last.`);
    return 1;
  }
  if (!id.test(agent)) {
    console.error(`${LAST_SESSION} names an agent id that is not one: run chinwag test again.`);
    return 1;
  }
  const url = `${cloud}/v1/agents/${agent}/tests/runs/${runId}`;
  let status: number;
  let text: string;
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    status = response.status;
    text = await response.text();
  } catch (error) {
    const cause = (error as Error).cause as NodeJS.ErrnoException | undefined;
    const why = (error as Error).name === "TimeoutError" ? "no answer in 30 s" : cause?.code ?? (error as Error).message;
    console.error(`Could not reach ${cloud}: ${why}.`);
    return 2;
  }
  if (status < 200 || status >= 300) return refused(status, text, runId);
  let record: RunRecord;
  try {
    record = JSON.parse(text) as RunRecord;
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("not an object");
  } catch {
    console.error(`The cloud's answer for ${runId} was not a run's record (${status}).`);
    return 2;
  }
  if (values.json) process.stdout.write(text);
  else console.log(render(record, runId).join("\n"));
  return 0;
}

/** The last session's results, or what to do when there are none or they name no agent. */
function readLast(): LastSession | string {
  const path = join(process.cwd(), LAST_SESSION);
  if (!existsSync(path)) return `No ${LAST_SESSION} in ${process.cwd()}: run chinwag test first; chinwag show reads the agent's id from it.`;
  let last: LastSession;
  try {
    last = JSON.parse(readFileSync(path, "utf8")) as LastSession;
    if (!Array.isArray(last.runs)) throw new Error("it has no runs");
  } catch (error) {
    return `${LAST_SESSION} could not be read (${(error as Error).message}): run chinwag test again.`;
  }
  if (!last.agent) return `${LAST_SESSION} has no agent id: run chinwag test once more against a current cloud, which names it, then chinwag show.`;
  return last;
}

/** The first run that did not pass, else the first run; says which on stderr and names the others that did not pass. */
function pickLast(last: LastSession): string | undefined {
  const withId = last.runs.filter((r) => r.runId);
  const notPassed = withId.filter((r) => r.verdict === "failed" || r.verdict === "errored");
  const chosen = notPassed[0] ?? withId[0];
  if (!chosen) return undefined;
  console.error(`Showing ${chosen.scenario} #${chosen.run} (${chosen.channel}), ${chosen.verdict}: ${chosen.runId}`);
  for (const r of notPassed.slice(1)) console.error(`  also did not pass: chinwag show ${r.runId}   (${r.scenario} #${r.run}, ${r.channel}, ${r.verdict})`);
  return chosen.runId!;
}

/** The cloud's refusal on stderr, and its exit status. */
function refused(status: number, text: string, runId: string): number {
  let error: { type?: string; message?: string; hint?: string } | undefined;
  try {
    const body = (JSON.parse(text) as { error?: unknown }).error;
    error = typeof body === "string" ? { type: body } : (body as typeof error);
  } catch { /* the body was not JSON */ }
  const said = (error?.type ? `${error.type}${error.message ? `: ${error.message}` : ""}` : text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 180)).replace(/\.$/, "");
  const meaning = status === 404 ? ` No run ${runId} for this agent.` : status === 410 ? ` Run ${runId} is past the 30 days the cloud keeps runs.` : "";
  console.error(`The cloud answered ${status}${said ? ` ${said}` : ""}.${meaning}${error?.hint ? `\n${error.hint}` : ""}`);
  if (status === 401 || status === 403 || status === 429) return 3;
  if (status >= 500 || !error) return 2;
  return 1;
}

/** At most `max` characters of a value as JSON. */
function brief(value: unknown, max = 300): string {
  const json = value === undefined ? "" : typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

/** The labels a button row or a list shows, whatever shape the record keeps them in. */
function labels(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(labels);
  if (!value || typeof value !== "object") return [];
  const o = value as Record<string, unknown>;
  for (const field of ["title", "label", "text"]) if (typeof o[field] === "string") return [o[field] as string];
  return [...labels(o.sections), ...labels(o.rows)];
}

/** The run as text: header, checks (failed first), the conversation and tool calls in time order, then detail and the watch link. */
function render(record: RunRecord, runId: string): string[] {
  const out: string[] = [];
  const s = record.summary ?? {};
  const checks = record.checks ?? [];
  const passed = s.passed ?? (checks.length > 0 && checks.every((c) => c.pass));
  // An error (judge_failed, spend_cap, ...) or run_failed: the cloud could not play or judge the run.
  const error = record.error ?? s.error;
  const verdict = error || s.ended === "run_failed" ? "ERROR" : passed ? "PASS" : "FAIL";
  const where = record.scenario?.path ?? record.scenario?.id ?? "?";
  out.push(`${verdict}  ${where}${record.scenario?.title ? ` (${record.scenario.title})` : ""}`);
  out.push(`  channel ${record.channel ?? "?"}, run ${record.run ?? "?"}, ${record.runId ?? runId}; ended: ${s.ended ?? "?"}${s.turns === undefined ? "" : `, ${s.turns} turn${s.turns === 1 ? "" : "s"}`}`);
  if (error) out.push(`  error: ${typeof error === "string" ? error : brief(error)} (the cloud could not play or judge this run; it says nothing about the agent)`);
  if (checks.length) {
    out.push("", "Checks:");
    for (const c of [...checks.filter((c) => !c.pass), ...checks.filter((c) => c.pass)]) {
      out.push(`  ${c.pass ? "✓" : "✗"} ${c.kind ?? "check"}: ${c.text ?? ""}`);
      if (c.reason) out.push(...indent(c.reason, "      "));
    }
  }
  const start = record.startedAt ?? Math.min(...(record.transcript ?? []).map((l) => l.at ?? Infinity), ...(record.toolCalls ?? []).map((t) => t.at ?? Infinity));
  const when = (at: number | undefined) => (at === undefined || !Number.isFinite(start) ? "        " : `+${((at - start) / 1000).toFixed(1)}s`.padStart(8));
  const items: Array<{ at: number; order: number; lines: string[] }> = [];
  for (const line of record.transcript ?? []) {
    const t = when(line.at);
    let lines: string[];
    if (line.kind === "in") {
      const files = (line.attachments ?? []).map((a) => {
        const f = a as { kind?: string; file?: string; name?: string };
        return `[${f.kind ?? "file"}: ${f.file ?? f.name ?? "attached"}]`;
      });
      lines = indent([line.text ?? "", ...files].filter(Boolean).join(" "), `${t} person: `, " ".repeat(t.length + 9));
    } else if (line.kind === "out") {
      const extra: string[] = [];
      const buttons = labels(line.buttons);
      if (buttons.length) extra.push(`[buttons: ${buttons.join(" | ")}]`);
      const list = labels(line.list);
      if (list.length) extra.push(`[list: ${list.join(" | ")}]`);
      if (line.link) extra.push(`[link: ${typeof line.link === "string" ? line.link : (line.link as { url?: string }).url ?? brief(line.link, 120)}]`);
      if (line.image) extra.push("[image]");
      if (line.template) extra.push(`[template: ${typeof line.template === "string" ? line.template : (line.template as { name?: string }).name ?? brief(line.template, 120)}]`);
      lines = indent([line.text ?? "", ...extra].filter(Boolean).join(" "), `${t} agent: `, " ".repeat(t.length + 8));
    } else if (line.kind === "reaction") {
      lines = [`${t} ${line.by ?? "someone"} reacted ${line.emoji ?? "?"} to ${line.messageId ?? "a message"}`];
    } else continue;
    items.push({ at: line.at ?? Infinity, order: items.length, lines });
  }
  for (const call of record.toolCalls ?? []) {
    const t = when(call.at);
    const result = call.ok === false ? `error: ${typeof call.error === "string" ? call.error : brief(call.error)}` : brief(call.output);
    const notes = [call.kind, "simulated", call.latencyMs === undefined ? undefined : `${call.latencyMs} ms`].filter(Boolean).join(", ");
    const lines = [`${t} tool ${call.tool ?? "?"}(${brief(call.input)}) → ${result} [${notes}]`];
    for (const change of call.changes ?? []) lines.push(`${" ".repeat(t.length)}   changes: ${change}`);
    items.push({ at: call.at ?? Infinity, order: items.length, lines });
  }
  items.sort((a, b) => a.at - b.at || a.order - b.order);
  if (items.length) out.push("", "Conversation:", ...items.flatMap((i) => i.lines));
  if (record.detail !== undefined && record.detail !== null && record.detail !== "") {
    out.push("", ...indent(typeof record.detail === "string" ? record.detail : JSON.stringify(record.detail, null, 2), "Detail: ", "  "));
  }
  if (s.watch) out.push("", `Watch: ${s.watch}`);
  return out;
}

/** Text over several lines: the first after `first`, the rest after `rest`. */
function indent(text: string, first: string, rest = first): string[] {
  return text.split("\n").map((line, i) => `${i === 0 ? first : rest}${line}`);
}
