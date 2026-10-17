// `chinwag check`, from an agent's folder: whether its tools can be served over MCP exactly as
// declared, whether its CLI file (src/cli.ts) still matches them, and whether the skills it would
// send to MCP hosts name tools only chats have. Rules only, no model: what it reports is
// objectively wrong (errors, exit 1) or worth a look (warnings).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cliProblems, type CliConfig } from "../../cli/src/commands.ts";
import { CHAT_ONLY, describe, toolsProblems } from "../../mcp/src/describe.ts";
import { loadSkills, readAgentFolder } from "../../src/skills.ts";
import type { Tool } from "../../src/tools.ts";

export const CHECK_LINE = `  chinwag check [--json]    Check the agent's tools, CLI file and skills for MCP and the CLI`;

export async function checkCli(argv: string[], dir = process.cwd()): Promise<number> {
  const json = argv.includes("--json");
  const errors: string[] = [];
  const warnings: string[] = [];
  const agentFile = join(dir, "src/agent.ts");
  if (!existsSync(agentFile)) {
    console.error(`No src/agent.ts in ${dir}. Run chinwag check from the agent's folder.`);
    return 1;
  }
  const agent = await import(pathToFileURL(agentFile).href);
  const tools: Tool[] = Array.isArray(agent.tools) ? agent.tools : [];
  if (!Array.isArray(agent.tools)) errors.push("src/agent.ts exports no tools array");
  errors.push(...toolsProblems(tools));

  if (existsSync(join(dir, "agent"))) {
    for (const skill of loadSkills(readAgentFolder(join(dir, "agent")))) {
      const named = CHAT_ONLY.exec(skill.body);
      if (named) warnings.push(`skill ${skill.name}: names ${named[1]}, which MCP hosts and the CLI do not have`);
    }
  }

  const cliFile = join(dir, "src/cli.ts");
  if (existsSync(cliFile)) {
    const cli = (await import(pathToFileURL(cliFile).href)).cli as CliConfig | undefined;
    if (!cli) errors.push("src/cli.ts exports no cli (export const cli = defineCli({ ... }))");
    else {
      const described = tools.flatMap((t) => {
        try {
          return [describe(t)];
        } catch {
          return [];
        }
      });
      const found = cliProblems(cli, described);
      errors.push(...found.errors.map((e) => `src/cli.ts: ${e}`));
      warnings.push(...found.warnings.map((w) => `src/cli.ts: ${w}`));
    }
  }

  if (json) console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings }));
  else {
    for (const e of errors) console.log(`error  ${e}`);
    for (const w of warnings) console.log(`warn   ${w}`);
    console.log(errors.length ? `${errors.length} error${errors.length === 1 ? "" : "s"}.` : `No errors in ${tools.length} tool${tools.length === 1 ? "" : "s"}.`);
  }
  return errors.length ? 1 : 0;
}

/** `chinwag mcp update`: loads the agent with every mcpTools call writing its server's current tools to mcp.lock.json. */
export async function mcpUpdateCli(dir = process.cwd()): Promise<number> {
  const agentFile = join(dir, "src/agent.ts");
  if (!existsSync(agentFile)) {
    console.error(`No src/agent.ts in ${dir}. Run chinwag mcp update from the agent's folder.`);
    return 1;
  }
  const { UPDATE_ENV } = await import("../../mcp/src/client.ts");
  process.env[UPDATE_ENV] = "1";
  await import(pathToFileURL(agentFile).href);
  console.error(`Updated ${join(dir, "mcp.lock.json")}. Run chinwag check and the tests, then commit it.`);
  return 0;
}
