#!/usr/bin/env node
// The café's command line, over its MCP server (npm run mcp in another terminal):
//   npm run cli -- order -h
//   npm run cli -- order place --name Sam --items '[{"item":"Latte","size":"large","milk":"oat"}]'
//   npm run cli -- order status BL-1040 --json
// (npm reads flags before `--` as its own: keep the `--`.) Installed, it is the `cafe` command.
// Every tool is already a command under its own name; this file adds the words and arguments.

import { fileURLToPath } from "node:url";
import { defineCli, runCli } from "../../../cli/src/index.ts";

export const cli = defineCli({
  name: "cafe",
  server: process.env.CAFE_SERVER ?? "http://127.0.0.1:8790/mcp",
  description: "Bean & Leaf's menu and pickup orders",
  groups: { order: "Place and track pickup orders" },
  commands: {
    menu: { tool: "get_menu", columns: ["item", "milks", "allergens"] },
    "order place": { tool: "place_order", examples: [`cafe order place --name Sam --items '[{"item":"Latte","size":"large","milk":"oat"}]'`] },
    "order status": { tool: "order_status", args: ["order_id"], view: ["found", "status", "ready_by"], examples: ["cafe order status BL-1040"] },
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await runCli(cli, process.argv.slice(2)));
