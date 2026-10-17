// chinwag/cli: an organization's command line over its MCP server (the same tools, sign-in and
// gating as Claude or ChatGPT get). `defineCli` is the team's CLI file; `runCli` runs it. Needs
// @modelcontextprotocol/client and @stricli/core, optional peers of chinwag.

export { cliProblems, commandTable, defineCli, derivedName, skillFile, type CliConfig, type CliContext, type CommandConfig, type CustomCommand, type ToolCommand, type ToolInfo } from "./commands.ts";
export { EXIT, processIO, runCli, type CliIO } from "./run.ts";
