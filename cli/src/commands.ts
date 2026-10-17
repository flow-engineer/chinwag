// An organization's CLI commands: every tool of its MCP server is a command under its own name
// (place_order → `place-order`), and the CLI file the team's coding agent writes (defineCli) adds
// what needs judgement: command groups and verbs (`order place`, where `order` is a group whose
// help lists its subcommands), the positional arguments, a table's columns, examples, aliases, and
// commands of its own. cliProblems is the rule-based check that keeps that file true to the tools;
// it never judges taste.

import type { Command as StricliCommand, CommandContext } from "@stricli/core";

export interface ToolCommand {
  /** The tool this command calls. */
  tool: string;
  /** Input fields taken from positional arguments, in order (`order view 1042` → orderId). */
  args?: string[];
  /** For a list: the columns of the table people see. */
  columns?: string[];
  /** For one record: the fields people see, in order. */
  view?: string[];
  /** Another name for the command. */
  alias?: string;
  /** One line under the command in help (default: the tool's title). */
  summary?: string;
  examples?: string[];
}

/** What a command of the team's own gets as `this` (Stricli's context): the server's tools and the CLI's output. */
export interface CliContext extends CommandContext {
  readonly cli: {
    /** Call one of the server's tools; resolves with its result, throws its error. */
    call(tool: string, input: Record<string, unknown>): Promise<unknown>;
    /** Print a value as the CLI prints tool results (a table, fields, or JSON with --json). */
    print(value: unknown, options?: { json?: boolean; fields?: string[]; columns?: string[] }): void;
  };
}

/** A command of the team's own: any Stricli command (buildCommand from @stricli/core), one level down. */
export interface CustomCommand {
  command: StricliCommand<CliContext>;
}

export type CommandConfig = ToolCommand | CustomCommand;

export interface CliConfig {
  /** The command's name ("acme"): its help, its config folder (~/.config/<name>) and token variable. */
  name: string;
  /** The organization's MCP endpoint. Else `--server` or <NAME>_SERVER. */
  server?: string;
  /** The variable a token is read from for CI and agents (default <NAME>_TOKEN). */
  tokenEnv?: string;
  description?: string;
  /** Commands by their words ("order place"): the first words are groups. Tools no command names keep their own name. */
  commands?: Record<string, CommandConfig>;
  /** One line about each group, shown in help ("order": "Place and track orders"). Default: its subcommands. */
  groups?: Record<string, string>;
  /** A Client ID Metadata Document URL for sign-in; without it the CLI registers itself (DCR). */
  clientMetadataUrl?: string;
  /** How a sign-in link is opened (default: printed for the person to open). */
  openUrl?: (url: string) => void | Promise<void>;
}

/** What the CLI knows of a tool, from the server's tools/list. */
export interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { properties?: Record<string, JsonSchema>; required?: string[]; [key: string]: unknown };
  outputSchema?: JsonSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  description?: string;
  [key: string]: unknown;
}

export interface Command {
  words: string[];
  summary: string;
  tool?: ToolInfo;
  config?: CommandConfig;
}

export function defineCli(config: CliConfig): CliConfig {
  return config;
}

export function isCustom(config: CommandConfig): config is CustomCommand {
  return (config as CustomCommand).command !== undefined;
}

/** The MCP server's own way to read its skills: plumbing for hosts, not a command, unless the CLI file names it. */
const HOST_ONLY = new Set(["read_skill"]);

/** Words the CLI keeps for itself. */
export const BUILT_IN = new Set(["auth", "tools", "skill"]);

/** "place_order" → "place-order". */
export function derivedName(tool: string): string {
  return tool.replace(/_/g, "-");
}

/** Every command: the CLI file's, then each tool it does not name, under the tool's own name. */
export function commandTable(config: CliConfig, tools: ToolInfo[]): Command[] {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const commands: Command[] = [];
  const named = new Set<string>();
  for (const [words, c] of Object.entries(config.commands ?? {})) {
    const split = words.trim().split(/\s+/);
    if (isCustom(c)) {
      commands.push({ words: split, summary: "", config: c });
      continue;
    }
    const tool = byName.get(c.tool);
    if (!tool) continue;
    named.add(c.tool);
    commands.push({ words: split, summary: c.summary ?? tool.title ?? tool.name, tool, config: c });
    if (c.alias) commands.push({ words: c.alias.trim().split(/\s+/), summary: `Same as ${words}`, tool, config: c });
  }
  for (const tool of tools) {
    if (!named.has(tool.name) && !HOST_ONLY.has(tool.name)) commands.push({ words: [derivedName(tool.name)], summary: tool.title ?? tool.name, tool });
  }
  return commands;
}

/** The command the words start with, the longest match first, and the words left after it. */
export function findCommand(commands: Command[], words: string[]): { command: Command; rest: string[] } | null {
  let best: Command | null = null;
  for (const c of commands) {
    if (c.words.length <= words.length && c.words.every((w, i) => w === words[i]) && (!best || c.words.length > best.words.length)) best = c;
  }
  return best ? { command: best, rest: words.slice(best.words.length) } : null;
}

/** Fields a list's rows or a record carry: the output schema's, or for an array, its items'. */
function outputFields(tool: ToolInfo): Set<string> | null {
  const schema = tool.outputSchema;
  if (!schema) return null;
  const props = schema.properties ?? schema.items?.properties;
  if (!props) return null;
  const fields = new Set(Object.keys(props));
  // A list wrapped in an object ({ orders: [...] }) shows its rows' fields too.
  for (const p of Object.values(props)) for (const k of Object.keys(p.items?.properties ?? {})) fields.add(k);
  return fields;
}

/** What is wrong in a CLI file against the server's tools, one sentence each; warnings apart. */
export function cliProblems(config: CliConfig, tools: ToolInfo[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const words = new Map<string, string>();
  const claim = (w: string, owner: string) => {
    const key = w.trim().split(/\s+/).join(" ");
    if (words.has(key)) errors.push(`command "${key}": both ${words.get(key)} and ${owner} use it`);
    else words.set(key, owner);
  };
  const named = new Set<string>();
  for (const [w, c] of Object.entries(config.commands ?? {})) {
    claim(w, `"${w}"`);
    if (isCustom(c)) continue;
    if (c.alias) claim(c.alias, `the alias of "${w}"`);
    const tool = byName.get(c.tool);
    if (!tool) {
      errors.push(`command "${w}": no tool named ${c.tool} on the server`);
      continue;
    }
    named.add(c.tool);
    const input = new Set(Object.keys(tool.inputSchema.properties ?? {}));
    for (const a of c.args ?? []) if (!input.has(a)) errors.push(`command "${w}": args names ${a}, which ${c.tool}'s input does not have`);
    const output = outputFields(tool);
    for (const key of ["columns", "view"] as const) {
      for (const f of c[key] ?? []) {
        if (!output) warnings.push(`command "${w}": ${key} names ${f}, but ${c.tool} declares no output to check it against`);
        else if (!output.has(f.split(".")[0]!)) errors.push(`command "${w}": ${key} names ${f}, which ${c.tool}'s output does not have`);
      }
    }
  }
  for (const t of tools) {
    if (named.has(t.name) || HOST_ONLY.has(t.name)) continue;
    claim(derivedName(t.name), `tool ${t.name}`);
    if (config.commands) warnings.push(`tool ${t.name} has no command in the CLI file; it is reachable as "${derivedName(t.name)}"`);
  }
  for (const [key, owner] of words) {
    const first = key.split(" ")[0]!;
    if (BUILT_IN.has(first)) errors.push(`command "${key}": ${first} is the CLI's own (${[...BUILT_IN].join(", ")})`);
    for (const other of words.keys()) {
      if (other !== key && other.startsWith(`${key} `)) errors.push(`command "${key}" (${owner}): it is also the group of "${other}"; a word is a command or a group, not both`);
    }
  }
  return { errors, warnings };
}

/** The CLI's SKILL.md for coding agents, made from the tools and the CLI file, never written by hand. */
export function skillFile(config: CliConfig, tools: ToolInfo[]): string {
  const name = config.name;
  const lines = [
    "---",
    `name: ${name}-cli`,
    `description: Use the ${name} command line${config.description ? ` (${config.description})` : ""}. Load before running ${name} commands or when asked to do something in ${name} from a terminal.`,
    "---",
    "",
    `# The ${name} command line`,
    "",
    `Run \`${name} <command> --json\` and read the JSON; never parse the human output. \`--fields a,b\` keeps only those fields.`,
    "Commands that change things accept `--dry-run` (shows the call, sends nothing) and, when they may delete or overwrite, need `--yes` without a terminal.",
    `Sign in once with \`${name} auth login\`, or set ${tokenEnvOf(config)} in CI.`,
    "",
    "Exit codes: 0 done, 1 the tool failed (its message on stderr), 2 wrong command or arguments, 3 sign-in needed, 4 needs --yes, 5 the server could not be reached.",
    "",
    "## Commands",
  ];
  for (const c of commandTable(config, tools)) {
    if (!c.tool) continue;
    lines.push("", `### ${name} ${c.words.join(" ")}`, "", c.summary);
    if (c.tool) {
      if (c.tool.description && c.tool.description !== c.summary) lines.push("", c.tool.description);
      const args = c.config && !isCustom(c.config) ? (c.config.args ?? []) : [];
      const flags = flagList(c.tool, args);
      if (args.length || flags.length) lines.push("", `Usage: \`${name} ${c.words.join(" ")}${args.map((a) => ` <${a}>`).join("")}${flags.length ? " [flags]" : ""}\``);
      for (const f of flags) lines.push(`- ${f}`);
      if (c.tool.annotations?.readOnlyHint !== true) lines.push(`- Changes things${c.tool.annotations?.destructiveHint === false ? "" : " and may delete or overwrite: needs --yes"}.`);
      if (c.tool.outputSchema) lines.push("", "JSON output schema:", "", "```json", JSON.stringify(c.tool.outputSchema), "```");
    }
    for (const e of c.config && !isCustom(c.config) ? (c.config.examples ?? []) : []) lines.push("", "```bash", e, "```");
  }
  return lines.join("\n") + "\n";
}

export function tokenEnvOf(config: CliConfig): string {
  return config.tokenEnv ?? `${config.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TOKEN`;
}

export function flagName(field: string): string {
  return field.replace(/_/g, "-").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** One line per flag: its name, type and what it is for. */
export function flagList(tool: ToolInfo, args: string[] = []): string[] {
  const required = new Set(tool.inputSchema.required ?? []);
  return Object.entries(tool.inputSchema.properties ?? {})
    .filter(([field]) => !args.includes(field))
    .map(([field, s]) => {
      const kind = s.enum ? s.enum.join("|") : flagKind(s) === "json" ? `JSON: ${typeHint(s)} (or @file.json)` : flagKind(s);
      return `\`--${flagName(field)}\` ${kind}${required.has(field) ? ", required" : ""}${s.description ? `: ${s.description}` : ""}`;
    });
}

/** A short picture of a JSON value's shape: "list of {item, size, milk?, quantity?}". */
export function typeHint(s: JsonSchema): string {
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  if (type === "array") return `list of ${s.items ? typeHint(s.items) : "values"}`;
  if (type === "object" || s.properties) {
    const required = new Set((s.required as string[] | undefined) ?? []);
    const keys = Object.keys(s.properties ?? {}).map((k) => (required.has(k) ? k : `${k}?`));
    return keys.length ? `{${keys.join(", ")}}` : "object";
  }
  return s.enum ? s.enum.join("|") : (type ?? "value");
}

export type FlagKind = "string" | "number" | "integer" | "boolean" | "list" | "json";

export function flagKind(s: JsonSchema): FlagKind {
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  if (type === "array") {
    const item = Array.isArray(s.items?.type) ? s.items?.type[0] : s.items?.type;
    return item === "string" || item === "number" || item === "integer" ? "list" : "json";
  }
  if (type === "number" || type === "integer" || type === "boolean" || type === "string") return type;
  return s.enum ? "string" : "json";
}
