// covers: cli/src/run.ts cli/src/commands.ts cli/src/auth.ts
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { defineCli, runCli, type CliConfig, type CliIO } from "../cli/src/index.ts";
import { mcpServer, type McpServerOptions } from "../mcp/src/index.ts";
import { tool } from "../src/index.ts";

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function listen(handler: RequestListener): Promise<string> {
  const http = createServer(handler);
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}

async function serve(options: Omit<McpServerOptions, "name" | "version">): Promise<string> {
  const handle = mcpServer({ name: "acme", version: "1", ...options });
  return `${await listen((req, res) => void handle.node(req, res))}/mcp`;
}

function io(interactive = false, answer = false) {
  const streams = { out: "", err: "" };
  const channel: CliIO = { write: (t) => void (streams.out += t), writeError: (t) => void (streams.err += t), interactive, confirm: async () => answer };
  return {
    channel,
    get out() {
      return streams.out;
    },
    get err() {
      return streams.err;
    },
  };
}

const orders = [
  { order_id: "BL-1042", status: "ready", total: 4.8, items: ["latte"] },
  { order_id: "BL-1043", status: "making", total: 9.6, items: ["chai", "chai"] },
];
const listOrders = tool({
  name: "list_orders",
  description: "Their orders.",
  input: z.object({ status: z.enum(["ready", "making"]).optional(), limit: z.number().int().optional() }),
  output: z.object({ orders: z.array(z.object({ order_id: z.string(), status: z.string(), total: z.number(), items: z.array(z.string()) })) }),
  signIn: "none",
  hints: { readOnly: true },
  run: ({ status, limit }) => ({ orders: orders.filter((o) => !status || o.status === status).slice(0, limit ?? 10) }),
});
const getOrder = tool({ name: "get_order", description: "One order.", input: z.object({ order_id: z.string() }), signIn: "none", hints: { readOnly: true }, run: ({ order_id }) => orders.find((o) => o.order_id === order_id) ?? null });
let cancelled: string[] = [];
const cancelOrder = tool({ name: "cancel_order", description: "Cancel an order.", input: z.object({ order_id: z.string() }), signIn: "none", run: ({ order_id }) => (cancelled.push(order_id), { cancelled: order_id }) });

const acme = (server: string): CliConfig =>
  defineCli({
    name: "acme",
    server,
    commands: {
      "order list": { tool: "list_orders", columns: ["order_id", "status", "total"], alias: "orders" },
      "order view": { tool: "get_order", args: ["order_id"] },
    },
  });

test("commands come from the CLI file and the tools: positionals, flags, --json and --fields", async () => {
  const cli = acme(await serve({ tools: [listOrders, getOrder, cancelOrder] }));
  const view = io();
  assert.equal(await runCli(cli, ["order", "view", "BL-1042", "--json", "--fields", "order_id,status"], view.channel), 0);
  assert.deepEqual(JSON.parse(view.out), { order_id: "BL-1042", status: "ready" });

  const table = io();
  assert.equal(await runCli(cli, ["orders", "--status", "making"], table.channel), 0);
  assert.equal(table.out, "ORDER_ID  STATUS  TOTAL\nBL-1043   making  9.6\n");
});

test("a group's help lists its subcommands, and the top level lists groups and commands", async () => {
  const cli = acme(await serve({ tools: [listOrders, getOrder, cancelOrder] }));
  for (const argv of [["order"], ["order", "-h"]]) {
    const group = io();
    assert.equal(await runCli(cli, argv, group.channel), 0);
    assert.match(group.out, /COMMANDS\n {2}list +Their orders\.|COMMANDS\n {2}list +List orders/);
    assert.match(group.out, /\n {2}view +One order|\n {2}view +Get order/);
  }
  const top = io();
  assert.equal(await runCli(cli, ["--help"], top.channel), 0);
  assert.match(top.out, /\n {2}order +list, view\n/, "the group, with its subcommands as its line");
  assert.match(top.out, /\n {2}cancel-order +Cancel order\n/, "a tool the file does not name keeps its own name");
  assert.doesNotMatch(top.out.slice(top.out.indexOf("COMMANDS")), /\n {2}(list|view) /, "subcommands are not listed at the top");
});

test("a write shows its call with --dry-run, and one that may delete needs --yes without a terminal", async () => {
  cancelled = [];
  const cli = acme(await serve({ tools: [listOrders, getOrder, cancelOrder] }));
  const dry = io();
  assert.equal(await runCli(cli, ["cancel-order", "--order-id", "BL-1042", "--dry-run", "--json"], dry.channel), 0);
  assert.deepEqual(JSON.parse(dry.out), { dryRun: true, tool: "cancel_order", arguments: { order_id: "BL-1042" } });

  const refused = io();
  assert.equal(await runCli(cli, ["cancel-order", "--order-id", "BL-1042"], refused.channel), 4);
  assert.match(refused.err, /run it again with --yes/);
  const declined = io(true, false);
  assert.equal(await runCli(cli, ["cancel-order", "--order-id", "BL-1042"], declined.channel), 4);
  assert.deepEqual(cancelled, [], "nothing was sent before a yes");

  assert.equal(await runCli(cli, ["cancel-order", "--order-id", "BL-1042", "--yes"], io().channel), 0);
  assert.deepEqual(cancelled, ["BL-1042"]);
});

test("wrong arguments exit 2 with what is wrong and the help to read, before anything is sent", async () => {
  const cli = acme(await serve({ tools: [listOrders, getOrder, cancelOrder] }));
  const unknown = io();
  assert.equal(await runCli(cli, ["order", "list", "--colour", "red"], unknown.channel), 2);
  assert.match(unknown.err, /--colour/);
  assert.match(unknown.err, /Run `acme order list --help`/);
  const missing = io();
  assert.equal(await runCli(cli, ["order", "view"], missing.channel), 2);
  assert.match(missing.err, /order_id/);
  const badEnum = io();
  assert.equal(await runCli(cli, ["orders", "--status", "lost"], badEnum.channel), 2);
  const typo = io();
  assert.equal(await runCli(cli, ["ordr"], typo.channel), 2);
  assert.match(typo.err, /did you mean `order`/);
});

test("auth login signs in on the organization's own login, and the token is kept at mode 600", async () => {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "chinwag-cli-"));
  let issuer = "";
  issuer = await listen(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const body = await new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c)).on("end", () => resolve(b));
    });
    const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    }
    if (url.pathname === "/register") return json(201, { ...JSON.parse(body), client_id: "cli-1" });
    if (url.pathname === "/authorize") {
      // The person signs in on the organization's page; here the page approves at once.
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", "code-1");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      back.searchParams.set("iss", issuer);
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (url.pathname === "/token") return json(200, { access_token: "tok-1", token_type: "Bearer", expires_in: 3600, refresh_token: "ref-1" });
    res.writeHead(404).end();
  });
  const mine = tool({ name: "my_orders", description: "Their orders.", input: z.object({}), hints: { readOnly: true }, run: (_i, ctx) => ({ for: ctx.key }) });
  const server = await serve({ tools: [mine], auth: { issuer, verify: (t) => (t === "tok-1" ? { key: "user-7" } : null) } });
  const cli: CliConfig = {
    ...defineCli({ name: "acme", server }),
    openUrl: async (link) => {
      const page = await fetch(link, { redirect: "manual" });
      await fetch(page.headers.get("location")!);
    },
  };

  const before = io();
  assert.equal(await runCli(cli, ["my-orders"], before.channel), 3, "signed out, a signed-in tool asks for sign-in");
  assert.match(before.err, /acme auth login/);

  assert.equal(await runCli(cli, ["auth", "login"], io().channel), 0);
  assert.equal(statSync(join(process.env.XDG_CONFIG_HOME, "acme", "auth.json")).mode & 0o777, 0o600);
  const after = io();
  assert.equal(await runCli(cli, ["my-orders", "--json"], after.channel), 0);
  assert.deepEqual(JSON.parse(after.out), { for: "user-7" });
});
