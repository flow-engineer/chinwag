// Pip's tools and skills as an MCP server, for Claude, ChatGPT or any MCP host: `npm run mcp`.
// The same tools the chat agent uses; no model key needed, since the host brings its own model.

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mcpServer } from "../../../mcp/src/index.ts";
import { tools } from "./tools.ts";

export const mcp = mcpServer({
  name: "bean-and-leaf",
  version: "1.0.0",
  tools,
  dir: fileURLToPath(new URL("../agent", import.meta.url)),
  // The café has no accounts yet, so every tool answers without sign-in. With accounts, add
  // auth: { issuer, resource, scopes, verify } (the chinwag-auth skill).
});

const port = Number(process.env.MCP_PORT ?? 8790);
createServer((req, res) => void mcp.node(req, res)).listen(port, "127.0.0.1", () => {
  console.log(`Pip's MCP server: http://127.0.0.1:${port}/mcp`);
  console.log(`Try it in Claude Code: claude mcp add --transport http bean-and-leaf http://127.0.0.1:${port}/mcp`);
});
