// covers: mcp/src/client.ts src/tools.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { UPDATE_ENV } from "../mcp/src/client.ts";
import { mcpServer, mcpTools, type McpLock, type McpServerHandle } from "../mcp/src/index.ts";
import { tool, toSpec, type Tool, type ToolContext } from "../src/index.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

/** An upstream MCP server whose tools the test can swap while it runs. */
async function upstream(tools: Tool[]) {
  let handle: McpServerHandle = mcpServer({ name: "shop", version: "1", tools });
  const http = createServer((req, res) => void handle.node(req, res));
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, swap: (next: Tool[]) => void (handle = mcpServer({ name: "shop", version: "1", tools: next })) };
}

const context = (): ToolContext => ({ conversationId: "c", person: "phone:+15550100", key: null, channel: "whatsapp", callId: "1", idempotencyKey: "k1", signal: new AbortController().signal });

async function update<T>(run: () => Promise<T>): Promise<T> {
  process.env[UPDATE_ENV] = "1";
  try {
    return await run();
  } finally {
    delete process.env[UPDATE_ENV];
  }
}

const search = tool({ name: "search", description: "Search products.", input: z.object({ q: z.string(), color: z.string().optional() }), signIn: "none", hints: { readOnly: true }, run: ({ q, color }) => ({ q, color: color ?? null }) });
const buy = tool({ name: "buy", description: "Buy a product.", input: z.object({ sku: z.string() }), signIn: "none", run: ({ sku }) => `bought ${sku}` });

test("chinwag mcp update writes the server's tools into the lock, and the agent then uses exactly those", async () => {
  const shop = await upstream([search, buy]);
  const lockFile = join(mkdtempSync(join(tmpdir(), "chinwag-lock-")), "mcp.lock.json");
  await update(() => mcpTools({ name: "shop", url: shop.url, lockFile }));
  const lock = JSON.parse(readFileSync(lockFile, "utf8")) as McpLock;
  assert.deepEqual(Object.keys(lock.servers.shop!.tools), ["buy", "search"]);
  assert.equal(lock.servers.shop!.url, shop.url);

  shop.swap([search, buy, tool({ name: "refund", description: "Refund.", input: z.object({}), signIn: "none", run: () => "ok" })]);
  const tools = await mcpTools({ name: "shop", url: shop.url, lockFile });
  assert.deepEqual(tools.map((t) => t.name).sort(), ["buy", "search"], "a tool the server added since is not offered");
  const found = tools.find((t) => t.name === "search")!;
  assert.equal(await found.run({ q: "mug" }, context()), JSON.stringify({ q: "mug", color: null }), "the server's text, as its model would read it");
  assert.equal(found.hints?.readOnly, true);
  assert.equal(tools.find((t) => t.name === "buy")!.hints?.readOnly, false, "no readOnlyHint is a write");
});

test("a tool the server changed or removed since the lock is refused with a clear error, not run", async () => {
  const shop = await upstream([search, buy]);
  const lockFile = join(mkdtempSync(join(tmpdir(), "chinwag-lock-")), "mcp.lock.json");
  await update(() => mcpTools({ name: "shop", url: shop.url, lockFile }));
  shop.swap([{ ...search, description: "Search products, now with prices." }]);
  const tools = await mcpTools({ name: "shop", url: shop.url, lockFile });
  await assert.rejects(async () => tools.find((t) => t.name === "search")!.run({ q: "mug" }, context()), /shop changed search since it was tested.*chinwag mcp update/);
  await assert.rejects(async () => tools.find((t) => t.name === "buy")!.run({ sku: "A1" }, context()), /shop no longer has buy/);
});

test("a server missing from the lock stops the agent at start, naming the command to run", async () => {
  const lockFile = join(mkdtempSync(join(tmpdir(), "chinwag-lock-")), "mcp.lock.json");
  await assert.rejects(mcpTools({ name: "shop", url: "http://127.0.0.1:9/mcp", lockFile }), /shop is not in .*mcp\.lock\.json\. Run chinwag mcp update/);
});

test("the model sees the server's own input schema, and placeholders for arguments it did not mean are left out", async () => {
  let received: unknown;
  const echo = tool({ name: "find", description: "Find.", input: z.object({ q: z.string(), color: z.string().optional(), tags: z.array(z.string()).optional() }), signIn: "none", run: (input) => ((received = input), "ok") });
  const shop = await upstream([echo]);
  const [find] = await mcpTools({ name: "shop", url: shop.url, live: true });
  const served = mcpServer({ name: "shop", version: "1", tools: [echo] }).descriptors[0]!.inputSchema;
  assert.deepEqual(toSpec(find!).parameters, served);
  await find!.run({ q: "mug", color: "", tags: [] }, context());
  assert.deepEqual(received, { q: "mug" });
});
