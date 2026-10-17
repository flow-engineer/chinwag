// An existing MCP server's tools as Chinwag tools, so a chat agent uses them like its own.
//
// Pinned by default: the tools come from mcp.lock.json in the agent's folder (each tool's
// descriptor and fingerprint, written by `chinwag mcp update`), never from what the server says
// today. A tool the server has changed or removed since is refused with a clear error until the
// lock is updated and committed: what was tested is what runs. Building the tools reads only the
// lock; the server is first reached on a call, and its list is read again before a call once the
// last look is older than RECHECK_MS. `live: true` takes the server's tools as they are instead.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { z } from "zod";
import { INPUT_SCHEMA, type Tool, type ToolHints } from "../../src/tools.ts";

export interface McpToolsOptions {
  /** The server's name in mcp.lock.json. */
  name: string;
  /** Its Streamable HTTP endpoint. */
  url: string;
  /** Sent with every request, such as `authorization`. Keep keys in the environment, never in the lock. */
  headers?: Record<string, string>;
  /** Only these of its tools (default: every tool in the lock). */
  only?: string[];
  /** Put before each tool's name, to keep two servers' tools apart (default: none). */
  prefix?: string;
  /** Take the server's tools as they are now, with no lock (default false). */
  live?: boolean;
  /** Default: mcp.lock.json in the current folder (the agent's, for chinwag commands). */
  lockFile?: string;
}

/** A tool as the server described it, as tools/list sends it. */
export interface McpDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface McpLock {
  servers: Record<string, { url: string; tools: Record<string, { fingerprint: string; descriptor: McpDescriptor }> }>;
}

export const RECHECK_MS = 5 * 60_000;
/** Set by `chinwag mcp update`: mcpTools writes the server's current tools into the lock. */
export const UPDATE_ENV = "CHINWAG_MCP_UPDATE";
const IDEMPOTENCY_META = "chinwag/idempotency-key";

export async function mcpTools(options: McpToolsOptions): Promise<Tool[]> {
  const lockFile = options.lockFile ?? join(process.cwd(), "mcp.lock.json");
  const connection = connect(options);
  if (options.live || process.env[UPDATE_ENV] === "1") {
    const current = await connection.list();
    if (!options.live) writeLock(lockFile, options, current);
    return picked(options, [...current.values()]).map((d) => wrap(options, d, connection, null));
  }
  const entry = readLock(lockFile).servers[options.name];
  if (!entry) throw new Error(`chinwag/mcp: ${options.name} is not in ${lockFile}. Run chinwag mcp update from the agent's folder, then commit the file.`);
  return picked(options, Object.values(entry.tools).map((t) => t.descriptor)).map((d) => wrap(options, d, connection, entry.tools[d.name]!.fingerprint));
}

function picked(options: McpToolsOptions, descriptors: McpDescriptor[]): McpDescriptor[] {
  return options.only ? descriptors.filter((d) => options.only!.includes(d.name)) : descriptors;
}

/** The fingerprint of what a model and a host see of a tool: any change to it is a change. */
export function fingerprint(d: McpDescriptor): string {
  const seen = { name: d.name, title: d.title, description: d.description, inputSchema: d.inputSchema, outputSchema: d.outputSchema, annotations: d.annotations };
  return createHash("sha256").update(canonical(seen)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function readLock(lockFile: string): McpLock {
  if (!existsSync(lockFile)) return { servers: {} };
  return JSON.parse(readFileSync(lockFile, "utf8")) as McpLock;
}

function writeLock(lockFile: string, options: McpToolsOptions, current: Map<string, McpDescriptor>): void {
  const lock = readLock(lockFile);
  const before = lock.servers[options.name]?.tools ?? {};
  const tools: McpLock["servers"][string]["tools"] = {};
  for (const d of picked(options, [...current.values()]).sort((a, b) => (a.name < b.name ? -1 : 1))) tools[d.name] = { fingerprint: fingerprint(d), descriptor: d };
  for (const name of Object.keys(tools)) {
    if (!before[name]) console.error(`  + ${options.name}.${name}`);
    else if (before[name]!.fingerprint !== tools[name]!.fingerprint) console.error(`  ~ ${options.name}.${name} changed`);
  }
  for (const name of Object.keys(before)) if (!tools[name]) console.error(`  - ${options.name}.${name} removed`);
  lock.servers[options.name] = { url: options.url, tools };
  const sorted: McpLock = { servers: Object.fromEntries(Object.entries(lock.servers).sort(([a], [b]) => (a < b ? -1 : 1))) };
  writeFileSync(lockFile, JSON.stringify(sorted, null, 2) + "\n");
}

interface Connection {
  list(): Promise<Map<string, McpDescriptor>>;
  /** The server's list, read again when the last look is older than RECHECK_MS. */
  recent(): Promise<Map<string, McpDescriptor>>;
  call(name: string, args: Record<string, unknown>, meta: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
}

function connect(options: McpToolsOptions): Connection {
  let client: Promise<Client> | undefined;
  let last: { at: number; tools: Map<string, McpDescriptor> } | undefined;
  function open(): Promise<Client> {
    client ??= (async () => {
      const c = new Client({ name: "chinwag", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(options.url), { requestInit: { headers: options.headers ?? {} } }));
      return c;
    })().catch((error) => {
      client = undefined;
      throw error;
    });
    return client;
  }
  async function list(): Promise<Map<string, McpDescriptor>> {
    const c = await open();
    const tools = new Map<string, McpDescriptor>();
    let cursor: string | undefined;
    do {
      const page = await c.listTools(cursor ? { cursor } : {});
      for (const t of page.tools) tools.set(t.name, stripped(t as unknown as McpDescriptor));
      cursor = page.nextCursor;
    } while (cursor);
    last = { at: Date.now(), tools };
    return tools;
  }
  return {
    list,
    recent: async () => (last && Date.now() - last.at < RECHECK_MS ? last.tools : list()),
    async call(name, args, meta, signal) {
      const c = await open();
      return (await c.callTool({ name, arguments: args, _meta: meta }, { signal })) as CallToolResult;
    },
  };
}

/** Only what the lock keeps of a descriptor. */
function stripped(t: McpDescriptor): McpDescriptor {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations };
}

function wrap(options: McpToolsOptions, d: McpDescriptor, connection: Connection, locked: string | null): Tool {
  const a = d.annotations ?? {};
  const hints: ToolHints = {
    // A tool that does not say it only reads is taken as a write.
    readOnly: a.readOnlyHint === true,
    destructive: a.destructiveHint ?? true,
    idempotent: a.idempotentHint ?? false,
    openWorld: a.openWorldHint ?? true,
  };
  const t: Tool & { [INPUT_SCHEMA]: Record<string, unknown> } = {
    name: `${options.prefix ?? ""}${d.name}`,
    title: d.title ?? a.title,
    description: d.description ?? "",
    input: validator(d.inputSchema),
    hints,
    [INPUT_SCHEMA]: d.inputSchema,
    async run(input, context) {
      if (locked) {
        const now = (await connection.recent()).get(d.name);
        if (!now) throw new Error(`${options.name} no longer has ${d.name}. The agent's mcp.lock.json must be updated (chinwag mcp update) before it can be used.`);
        if (fingerprint(now) !== locked) throw new Error(`${options.name} changed ${d.name} since it was tested. The agent's mcp.lock.json must be updated (chinwag mcp update) before it can be used.`);
      }
      const result = await connection.call(d.name, withoutPlaceholders(input as Record<string, unknown>, d.inputSchema), { [IDEMPOTENCY_META]: context.idempotencyKey }, context.signal);
      const text = result.content
        .map((block) => (block.type === "text" ? block.text : `[${block.type} not shown]`))
        .join("\n");
      if (result.isError) throw new Error(text || `${d.name} failed.`);
      return result.structuredContent ?? text;
    },
  };
  return t;
}

/** Arguments are checked by the zod made from the server's schema; the server checks them again. */
function validator(schema: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return z.looseObject({});
  }
}

/**
 * A model's placeholder for an argument it did not mean (null, "" or []) is left out when the schema
 * does not require it, also inside objects: servers' validation refused them (Flow, 6 Oct 2026).
 * false and 0 are real values and stay.
 */
export function withoutPlaceholders(value: Record<string, unknown>, schema: Record<string, unknown>): Record<string, unknown> {
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const empty = v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty && !required.has(key)) continue;
    const nested = properties[key];
    out[key] = v && typeof v === "object" && !Array.isArray(v) && nested?.properties ? withoutPlaceholders(v as Record<string, unknown>, nested) : v;
  }
  return out;
}
