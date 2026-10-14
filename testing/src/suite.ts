// A test suite on disk: tests/scenarios/*.yaml and tests/tools/*.yaml, each file hashed by its
// content so the cloud stores it once and a run records exactly which tests it ran.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { parse } from "yaml";
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

const scenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  /** Every platform it runs on; each is a run of its own, with its own result. */
  channels: z.array(z.enum(["sms", "whatsapp", "imessage", "telegram", "web"])).min(1),
  person: z.object({
    persona: z.string(),
    goal: z.string(),
    knows: z.array(z.string()).optional(),
  }),
  opening: z
    .array(
      z
        .object({
          say: z.string().default(""),
          /** A file the person sends with it (say is its caption): a path in the tests folder. */
          attach: z.object({ kind: z.enum(["image", "audio", "document"]), file: z.string().refine(inTests, "a path inside the tests folder, such as fixtures/receipt.jpg") }).optional(),
          after_ms: z.number().int().min(0).optional(),
        })
        .refine((step) => step.say || step.attach, "say something, attach a file, or both"),
    )
    .min(1),
  world: z.string().optional(),
  max_turns: z.number().int().min(1).max(50).default(8),
  expect: z
    .object({
      outcome: z.array(z.string()).optional(),
      judge: z.array(z.string()).optional(),
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
        input: z.unknown().optional(),
        output: z.unknown().optional(),
        error: z.string().optional(),
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

/** Parse and check a scenario; the error names the file and what is wrong. */
export function parseScenario(file: Pick<SuiteFile, "path" | "content">): Scenario {
  const result = scenarioSchema.safeParse(parse(file.content));
  if (!result.success) throw new Error(`${file.path}: ${result.error.message}`);
  return result.data;
}

export function parseToolFile(file: Pick<SuiteFile, "path" | "content">): ToolFile {
  const result = toolFileSchema.safeParse(parse(file.content));
  if (!result.success) throw new Error(`${file.path}: ${result.error.message}`);
  return result.data;
}
