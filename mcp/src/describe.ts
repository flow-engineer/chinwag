// A Chinwag tool as an MCP tool (spec 2026-07-28), and the rules that make that translation exact.
// Every field of the descriptor comes from the tool or a stated default; nothing is guessed, and a
// tool that cannot be described exactly is a problem `chinwag check` reports, not a schema we bend.

import { z } from "zod";
import type { SignIn, Tool } from "../../src/tools.ts";

/** An MCP tool as `tools/list` sends it. */
export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  outputSchema?: { [key: string]: unknown };
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  _meta: Record<string, unknown>;
}

/** The scopes an MCP server asks for: reads need `read`, writes `write` (both when given). */
export interface Scopes {
  read?: string;
  write?: string;
}

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const STATUS_MAX = 64;
/** Tools that exist only in a chat: a description naming one points a host at a tool it does not have. */
export const CHAT_ONLY = /\b(send_[a-z0-9_]+|share_updates|load_skill)\b/;

export function signInOf(tool: Tool): SignIn {
  return tool.signIn ?? "required";
}

export function isReadOnly(tool: Tool): boolean {
  return tool.hints?.readOnly ?? false;
}

/** The scopes a call needs, given the server's scope names. */
export function scopesFor(tool: Tool, scopes: Scopes | undefined): string[] {
  const name = isReadOnly(tool) ? scopes?.read : scopes?.write;
  return name ? [name] : [];
}

/** "place_order" → "Place order". */
export function titleOf(tool: Tool): string {
  if (tool.title) return tool.title;
  const words = tool.name.replace(/[_.-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "throw", io: "input" }) as Record<string, unknown>;
  return rest;
}

/** The MCP descriptor for a tool. Throws when its input or output has no exact JSON Schema. */
export function describe(tool: Tool, scopes?: Scopes): McpToolDescriptor {
  const readOnly = isReadOnly(tool);
  const title = titleOf(tool);
  const inputSchema = jsonSchema(tool.input) as McpToolDescriptor["inputSchema"];
  const signIn = signInOf(tool);
  const oauth = { type: "oauth2", scopes: scopesFor(tool, scopes) };
  const _meta: Record<string, unknown> = {
    // ChatGPT reads sign-in per tool from here; the spec keeps it at the HTTP layer only.
    securitySchemes: signIn === "none" ? [{ type: "noauth" }] : signIn === "optional" ? [{ type: "noauth" }, oauth] : [oauth],
  };
  if (tool.status?.running) _meta["openai/toolInvocation/invoking"] = tool.status.running;
  if (tool.status?.done) _meta["openai/toolInvocation/invoked"] = tool.status.done;
  return {
    name: tool.name,
    title,
    description: tool.description,
    inputSchema,
    ...(tool.output ? { outputSchema: jsonSchema(tool.output) } : {}),
    annotations: {
      title,
      readOnlyHint: readOnly,
      destructiveHint: readOnly ? false : (tool.hints?.destructive ?? true),
      idempotentHint: tool.hints?.idempotent ?? false,
      openWorldHint: tool.hints?.openWorld ?? true,
    },
    _meta,
  };
}

/** Why a tool cannot be served over MCP exactly as declared, one sentence each (empty when it can). */
export function toolProblems(tool: Tool): string[] {
  const problems: string[] = [];
  const at = `tool ${tool.name}`;
  if (!NAME.test(tool.name)) problems.push(`${at}: the name must be 1 to 128 of A-Z a-z 0-9 _ - . (MCP's tool names)`);
  if (!tool.description.trim()) problems.push(`${at}: the description is empty; hosts show it to their model`);
  const chatOnly = CHAT_ONLY.exec(tool.description);
  if (chatOnly) problems.push(`${at}: the description names ${chatOnly[1]}, a tool only chats have`);
  if (!(tool.input instanceof z.ZodObject)) problems.push(`${at}: input must be a z.object (MCP needs an object at the root)`);
  else {
    try {
      jsonSchema(tool.input);
    } catch (error) {
      problems.push(`${at}: input has no exact JSON Schema (${(error as Error).message})`);
    }
  }
  if (tool.output) {
    try {
      jsonSchema(tool.output);
    } catch (error) {
      problems.push(`${at}: output has no exact JSON Schema (${(error as Error).message})`);
    }
  }
  if (tool.hints?.readOnly && tool.hints.destructive) problems.push(`${at}: hints say readOnly and destructive; a tool that changes nothing destroys nothing`);
  for (const key of ["running", "done"] as const) {
    const line = tool.status?.[key];
    if (line !== undefined && (line.length === 0 || line.length > STATUS_MAX)) problems.push(`${at}: status.${key} must be 1 to ${STATUS_MAX} characters`);
  }
  return problems;
}

/** Problems across a server's tools: each tool's, and names used twice. */
export function toolsProblems(tools: Tool[]): string[] {
  const problems = tools.flatMap(toolProblems);
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) problems.push(`tool ${t.name}: two tools have this name`);
    seen.add(t.name);
  }
  return problems;
}
