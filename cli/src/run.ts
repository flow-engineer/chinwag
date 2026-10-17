// Runs an organization's CLI on Stricli (@stricli/core, the framework Sentry's CLI is built on):
// command groups whose help lists their subcommands (`acme order`, `acme order -h`), help for every
// command (`acme order place -h`), typo suggestions, typed flags and positional arguments. On top of
// it, the conventions agents and scripts rely on: --json (and --fields) on every tool command,
// --dry-run on anything that changes things, --yes needed without a terminal for what may delete or
// overwrite, and fixed exit codes. The commands come from the server's tools at run time, shaped by
// the CLI file (commands.ts).

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Client, InsufficientScopeError, SdkHttpError, StreamableHTTPClientTransport, UnauthorizedError, type AuthProvider, type OAuthClientProvider } from "@modelcontextprotocol/client";
import { buildApplication, buildCommand, buildRouteMap, numberParser, run as runStricli, type Command as StricliCommand, type RouteMap } from "@stricli/core";
import { isSignedIn, signIn, signOut, storedProvider } from "./auth.ts";
import {
  BUILT_IN,
  commandTable,
  flagKind,
  flagName,
  isCustom,
  skillFile,
  tokenEnvOf,
  typeHint,
  type CliConfig,
  type CliContext,
  type Command,
  type JsonSchema,
  type ToolInfo,
} from "./commands.ts";

export const EXIT = { ok: 0, failed: 1, usage: 2, signIn: 3, approval: 4, unreachable: 5 } as const;

export interface CliIO {
  /** Write to stdout as is. */
  write(text: string): void;
  /** Write to stderr as is. */
  writeError(text: string): void;
  /** Whether a person is at a terminal to answer a question. */
  interactive: boolean;
  /** Ask a yes-or-no question (only when interactive). */
  confirm(question: string): Promise<boolean>;
}

export function processIO(): CliIO {
  return {
    write: (text) => void process.stdout.write(text),
    writeError: (text) => void process.stderr.write(text),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async confirm(question) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
  };
}

/** A failure the CLI reports with its own exit code. */
class CliExit extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Takes `--server` and `--token` out before the commands are known (they decide which commands exist). */
function connectionFlags(argv: string[]): { rest: string[]; server?: string; token?: string } {
  const rest: string[] = [];
  const found: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(server|token)(?:=(.*))?$/.exec(argv[i]!);
    if (!m) rest.push(argv[i]!);
    else found[m[1]!] = m[2] ?? argv[++i] ?? "";
  }
  return { rest, server: found.server, token: found.token };
}

function envName(config: CliConfig, suffix: string): string {
  return `${config.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

function noServer(config: CliConfig): string {
  return `No server: pass --server <url> or set ${envName(config, "SERVER")}.`;
}

/** Run the CLI once; resolves with its exit code. */
export async function runCli(config: CliConfig, argv: string[], io: CliIO = processIO()): Promise<number> {
  const name = config.name;
  const { rest, server: given, token: givenToken } = connectionFlags(argv);
  const server = given ?? config.server ?? process.env[envName(config, "SERVER")];
  const token = givenToken ?? process.env[tokenEnvOf(config)];
  const asksHelp = rest.length === 0 || rest[0] === "-h" || rest[0] === "--help";

  let client: Client | undefined;
  let tools: ToolInfo[] = [];
  let problem: CliExit | undefined;
  if (server && rest[0] !== "auth") {
    try {
      client = await connect(config, server, token);
      tools = await listTools(client);
    } catch (error) {
      problem = explain(config, server, error);
    }
  }
  if (problem && !asksHelp) {
    io.writeError(`${problem.message}\n`);
    return problem.code;
  }

  const stricliProcess = {
    stdout: { write: (text: string) => io.write(text) },
    stderr: { write: (text: string) => io.writeError(text) },
    env: { ...process.env, ...(process.env.NO_COLOR ? { STRICLI_NO_COLOR: "1" } : {}) },
    exitCode: undefined as number | string | null | undefined,
  };
  const context: CliContext = {
    process: stricliProcess,
    cli: {
      call: async (tool, input) => {
        if (!client) throw new CliExit(EXIT.unreachable, noServer(config));
        return valueOf(await client.callTool({ name: tool, arguments: input }));
      },
      print: (value, options = {}) => io.write(`${render(value, options)}\n`),
    },
  };

  try {
    const app = buildApplication(routes(config, server, tools, client, io), {
      name,
      scanner: { caseStyle: "original" },
      determineExitCode: (error) => (error instanceof CliExit ? error.code : needsSignIn(error) ? EXIT.signIn : EXIT.failed),
    });
    await runStricli(app, rest, { ...context, process: stricliProcess });
  } finally {
    await client?.close();
  }
  if (problem) io.writeError(`\n${problem.message}\n`);
  const code = Number(stricliProcess.exitCode ?? 0);
  if (code < 0) {
    // Stricli's own: an unknown command or a wrong argument. Point at the help of what was typed.
    const words = rest.filter((w) => !w.startsWith("-"));
    io.writeError(`Run \`${[name, ...wordsKnown(words, config, tools)].join(" ")} --help\` to see how to use it.\n`);
    return EXIT.usage;
  }
  return code;
}

/** The words of the command line that name a group or command, for the help hint. */
function wordsKnown(words: string[], config: CliConfig, tools: ToolInfo[]): string[] {
  const paths = [...commandTable(config, tools).map((c) => c.words.join(" ")), ...BUILT_IN, "auth login", "auth logout", "auth status"];
  const known: string[] = [];
  for (const w of words) {
    const next = [...known, w].join(" ");
    if (!paths.some((p) => p === next || p.startsWith(`${next} `))) break;
    known.push(w);
  }
  return known;
}

async function connect(config: CliConfig, server: string, token: string | undefined): Promise<Client> {
  const provider: AuthProvider | OAuthClientProvider | undefined = token ? { token: async () => token } : isSignedIn(config, server) ? storedProvider(config, server) : undefined;
  const client = new Client({ name: `${config.name}-cli`, version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server), provider ? { authProvider: provider } : {}));
  return client;
}

async function listTools(client: Client): Promise<ToolInfo[]> {
  const tools: ToolInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...(page.tools as unknown as ToolInfo[]));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

/** Why the server could not be used, as one line and an exit code. */
function explain(config: CliConfig, server: string, error: unknown): CliExit {
  if (needsSignIn(error)) return new CliExit(EXIT.signIn, `Sign in first: ${config.name} auth login (or set ${tokenEnvOf(config)}).`);
  const status = error instanceof SdkHttpError ? (error.data as { status?: number } | undefined)?.status : undefined;
  const why = short((error as Error).message);
  return new CliExit(EXIT.unreachable, status ? `${server} answered ${status}, not as an MCP server: is this its /mcp address? (${why})` : `Could not reach ${server}: ${why}`);
}

/** A server's error as one short line: a web page answering instead of an MCP server is not printed whole. */
function short(message: string): string {
  if (/<html|<!doctype/i.test(message)) return "it answered with a web page, not an MCP server (is this the /mcp address?)";
  const line = message.split("\n")[0]!;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** Only a real challenge means sign in: a 401, or a 403 asking for more scope. Any other 403 is a refusal. */
function needsSignIn(error: unknown): boolean {
  if (error instanceof UnauthorizedError || error instanceof InsufficientScopeError) return true;
  return error instanceof SdkHttpError && (error.data as { status?: number } | undefined)?.status === 401;
}

type Target = StricliCommand<CliContext> | RouteMap<CliContext>;

/** The command tree: groups from the commands' words, then the CLI's own commands. */
function routes(config: CliConfig, server: string | undefined, tools: ToolInfo[], client: Client | undefined, io: CliIO): RouteMap<CliContext> {
  interface Node {
    command?: StricliCommand<CliContext>;
    children: Map<string, Node>;
  }
  const root: Node = { children: new Map() };
  for (const c of commandTable(config, tools)) {
    let node = root;
    for (const word of c.words) {
      if (!node.children.has(word)) node.children.set(word, { children: new Map() });
      node = node.children.get(word)!;
    }
    node.command = c.config && isCustom(c.config) ? c.config.command : toolCommand(config, c, client, io);
  }
  const build = (node: Node, path: string[]): Record<string, Target> => {
    const out: Record<string, Target> = {};
    for (const [word, child] of node.children) {
      const here = [...path, word];
      if (child.command && child.children.size) throw new Error(`${config.name}: "${here.join(" ")}" is both a command and a group; a word is one or the other.`);
      if (child.command) out[word] = child.command;
      else {
        const sub = build(child, here);
        out[word] = buildRouteMap({ routes: sub, docs: { brief: config.groups?.[here.join(" ")] ?? Object.keys(sub).join(", ") } });
      }
    }
    return out;
  };
  const top = build(root, []);
  for (const word of BUILT_IN) if (top[word]) throw new Error(`${config.name}: "${word}" is the CLI's own command; name yours something else.`);
  const notice = server ? `Server: ${server}` : noServer(config);
  return buildRouteMap({
    routes: { ...top, tools: toolsCommand(tools, io), skill: skillCommand(config, tools, io), auth: authRoutes(config, server, io) },
    docs: { brief: config.description ?? config.name, fullDescription: `${config.description ?? config.name}\n\n${notice}\n--server <url> and --token <token> work on every command.` },
  });
}

/** Flags the CLI puts on tool commands itself. */
const OWN_FLAGS = ["json", "fields", "dry-run", "yes"];

/** A tool as a Stricli command: its input as flags (and the CLI file's positional arguments). */
function toolCommand(config: CliConfig, c: Command, client: Client | undefined, io: CliIO): StricliCommand<CliContext> {
  const tool = c.tool!;
  const settings = c.config && !isCustom(c.config) ? c.config : undefined;
  const args = settings?.args ?? [];
  const props = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  const writes = tool.annotations?.readOnlyHint !== true;
  const destructive = writes && tool.annotations?.destructiveHint !== false;
  const byFlag = new Map<string, string>();
  const flags: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(props)) {
    if (args.includes(field)) continue;
    const key = flagName(field);
    if (OWN_FLAGS.includes(key)) throw new Error(`${config.name}: ${tool.name}'s input ${field} clashes with the CLI's --${key}.`);
    byFlag.set(key, field);
    flags[key] = flagSpec(field, schema, !required.has(field));
  }
  flags.json = { kind: "boolean", brief: "Print JSON: for scripts and agents", optional: true, withNegated: false };
  flags.fields = { kind: "parsed", parse: (v: string) => v.split(",").map((f) => f.trim()).filter(Boolean), brief: "Only these fields, comma-separated (a.b for nested ones)", placeholder: "a,b", optional: true };
  if (writes) flags["dry-run"] = { kind: "boolean", brief: "Show the call it would make, and send nothing", optional: true, withNegated: false };
  if (destructive) flags.yes = { kind: "boolean", brief: "Don't ask first (needed without a terminal)", optional: true, withNegated: false };
  const examples = settings?.examples?.length ? `\n\nExamples:\n${settings.examples.map((e) => `  ${e}`).join("\n")}` : "";
  const usage = `${config.name} ${c.words.join(" ")}`;
  return buildCommand<Record<string, unknown>, unknown[], CliContext>({
    docs: { brief: c.summary, fullDescription: `${tool.description ?? c.summary}${examples}` },
    parameters: {
      flags: flags as never,
      positional: { kind: "tuple", parameters: args.map((field) => ({ brief: props[field]?.description ?? field.replace(/_/g, " "), placeholder: field, parse: parserFor(field, props[field] ?? {}), optional: !required.has(field) })) } as never,
    },
    async func(this: CliContext, parsed: Record<string, unknown>, ...positional: unknown[]) {
      const input: Record<string, unknown> = {};
      args.forEach((field, i) => {
        if (positional[i] !== undefined) input[field] = positional[i];
      });
      for (const [key, field] of byFlag) if (parsed[key] !== undefined) input[field] = parsed[key];
      if (writes && parsed["dry-run"]) return void io.write(`${JSON.stringify({ dryRun: true, tool: tool.name, arguments: input }, null, parsed.json ? undefined : 2)}\n`);
      if (destructive && !parsed.yes) {
        if (!io.interactive) throw new CliExit(EXIT.approval, `${usage} may delete or overwrite: run it again with --yes.`);
        if (!(await io.confirm(`${usage} may delete or overwrite. Go ahead?`))) throw new CliExit(EXIT.approval, "Stopped; nothing was sent.");
      }
      if (!client) throw new CliExit(EXIT.unreachable, noServer(config));
      const result = await client.callTool({ name: tool.name, arguments: input }).catch((error: unknown) => {
        throw needsSignIn(error) ? explain(config, "", error) : error;
      });
      if (result.isError) throw new CliExit(EXIT.failed, textOf(result.content as Block[]) || `${tool.name} failed.`);
      io.write(`${render(valueOf(result), { json: Boolean(parsed.json), fields: parsed.fields as string[] | undefined, columns: settings?.columns, view: settings?.view })}\n`);
    },
  });
}

function flagSpec(field: string, schema: JsonSchema, optional: boolean): unknown {
  const brief = schema.description ?? field.replace(/_/g, " ");
  const kind = flagKind(schema);
  if (schema.enum && schema.enum.every((v) => typeof v === "string")) return { kind: "enum", values: schema.enum, brief, optional };
  if (kind === "boolean") return optional ? { kind: "boolean", brief, optional: true, withNegated: false } : { kind: "parsed", parse: parseBoolean, brief, placeholder: "true|false" };
  if (kind === "list") return { kind: "parsed", parse: parserFor(field, schema.items ?? {}), variadic: ",", brief: `${brief} (repeat the flag, or comma-separated)`, placeholder: flagKind(schema.items ?? {}), optional };
  if (kind === "json") return { kind: "parsed", parse: parserFor(field, schema), brief: `${schema.description ? `${schema.description}: ` : ""}JSON ${typeHint(schema)}, or @file.json`, placeholder: "json", optional };
  return { kind: "parsed", parse: parserFor(field, schema), brief, placeholder: kind === "string" ? "text" : kind, optional };
}

function parseBoolean(v: string): boolean {
  if (/^(true|1|yes)$/i.test(v)) return true;
  if (/^(false|0|no)$/i.test(v)) return false;
  throw new Error("must be true or false");
}

function parserFor(field: string, schema: JsonSchema): (input: string) => unknown {
  const kind = flagKind(schema);
  if (kind === "number") return numberParser;
  if (kind === "integer") {
    return (v) => {
      const n = numberParser(v);
      if (!Number.isInteger(n)) throw new Error(`${field} must be a whole number`);
      return n;
    };
  }
  if (kind === "boolean") return parseBoolean;
  if (kind === "json") return (v) => JSON.parse(v.startsWith("@") ? readFileSync(v.slice(1), "utf8") : v);
  return String;
}

function toolsCommand(tools: ToolInfo[], io: CliIO): StricliCommand<CliContext> {
  return buildCommand<{ search?: string; json?: boolean }, [string?], CliContext>({
    docs: { brief: "Every tool, with its input and output schema", fullDescription: "Every tool the server has, or one tool's full description: its input, output and hints." },
    parameters: {
      flags: {
        search: { kind: "parsed", parse: String, brief: "Only tools whose name or description has this", placeholder: "text", optional: true },
        json: { kind: "boolean", brief: "Print JSON", optional: true, withNegated: false },
      },
      positional: { kind: "tuple", parameters: [{ brief: "One tool's name", placeholder: "tool", parse: String, optional: true }] },
    },
    func(flags, named) {
      if (named) {
        const one = tools.find((t) => t.name === named);
        if (!one) throw new CliExit(EXIT.usage, `No tool named ${named}.`);
        return void io.write(`${JSON.stringify(one, null, flags.json ? undefined : 2)}\n`);
      }
      const q = flags.search?.toLowerCase();
      const picked = tools.filter((t) => !q || `${t.name} ${t.title ?? ""} ${t.description ?? ""}`.toLowerCase().includes(q));
      if (flags.json) return void io.write(`${JSON.stringify(picked)}\n`);
      const width = Math.max(4, ...picked.map((t) => t.name.length));
      io.write(`${picked.map((t) => `${t.name.padEnd(width)}  ${t.title ?? ""}${t.annotations?.readOnlyHint ? "" : "  (changes things)"}`).join("\n")}\n`);
    },
  });
}

function skillCommand(config: CliConfig, tools: ToolInfo[], io: CliIO): StricliCommand<CliContext> {
  return buildCommand<{ write?: string }, [], CliContext>({
    docs: { brief: "This CLI's SKILL.md for coding agents", fullDescription: "Every command, flag, JSON shape and exit code, for Claude Code, Codex or Cursor. --write puts it in <dir>/<name>-cli/SKILL.md." },
    parameters: { flags: { write: { kind: "parsed", parse: String, brief: "Write it into this skills folder", placeholder: "dir", optional: true } } },
    async func(flags) {
      const text = skillFile(config, tools);
      if (!flags.write) return void io.write(text);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const folder = join(flags.write, `${config.name}-cli`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "SKILL.md"), text);
      io.writeError(`Wrote ${join(folder, "SKILL.md")}\n`);
    },
  });
}

function authRoutes(config: CliConfig, server: string | undefined, io: CliIO): RouteMap<CliContext> {
  const need = () => {
    if (!server) throw new CliExit(EXIT.usage, noServer(config));
    return server;
  };
  return buildRouteMap({
    docs: { brief: "Sign in, sign out, or see who is signed in" },
    routes: {
      login: buildCommand<{}, [], CliContext>({
        docs: { brief: "Sign in on the organization's own login page" },
        parameters: {},
        async func() {
          await signIn(config, need());
          io.writeError(`Signed in to ${need()}.\n`);
        },
      }),
      logout: buildCommand<{}, [], CliContext>({
        docs: { brief: "Forget this computer's sign-in" },
        parameters: {},
        func() {
          signOut(config, need());
          io.writeError(`Signed out of ${need()}.\n`);
        },
      }),
      status: buildCommand<{ json?: boolean }, [], CliContext>({
        docs: { brief: "Whether you are signed in, and how" },
        parameters: { flags: { json: { kind: "boolean", brief: "Print JSON", optional: true, withNegated: false } } },
        func(flags) {
          const s = need();
          const env = process.env[tokenEnvOf(config)];
          const source = env ? "env" : isSignedIn(config, s) ? "login" : null;
          if (flags.json) return void io.write(`${JSON.stringify({ server: s, signedIn: source !== null, source })}\n`);
          io.write(`${s}: ${env ? `using ${tokenEnvOf(config)}` : source ? "signed in" : "not signed in"}\n`);
        },
      }),
    },
  });
}

type Block = { type: string; text?: string };

function textOf(content: Block[]): string {
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function valueOf(result: { content?: unknown; structuredContent?: unknown; isError?: unknown }): unknown {
  if (result.isError) throw new CliExit(EXIT.failed, textOf(result.content as Block[]) || "The tool failed.");
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = textOf((result.content ?? []) as Block[]);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A field by its dotted path ("event.id"). */
function get(value: unknown, path: string): unknown {
  let v = value;
  for (const part of path.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[part] : undefined;
  return v;
}

function pick(value: unknown, fields: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => pick(v, fields));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = get(value, f);
    if (v !== undefined) out[f] = v;
  }
  return out;
}

function render(value: unknown, options: { json?: boolean; fields?: string[]; columns?: string[]; view?: string[] }): string {
  const shown = options.fields ? pick(value, options.fields) : value;
  if (options.json) return JSON.stringify(shown);
  return human(shown, options.fields ?? options.columns, options.fields ?? options.view);
}

/** For people: a table for a list of records (also one inside an object, its other fields after it), field lines for one record, else the value. */
function human(value: unknown, columns?: string[], view?: string[]): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return table(value, columns);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const lists = Object.keys(record).filter((k) => isRecords(record[k]));
    if (lists.length === 1 && !view) {
      const rest = Object.keys(record).filter((k) => k !== lists[0]);
      return [table(record[lists[0]!] as unknown[], columns), ...(rest.length ? ["", fields(record, rest)] : [])].join("\n");
    }
    return fields(record, view ?? Object.keys(record));
  }
  return JSON.stringify(value);
}

function isRecords(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((r) => r && typeof r === "object" && !Array.isArray(r));
}

function table(rows: unknown[], columns?: string[]): string {
  if (!rows.length) return "(none)";
  if (!isRecords(rows)) return rows.map(cell).join("\n");
  const first = rows[0] as Record<string, unknown>;
  const cols = columns ?? Object.keys(first).filter((k) => isScalar(first[k])).slice(0, 6);
  const cells = rows.map((r) => cols.map((c) => cell(get(r, c))));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i]!.length)));
  const line = (parts: string[]) => parts.map((p, i) => p.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(cols.map((c) => c.toUpperCase())), ...cells.map(line)].join("\n");
}

function fields(record: Record<string, unknown>, keys: string[]): string {
  const width = Math.max(...keys.map((k) => k.length));
  return keys.map((k) => `${k.padEnd(width)}  ${cell(get(record, k))}`).join("\n");
}

function isScalar(v: unknown): boolean {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

function cell(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v) && v.every(isScalar)) return v.join(", ");
  return isScalar(v) ? String(v) : JSON.stringify(v);
}
