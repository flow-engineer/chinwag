// covers: mcp/src/server.ts mcp/src/describe.ts src/skills.ts
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { isSpecType } from "@modelcontextprotocol/server";
import { z } from "zod";
import { tools as cafeTools } from "../examples/cafe/src/tools.ts";
import { mcpServer, type McpServerOptions } from "../mcp/src/index.ts";
import { tool, type ToolContext } from "../src/index.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function serve(options: McpServerOptions): Promise<string> {
  const handle = mcpServer(options);
  const http = createServer((req, res) => void handle.node(req, res));
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as { port: number };
  return `http://127.0.0.1:${port}/mcp`;
}

async function client(url: string, token?: string): Promise<Client> {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} } }));
  return c;
}

function rpc(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

const call = (name: string, args: unknown = {}) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("the café's tools are served as spec-valid MCP tools, every annotation sent explicitly", async () => {
  const url = await serve({ name: "cafe", version: "1.0.0", tools: cafeTools });
  const c = await client(url);
  const listed = await c.listTools();
  assert.ok(isSpecType.ListToolsResult(listed));
  assert.deepEqual(listed.tools.map((t) => t.name), ["get_menu", "place_order", "order_status"]);
  for (const t of listed.tools) assert.ok(isSpecType.Tool(t), `${t.name} is a spec Tool`);
  const place = listed.tools.find((t) => t.name === "place_order")!;
  assert.deepEqual(place.annotations, { title: "Place an order", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.equal(place.inputSchema.type, "object");
  assert.equal(place.outputSchema?.type, "object");
  assert.deepEqual(place._meta, { securitySchemes: [{ type: "oauth2", scopes: [] }], "openai/toolInvocation/invoking": "Placing your order…", "openai/toolInvocation/invoked": "Order placed" });
  const status = listed.tools.find((t) => t.name === "order_status")!;
  assert.equal(status.title, "Order status", "derived from the name when the tool gives none");
  assert.deepEqual(status.annotations, { title: "Order status", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  await c.close();
});

test("without a token a signed-in tool gets 401 before the SDK runs, and a signed-out one answers", async () => {
  const menu = tool({ name: "menu", description: "The menu.", input: z.object({}), signIn: "none", hints: { readOnly: true }, run: () => "latte" });
  const orders = tool({ name: "my_orders", description: "Their orders.", input: z.object({}), hints: { readOnly: true }, run: () => [] });
  const url = await serve({ name: "cafe", version: "1", tools: [menu, orders], auth: { issuer: "https://login.example.com", scopes: { read: "orders:read" }, verify: () => null } });

  const denied = await rpc(url, call("my_orders"));
  assert.equal(denied.status, 401);
  const header = denied.headers.get("www-authenticate")!;
  assert.match(header, /^Bearer error="invalid_token"/);
  assert.match(header, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(header, /scope="orders:read"/);

  const metadata = await (await fetch(header.match(/resource_metadata="([^"]+)"/)![1]!)).json();
  assert.deepEqual(metadata, { resource: url, authorization_servers: ["https://login.example.com"], bearer_methods_supported: ["header"], scopes_supported: ["orders:read"] });

  const c = await client(url);
  assert.deepEqual((await c.callTool({ name: "menu", arguments: {} })).content, [{ type: "text", text: "latte" }]);
  await c.close();
});

test("a valid token becomes the person, and a token without the write scope gets 403 insufficient_scope", async () => {
  let seen: ToolContext | undefined;
  const status = tool({ name: "status", description: "An order's status.", input: z.object({}), hints: { readOnly: true }, run: (_i, ctx) => ((seen = ctx), "ready") });
  const cancel = tool({ name: "cancel", description: "Cancel an order.", input: z.object({}), run: () => "cancelled" });
  const verify = (token: string) => (token === "sam-read" ? { key: "user-42", scopes: ["read"] } : null);
  const url = await serve({ name: "cafe", version: "1", tools: [status, cancel], auth: { issuer: "https://login.example.com", scopes: { read: "read", write: "write" }, verify } });

  const c = await client(url, "sam-read");
  await c.callTool({ name: "status", arguments: {} });
  assert.equal(seen?.person, "key:user-42");
  assert.equal(seen?.key, "user-42");
  assert.equal(seen?.channel, "mcp");
  await c.close();

  const refused = await rpc(url, call("cancel"), "sam-read");
  assert.equal(refused.status, 403);
  assert.match(refused.headers.get("www-authenticate")!, /error="insufficient_scope".*scope="read write"/);
  assert.equal((await rpc(url, call("status"), "someone-else")).status, 401, "an invalid token is refused whatever it calls");
});

test("a tool that throws is an isError result, and output is checked and sent as structured content", async () => {
  const fails = tool({ name: "fails", description: "Fails.", input: z.object({}), signIn: "none", run: () => { throw new Error("the till is offline"); } });
  const order = z.object({ order_id: z.string() });
  const good = tool({ name: "good", description: "Places.", input: z.object({}), output: order, signIn: "none", run: () => ({ order_id: "BL-1" }) });
  const bad = tool({ name: "bad", description: "Places.", input: z.object({}), output: order, signIn: "none", run: () => ({ id: 1 }) });
  const c = await client(await serve({ name: "cafe", version: "1", tools: [fails, good, bad] }));

  assert.deepEqual(await c.callTool({ name: "fails", arguments: {} }), { isError: true, content: [{ type: "text", text: "the till is offline" }] });
  const placed = await c.callTool({ name: "good", arguments: {} });
  assert.deepEqual(placed.structuredContent, { order_id: "BL-1" });
  assert.equal((await c.callTool({ name: "bad", arguments: {} })).isError, true);
  await c.close();
});

test("skills are listed in the instructions and read with read_skill", async () => {
  const files = { "AGENTS.md": "# Pip\nThe chat agent's prompt.", "skills/allergens/SKILL.md": "---\nname: allergens\ndescription: questions about allergies\n---\nNever say an item is safe." };
  const c = await client(await serve({ name: "cafe", version: "1", tools: [], files }));
  assert.equal(c.getInstructions(), "This server's skills are rules for one kind of request each. Read a skill with read_skill before doing what it covers.\n- allergens: questions about allergies");
  const read = await c.callTool({ name: "read_skill", arguments: { name: "allergens" } });
  assert.deepEqual(read.content, [{ type: "text", text: "Never say an item is safe." }]);
  await c.close();
});

test("a tool that cannot be described exactly is refused when the server is made", () => {
  const dated = tool({ name: "book", description: "Book.", input: z.object({ when: z.date() }), run: () => "ok" });
  assert.throws(() => mcpServer({ name: "x", version: "1", tools: [dated] }), /input has no exact JSON Schema/);
});
