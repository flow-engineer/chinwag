// An agent's tools and skills as an MCP server (Streamable HTTP, spec 2026-07-28 with the 2025
// fallback), on the official SDK. It needs no model, channels or store: mount `fetch` on any
// web-standard runtime (Cloudflare Workers, Deno, Bun) or `node` on node:http.
//
// Sign-in is the host's OAuth against the business's own authorization server; this server only
// verifies the token on every request (`auth.verify`) and turns it into the person. A call that
// needs sign-in and has none is answered HTTP 401 with WWW-Authenticate before the SDK runs: hosts
// start sign-in only on that, never on a tool result. A token without a needed scope gets 403
// insufficient_scope. Without `auth`, every tool answers and the person is anonymous.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type AuthInfo,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { emitter, type EventSink } from "../../src/events.ts";
import { loadSkills, mcpInstructions, readAgentFolder, readSkillTool, type AgentFiles } from "../../src/skills.ts";
import { render, type Tool, type ToolContext } from "../../src/tools.ts";
import { describe, scopesFor, signInOf, toolsProblems, type McpToolDescriptor, type Scopes } from "./describe.ts";

export interface McpAuth {
  /** The authorization server(s) that issue tokens for this server, as hosts discover them. */
  issuer: string | string[];
  /** This server's public URL as hosts reach it, the resource tokens are for. Default: the request's own. */
  resource?: string;
  /** Scope names: reads need `read`, writes `write`. Without them, being signed in is enough. */
  scopes?: Scopes;
  /**
   * Check a bearer token, on every request. Return who it is for (`key`: the business's own id for
   * the person, as ToolContext.key) and the scopes it grants, or null when it is not valid.
   */
  verify(token: string, request: Request): Promise<McpIdentity | null> | McpIdentity | null;
}

export interface McpIdentity {
  key: string;
  scopes?: string[];
}

export interface McpServerOptions {
  name: string;
  version: string;
  tools: Tool[];
  /** The agent's folder, for its skills (AGENTS.md is the chat agent's and is not sent). Or `files`. */
  dir?: string;
  files?: AgentFiles;
  /** Replaces the instructions a host gets on connecting (default: the skills and how to read them). */
  instructions?: string;
  auth?: McpAuth;
  /** Where the endpoint is mounted (default "/mcp"). */
  path?: string;
  /** Host names allowed in the Host header. Default: checked only for localhost, against DNS rebinding. */
  allowedHosts?: string[];
  /** Change the descriptor of any tool (default: exactly what `describe` makes). */
  descriptor?: (tool: Tool, generated: McpToolDescriptor) => McpToolDescriptor;
  /** Add your own handlers (resources, prompts, ...) to each server the SDK makes; one level down. */
  extend?: (server: Server) => void;
  events?: EventSink[];
}

export interface McpServerHandle {
  /** Serve one web-standard request. */
  fetch(request: Request): Promise<Response>;
  /** Serve one node:http request. */
  node(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** The descriptors `tools/list` sends. */
  descriptors: McpToolDescriptor[];
}

const LOCAL = new Set(localhostAllowedHostnames());

export function mcpServer(options: McpServerOptions): McpServerHandle {
  if (options.dir !== undefined && options.files !== undefined) throw new Error("chinwag/mcp: give dir or files, not both");
  const skills = options.dir !== undefined || options.files !== undefined ? loadSkills(options.files ?? readAgentFolder(options.dir!)) : [];
  const tools = [...options.tools, ...(skills.length ? [readSkillTool(skills)] : [])];
  const problems = toolsProblems(tools);
  if (problems.length) throw new Error(`chinwag/mcp: these tools cannot be served as declared:\n- ${problems.join("\n- ")}`);
  const scopes = options.auth?.scopes;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const descriptors = tools.map((t) => (options.descriptor ? options.descriptor(t, describe(t, scopes)) : describe(t, scopes)));
  const instructions = options.instructions ?? mcpInstructions(skills);
  const path = options.path ?? "/mcp";
  const emit = emitter(options.events ?? []);

  const handler = createMcpHandler(() => {
    const server = new Server({ name: options.name, version: options.version }, { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) });
    server.setRequestHandler("tools/list", async () => ({ tools: descriptors }));
    server.setRequestHandler("tools/call", async (request, ctx) => {
      const t = byName.get(request.params.name);
      if (!t) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No tool named ${request.params.name}.`);
      const parsed = t.input.safeParse(request.params.arguments ?? {});
      if (!parsed.success) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for ${t.name}: ${parsed.error.message}`);
      const identity = identityOf(ctx.http?.authInfo);
      const person = identity ? `key:${identity.key}` : "mcp:anonymous";
      const context: ToolContext = {
        conversationId: `mcp:${person}`,
        person,
        key: identity?.key ?? null,
        channel: "mcp",
        callId: randomUUID(),
        // MCP has no turns: a retry by the host is a new request, so the key is per call.
        idempotencyKey: randomUUID(),
        signal: ctx.mcpReq?.signal ?? new AbortController().signal,
      };
      const started = Date.now();
      emit(context.conversationId, "tool.start", { callId: context.callId, tool: t.name, input: parsed.data, surface: "mcp" });
      const result = await callTool(t, parsed.data, context);
      emit(context.conversationId, "tool.end", { callId: context.callId, tool: t.name, ms: Date.now() - started, ok: !result.isError, surface: "mcp" });
      return result;
    });
    options.extend?.(server);
    return server;
  });

  async function serve(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === `/.well-known/oauth-protected-resource${path}`)) {
      if (!options.auth) return new Response("Not found", { status: 404 });
      return Response.json({
        resource: resourceOf(url),
        authorization_servers: [options.auth.issuer].flat(),
        bearer_methods_supported: ["header"],
        ...(scopes && (scopes.read || scopes.write) ? { scopes_supported: [...new Set([scopes.read, scopes.write].filter(Boolean))] } : {}),
      });
    }
    if (url.pathname !== path) return new Response("Not found", { status: 404 });
    const rejected = options.allowedHosts
      ? hostHeaderValidationResponse(request, options.allowedHosts)
      : LOCAL.has(url.hostname)
        ? (hostHeaderValidationResponse(request, localhostAllowedHostnames()) ?? originValidationResponse(request, localhostAllowedOrigins()))
        : undefined;
    if (rejected) return rejected;

    let authInfo: AuthInfo | undefined;
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (options.auth && bearer) {
      const identity = await options.auth.verify(bearer, request);
      if (!identity) return challenge(url, 401, "invalid_token", "The token is not valid.", []);
      authInfo = { token: bearer, clientId: "", scopes: identity.scopes ?? [], extra: { key: identity.key } };
    }
    let parsedBody: unknown;
    if (request.method === "POST") {
      try {
        parsedBody = JSON.parse(await request.clone().text());
      } catch {
        parsedBody = undefined;
      }
      if (options.auth) {
        for (const message of [parsedBody].flat()) {
          const call = message as { method?: unknown; params?: { name?: unknown } } | null;
          if (!call || call.method !== "tools/call" || typeof call.params?.name !== "string") continue;
          const t = byName.get(call.params.name);
          if (!t || signInOf(t) === "none") continue;
          const needed = scopesFor(t, scopes);
          if (!authInfo) {
            if (signInOf(t) === "required") return challenge(url, 401, "invalid_token", `Sign in to use ${t.name}.`, needed);
            continue;
          }
          const missing = needed.filter((s) => !authInfo!.scopes.includes(s));
          if (missing.length) return challenge(url, 403, "insufficient_scope", `${t.name} needs ${missing.join(" ")}.`, [...new Set([...authInfo.scopes, ...needed])]);
        }
      }
    }
    return handler.fetch(request, { authInfo, parsedBody });
  }

  function resourceOf(url: URL): string {
    return options.auth?.resource ?? `${url.origin}${path}`;
  }

  function challenge(url: URL, status: 401 | 403, error: string, description: string, scope: string[]): Response {
    const metadata = `${new URL(resourceOf(url)).origin}/.well-known/oauth-protected-resource${path}`;
    const header = `Bearer error="${error}", error_description="${description}", resource_metadata="${metadata}"${scope.length ? `, scope="${scope.join(" ")}"` : ""}`;
    return Response.json({ error, error_description: description }, { status, headers: { "WWW-Authenticate": header } });
  }

  return {
    fetch: serve,
    node: (req, res) => serveNode(serve, req, res),
    descriptors,
  };
}

function identityOf(authInfo: AuthInfo | undefined): McpIdentity | null {
  const key = authInfo?.extra?.key;
  return typeof key === "string" ? { key, scopes: authInfo!.scopes } : null;
}

async function callTool(t: Tool, input: unknown, context: ToolContext): Promise<CallToolResult> {
  let output: unknown;
  try {
    output = await t.run(input, context);
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
  if (!t.output) return { content: [{ type: "text", text: render(output) }] };
  const checked = t.output.safeParse(output);
  if (!checked.success) return { isError: true, content: [{ type: "text", text: `${t.name} returned a result that does not match its output schema.` }] };
  return { content: [{ type: "text", text: render(checked.data) }], structuredContent: checked.data as CallToolResult["structuredContent"] };
}

/** node:http in front of the web-standard handler, streaming the answer (event streams included). */
async function serveNode(serve: (request: Request) => Promise<Response>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const secure = (req.socket as { encrypted?: boolean }).encrypted === true;
  const url = `${secure ? "https" : "http"}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const all = Buffer.concat(chunks);
    body = all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
  }
  const response = await serve(new Request(url, { method: req.method, headers, body, signal: abort.signal }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return void res.end();
  try {
    for await (const chunk of response.body) res.write(chunk);
  } finally {
    res.end();
  }
}
