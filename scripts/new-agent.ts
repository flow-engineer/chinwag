// Starts a new agent from the café example: `npm run new -- <name>` copies examples/cafe to
// agents/<name>/ (the same depth, so its imports of src/ and simulators/src/ work unchanged) and
// renames its package. agents/ is git-ignored, so your agents never collide with a `git pull`.
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkName } from "../testing/src/new.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const LEFT_OUT = new Set([".env", "node_modules"]);

/** Copies the café to `<agents>/<name>` and returns the new folder. */
export function newAgent(name: string, options: { source?: string; agents?: string } = {}): string {
  checkName(name);
  const source = options.source ?? join(root, "examples", "cafe");
  const dir = join(options.agents ?? join(root, "agents"), name);
  if (existsSync(dir)) throw new Error(`${dir} already exists: pick another name or remove it.`);
  cpSync(source, dir, { recursive: true, filter: (path) => !LEFT_OUT.has(basename(path)) });
  const file = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.name = name;
  pkg.description = `${name}: a Chinwag agent, started from the café example.`;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  return dir;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2] ?? "";
  try {
    newAgent(name);
  } catch (error) {
    console.error(name ? (error as Error).message : "Usage: npm run new -- <name>");
    process.exit(1);
  }
  console.log(`Made agents/${name}/ from the café example (Pip). Next:
  1. Add one model key to agents/${name}/.env: OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY
  2. Run it: cd agents/${name} && npm start, then open the link it prints
  3. Point your coding agent at coding-agents/ (skill.md first) and tell it what to build`);
}
