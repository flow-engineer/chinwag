// covers: scripts/new-agent.ts testing/src/new.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newAgent } from "../scripts/new-agent.ts";
import { newStandalone } from "../testing/src/new.ts";

test("npm run new copies the café under its name, renamed, and refuses bad or taken names", () => {
  const agents = mkdtempSync(join(tmpdir(), "chinwag-agents-"));
  const dir = newAgent("my-agent", { agents });
  assert.equal(dir, join(agents, "my-agent"));
  assert.ok(existsSync(join(dir, "src", "agent.ts")));
  assert.ok(existsSync(join(dir, "agent", "AGENTS.md")));
  assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name, "my-agent");
  assert.throws(() => newAgent("my-agent", { agents }), /already exists/);
  for (const bad of ["", "My-Agent", "my_agent", "../up", "-x", "a--b"]) assert.throws(() => newAgent(bad, { agents }), /not a usable name/, bad);
});

test("chinwag new makes an agent of its own: chinwag imports, a package on this version that npm refuses to install on an older Node, and the skills", () => {
  const into = mkdtempSync(join(tmpdir(), "chinwag-new-"));
  const dir = newStandalone("my-agent", { into });
  assert.equal(dir, join(into, "my-agent"));
  const main = readFileSync(join(dir, "src", "main.ts"), "utf8");
  assert.match(main, /from "chinwag\/simulators"/);
  assert.match(readFileSync(join(dir, "src", "agent.ts"), "utf8"), /from "chinwag"/);
  assert.doesNotMatch(main + readFileSync(join(dir, "src", "tools.ts"), "utf8"), /\.\.\/\.\.\//);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "my-agent");
  assert.equal(pkg.dependencies.chinwag, `^${own.version}`);
  assert.equal(pkg.scripts.test, "chinwag test");
  assert.equal(pkg.engines.node, own.engines.node);
  assert.equal(readFileSync(join(dir, ".npmrc"), "utf8"), "engine-strict=true\n");
  // The key and each test session's results (.chinwag/last-session.json) stay out of git.
  assert.deepEqual(readFileSync(join(dir, ".gitignore"), "utf8").split("\n").filter(Boolean), ["node_modules/", ".env", ".chinwag/"]);
  assert.equal(JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8")).extends, undefined);
  for (const skill of ["chinwag", "chinwag-tools", "chinwag-tests"]) assert.ok(existsSync(join(dir, ".claude", "skills", skill, "SKILL.md")), skill);
  assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.ok(existsSync(join(dir, "tests", "scenarios")));
  const env = readFileSync(join(dir, ".env.example"), "utf8");
  for (const key of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "CHINWAG_CLOUD_KEY", "CHINWAG_TRACES_KEY"]) assert.match(env, new RegExp(`^${key}=$`, "m"), key);
  assert.match(env, /^CHINWAG_CLOUD=https:\/\/flow\.engineer\/observe$/m);
  assert.match(env, /^CHINWAG_TRACES_URL=https:\/\/flow\.engineer\/observe$/m);
  assert.throws(() => newStandalone("my-agent", { into }), /already exists/);
  assert.throws(() => newStandalone("My_Agent", { into }), /not a usable name/);
});
