// chinwag/mcp: an agent's tools and skills as an MCP server, and other MCP servers' tools as an
// agent's. Needs @modelcontextprotocol/server (serving) or @modelcontextprotocol/client (using),
// optional peers of chinwag installed only by agents that turn MCP on.

export { mcpServer, type McpAuth, type McpIdentity, type McpServerHandle, type McpServerOptions } from "./server.ts";
export { mcpTools, fingerprint, type McpDescriptor, type McpLock, type McpToolsOptions } from "./client.ts";
export { describe, titleOf, toolProblems, toolsProblems, type McpToolDescriptor, type Scopes } from "./describe.ts";
