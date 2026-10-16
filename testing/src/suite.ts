// A test suite on disk: tests/scenarios/*.yaml and tests/tools/*.yaml, each file hashed by its
// content so the cloud stores it once and a run records exactly which tests it ran.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { isMap, isSeq, LineCounter, parseDocument, type Node } from "yaml";
import { z } from "../../src/index.ts";

export interface SuiteFile {
  /** Relative to the tests folder: scenarios/latte-correction.yaml, tools/place_order.yaml. */
  path: string;
  hash: string;
  content: string;
}

export function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Every scenario and tool file under `testsDir`, in a stable order. */
export function loadSuite(testsDir: string): SuiteFile[] {
  const files: SuiteFile[] = [];
  for (const folder of ["scenarios", "tools"]) {
    const dir = join(testsDir, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".yaml")).sort()) {
      const content = readFileSync(join(dir, name), "utf8");
      files.push({ path: `${folder}/${name}`, hash: hashOf(content), content });
    }
  }
  return files;
}

/** One hash for the whole suite: runs are compared only when it matches. */
export function suiteHash(files: Array<{ path: string; hash: string }>): string {
  return hashOf(files.map((f) => `${f.path}:${f.hash}`).sort().join("\n"));
}

/** `{{ now [±<n>m|h|d|w]* [@ HH:MM] [| iso|date|time|weekday] }}`, spaces optional between the parts. */
const CLOCK = /^\s*now(?:\s*[+-]\s*\d+[mhdw])*(?:\s*@\s*(?:[01]\d|2[0-3]):[0-5]\d)?(?:\s*\|\s*(?:iso|date|time|weekday))?\s*$/;

/** What is wrong with the `{{ now ... }}` placeholders in `text`, or null. A placeholder is the test's clock
 * (`{{now}}`, `{{now + 7d | date}}`, `{{now + 6d @ 10:00}}`), filled by the cloud per run; any other `{{...}}` is left alone. */
export function placeholderProblem(text: string): string | null {
  for (const [whole, inner] of text.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    if (/^\s*now\b/.test(inner!) && !CLOCK.test(inner!)) {
      return `unknown placeholder ${whole}: write it like {{now + 3d}}, {{now - 2h | time}} or {{now + 1w @ 10:00 | date}}`;
    }
  }
  return null;
}

/** Every string in `value` whose placeholders are wrong, with where it is under `value`. */
function* placeholderProblems(value: unknown, path: PropertyKey[] = []): Generator<{ path: PropertyKey[]; problem: string }> {
  if (typeof value === "string") {
    const problem = placeholderProblem(value);
    if (problem) yield { path, problem };
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* placeholderProblems(value[i], [...path, i]);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) yield* placeholderProblems(item, [...path, key]);
  }
}

/** A value whose strings may hold placeholders, each checked. */
const withClock = <T extends z.ZodType>(schema: T) =>
  schema.superRefine((value, ctx) => {
    for (const { path, problem } of placeholderProblems(value)) ctx.addIssue({ code: "custom", message: problem, path });
  });

/** A time zone Intl knows. */
function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DDTHH:MM[:SS], optionally Z or ±HH:MM, naming a real moment. */
function isDateTime(text: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:Z|[+-](\d{2}):(\d{2}))?$/.exec(text);
  if (!m) return false;
  const [y, mo, d, h, mi, s = 0, oh = 0, om = 0] = m.slice(1).map((part) => (part === undefined ? undefined : Number(part)));
  const day = new Date(Date.UTC(y!, mo! - 1, d!));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo! - 1 && day.getUTCDate() === d && h! < 24 && mi! < 60 && s! < 60 && oh! < 24 && om! < 60;
}

/** A tool call the run must (`calls`) or must not (`never`) make: a tool name, or the tool with input fields it must have. */
const expectedCall = z.union(
  [
    z.string().min(1),
    z.strictObject({
      tool: z.string().min(1),
      /** Each field must equal the call's input field: nested objects in part, arrays and strings exactly. */
      args: withClock(z.record(z.string(), z.unknown())).optional(),
    }),
  ],
  { error: "a tool name, or { tool: <name>, args: { <field>: <value> } }" },
);

const scenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  /** Every platform it runs on; each is a run of its own, with its own result. */
  channels: z.array(z.enum(["sms", "whatsapp", "imessage", "telegram", "web"])).min(1),
  /** The IANA time zone of the test's clock; UTC when left out. */
  timezone: z.string().refine(isTimeZone, "not a time zone: use an IANA name such as America/New_York or UTC").optional(),
  /** The test's clock when each run starts, local to `timezone` unless it has an offset; the real time when left out.
   * YAML's default schema reads it as a string; a Date from another schema is taken as its UTC time. */
  now: z
    .preprocess((v) => (v instanceof Date ? v.toISOString().replace(/\.\d+Z$/, "Z") : v), z.string().refine(isDateTime, "not a date and time: write YYYY-MM-DDTHH:MM, with :SS, Z or an offset such as -04:00 if needed"))
    .optional(),
  person: z.object({
    persona: withClock(z.string()),
    goal: withClock(z.string()),
    knows: z.array(withClock(z.string())).optional(),
  }),
  opening: z
    .array(
      z
        .object({
          say: withClock(z.string()).default(""),
          /** A file the person sends with it (say is its caption): a path in the tests folder. */
          attach: z.object({ kind: z.enum(["image", "audio", "document"]), file: z.string().refine(inTests, "a path inside the tests folder, such as fixtures/receipt.jpg") }).optional(),
          after_ms: z.number().int().min(0).optional(),
        })
        .refine((step) => step.say || step.attach, "say something, attach a file, or both"),
    )
    .min(1),
  world: withClock(z.string()).optional(),
  max_turns: z.number().int().min(1).max(50).default(8),
  expect: z
    .object({
      outcome: z.array(withClock(z.string())).optional(),
      judge: z.array(withClock(z.string())).optional(),
      /** Each must be called at least once in the run; checked by code from the recorded calls. */
      calls: z.array(expectedCall).optional(),
      /** None may be called. */
      never: z.array(expectedCall).optional(),
    })
    .default({}),
});

const toolFileSchema = z.object({
  tool: z.string().min(1),
  behaviour: z.string().optional(),
  responses: z
    .array(
      z.object({
        when: z.string(),
        latency_ms: z.number().int().min(0),
        input: withClock(z.unknown()).optional(),
        output: withClock(z.unknown()).optional(),
        error: withClock(z.string()).optional(),
      }),
    )
    .min(1),
});

/** A relative path that stays inside the tests folder. */
function inTests(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.split(/[\\/]/).includes("..");
}

/** The type of a file a scenario attaches, from its extension. */
export function mimeOf(path: string): string {
  const types: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", pdf: "application/pdf", ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav" };
  return types[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream";
}

export type Scenario = z.infer<typeof scenarioSchema>;
export type ToolFile = z.infer<typeof toolFileSchema>;
export type ExpectedCall = z.infer<typeof expectedCall>;

/** Parse and check a scenario. The error has one line per problem: `file:line: field: what is wrong`. */
export function parseScenario(file: Pick<SuiteFile, "path" | "content">): Scenario {
  return parseFile(scenarioSchema, file);
}

export function parseToolFile(file: Pick<SuiteFile, "path" | "content">): ToolFile {
  return parseFile(toolFileSchema, file);
}

function parseFile<T extends z.ZodType>(schema: T, file: Pick<SuiteFile, "path" | "content">): z.infer<T> {
  const lines = new LineCounter();
  const doc = parseDocument(file.content, { lineCounter: lines });
  const at = (offset: number | undefined) => `${file.path}:${offset === undefined ? 1 : lines.linePos(offset).line}`;
  if (doc.errors.length) {
    // The YAML parser's own message ends with where it is and a drawing of the line; the prefix says where.
    throw new Error(doc.errors.map((e) => `${at(e.pos[0])}: ${e.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "")}`).join("\n"));
  }
  const result = schema.safeParse(doc.toJS());
  if (result.success) return result.data;
  throw new Error(result.error.issues.map((issue) => {
    const field = issue.path.map((key, i) => (typeof key === "number" ? `[${key}]` : `${i ? "." : ""}${String(key)}`)).join("");
    const what = /received undefined$/.test(issue.message) ? "missing" : issue.message;
    return `${at(offsetOf(doc.contents, issue.path))}: ${field ? `${field}: ` : ""}${what}`;
  }).join("\n"));
}

/** Where the deepest part of `path` that the file has starts: the value, or for a missing key the key that holds it. */
function offsetOf(root: unknown, path: PropertyKey[]): number | undefined {
  let node = root;
  let offset = (root as Node | null)?.range?.[0];
  let holder: number | undefined;
  for (const key of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => (p.key as { value?: unknown } | null)?.value === key);
      if (!pair) return holder ?? offset;
      holder = (pair.key as Node).range?.[0];
      node = pair.value;
    } else if (isSeq(node) && typeof key === "number" && node.items[key]) {
      holder = undefined;
      node = node.items[key];
    } else break;
    offset = (node as Node | null)?.range?.[0] ?? offset;
  }
  return offset;
}
