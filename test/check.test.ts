// covers: testing/src/check.ts mcp/src/describe.ts cli/src/commands.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { checkCli } from "../testing/src/check.ts";

const chinwag = pathToFileURL(join(import.meta.dirname, "../src/index.ts")).href;
const cliModule = pathToFileURL(join(import.meta.dirname, "../cli/src/index.ts")).href;

function agentFolder(tools: string, cli?: string, skill?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chinwag-check-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src/agent.ts"), `import { tool, z } from ${JSON.stringify(chinwag)};\nexport const tools = [${tools}];\n`);
  if (cli) writeFileSync(join(dir, "src/cli.ts"), `import { defineCli } from ${JSON.stringify(cliModule)};\nexport const cli = defineCli(${cli});\n`);
  if (skill) {
    mkdirSync(join(dir, "agent/skills/orders"), { recursive: true });
    writeFileSync(join(dir, "agent/skills/orders/SKILL.md"), `---\nname: orders\ndescription: orders\n---\n${skill}\n`);
  }
  return dir;
}

async function check(dir: string): Promise<{ code: number; errors: string[]; warnings: string[] }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => void lines.push(line);
  try {
    const code = await checkCli(["--json"], dir);
    return { code, ...JSON.parse(lines.at(-1)!) };
  } finally {
    console.log = log;
  }
}

const listOrders = `tool({ name: "list_orders", description: "Their orders.", input: z.object({ status: z.string().optional() }), output: z.object({ orders: z.array(z.object({ order_id: z.string(), total: z.number() })) }), hints: { readOnly: true }, run: () => ({ orders: [] }) })`;
const getOrder = `tool({ name: "get_order", description: "One order.", input: z.object({ order_id: z.string() }), run: () => null })`;

test("a tool that cannot be served exactly over MCP is an error, by rule", async () => {
  const dated = `tool({ name: "book", description: "Book, then confirm with send_whatsapp.", input: z.object({ when: z.date() }), run: () => "ok" })`;
  const result = await check(agentFolder(dated));
  assert.equal(result.code, 1);
  assert.deepEqual(result.errors, [
    "tool book: the description names send_whatsapp, a tool only chats have",
    "tool book: input has no exact JSON Schema (Date cannot be represented in JSON Schema)",
  ]);
});

test("the CLI file is checked against the tools, and a tool it does not name is only a warning", async () => {
  const cli = `{ name: "acme", commands: {
    "order list": { tool: "list_orders", columns: ["order_id", "placed_at"] },
    "order view": { tool: "get_order", args: ["id"] },
    "refund": { tool: "refund_order" },
    "order": { tool: "list_orders" },
  } }`;
  const result = await check(agentFolder(`${listOrders}, ${getOrder}`, cli));
  assert.equal(result.code, 1);
  assert.deepEqual(result.errors, [
    `src/cli.ts: command "order list": columns names placed_at, which list_orders's output does not have`,
    `src/cli.ts: command "order view": args names id, which get_order's input does not have`,
    `src/cli.ts: command "refund": no tool named refund_order on the server`,
    `src/cli.ts: command "order" ("order"): it is also the group of "order list"; a word is a command or a group, not both`,
    `src/cli.ts: command "order" ("order"): it is also the group of "order view"; a word is a command or a group, not both`,
  ]);

  const clean = await check(agentFolder(`${listOrders}, ${getOrder}`, `{ name: "acme", commands: { "order list": { tool: "list_orders", columns: ["order_id", "total"] } } }`, "Always confirm with send_sms first."));
  assert.equal(clean.code, 0);
  assert.deepEqual(clean.warnings, [
    "skill orders: names send_sms, which MCP hosts and the CLI do not have",
    `src/cli.ts: tool get_order has no command in the CLI file; it is reachable as "get-order"`,
  ]);
});
