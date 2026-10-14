// Runs only the tests affected by what changed in this repository (staged, unstaged and untracked, against HEAD).
// A changed test file runs itself; a changed src file runs every test whose `// covers:` line lists it;
// a change to a file everything depends on runs all tests. The simulators package (simulators/) is
// included: its tests' `covers:` paths are relative to the repository root too. `npm test` in each package still
// runs its whole suite.
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const RUN_ALL = new Set([
  ...["src/types.ts", "src/index.ts", "src/agent.ts", "test/helpers.ts", "package.json", "package-lock.json", "tsconfig.json"],
  ...["simulators/src/index.ts", "simulators/package.json", "simulators/tsconfig.json"],
]);

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
const changed = new Set([...git("diff", "--name-only", "--relative", "HEAD"), ...git("ls-files", "--others", "--exclude-standard")]);

const tests = ["test", "simulators/test"].flatMap((dir) =>
  readdirSync(`${root}${dir}`).filter((f) => f.endsWith(".test.ts")).map((f) => `${dir}/${f}`).sort(),
);
const covers = (file: string) => readFileSync(`${root}${file}`, "utf8").match(/^\/\/ covers: (.*)$/m)?.[1].split(/\s+/) ?? [];

const chosen = new Map<string, string>();
const everything = [...changed].find((f) => RUN_ALL.has(f));
for (const file of tests) {
  if (everything) chosen.set(file, `${everything} changed, which runs every test`);
  else if (changed.has(file)) chosen.set(file, "changed itself");
  else {
    const hit = covers(file).filter((src) => changed.has(src));
    if (hit.length) chosen.set(file, `covers ${hit.join(", ")}`);
  }
}

if (chosen.size === 0) {
  console.log("No tests affected by the changes.");
  process.exit(0);
}
for (const [file, why] of chosen) console.log(`${file}: ${why}`);
const run = spawnSync(process.execPath, ["--test", ...chosen.keys()], { cwd: root, stdio: "inherit" });
process.exit(run.status ?? 1);
