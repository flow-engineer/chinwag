// `chinwag check-endpoint <url>`: checks an agent's HTTP endpoint against the contract in spec/
// (agent-endpoint.openapi.yaml, request.schema.json, response.schema.json) before any test run. It
// POSTs a fixed set of synthetic messages, as `chinwag test --agent-url` would, and checks each
// answer: the status and body (the same rules a run applies, testing/src/http-agent.ts), the
// response schema, what WhatsApp can show, and that every id a reply names is one of the person's
// messages. No cloud, no key and no model call on Chinwag's side: whatever the agent does with the
// messages (its own model, its tools) runs on its side.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WHATSAPP, z } from "../../src/index.ts";
import { checkReply, postMessage, TurnError, type HttpAgentRequest } from "./http-agent.ts";
import { packageRoot } from "./new.ts";

/** One synthetic conversation: its messages go one at a time, each once the last one's answer is in. */
interface Case {
  id: string;
  title: string;
  messages: Array<{ messageId: string; message: HttpAgentRequest["message"] }>;
}

/** A 1×1 PNG. */
const PHOTO = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const CASES: Case[] = [
  { id: "message", title: "a typed message", messages: [{ messageId: "m1", message: { text: "hi, what time are you open today?" } }] },
  {
    id: "double-text",
    title: "two messages in a row, in one conversation",
    messages: [
      { messageId: "m1", message: { text: "can i get a large latte" } },
      { messageId: "m2", message: { text: "oat milk actually" } },
    ],
  },
  { id: "file", title: "a photo with no caption", messages: [{ messageId: "m1", message: { text: "", attachments: [{ kind: "image", mime: "image/png", name: "photo.png", data: PHOTO }] } }] },
  {
    id: "message-ids",
    title: "a tapped button quoting the agent, with an id to react to",
    messages: [
      { messageId: "m1", message: { text: "do you have oat milk?" } },
      { messageId: "m2", message: { text: "Oat", choice: { title: "Oat" }, replyTo: { text: "Which milk would you like?", fromAgent: true } } },
    ],
  },
  { id: "no-reply", title: "a message that may need no answer", messages: [{ messageId: "m1", message: { text: "ok 👍" } }] },
];

export interface CaseResult {
  id: string;
  title: string;
  pass: boolean;
  /** What went wrong, or what came back. */
  detail: string;
  /** Each message's replies, as the endpoint answered them. */
  answers: Array<{ messageId: string; replies: unknown[] }>;
}

const schemaFile = (name: string) => JSON.parse(readFileSync(join(packageRoot(), "spec", name), "utf8"));

function schemas() {
  const response = schemaFile("response.schema.json");
  const shape = z.fromJSONSchema({ ...response, properties: { replies: { type: "array" } } });
  // One schema per reply type, so a bad reply is reported against its own type.
  const replies = new Map(Object.keys(response.$defs).map((type) => [type, z.fromJSONSchema({ $schema: response.$schema, $defs: response.$defs, $ref: `#/$defs/${type}` })]));
  return { shape, replies };
}

const issues = (error: z.ZodError, at: string) => error.issues.map((i) => `${[at, ...i.path].join(".")}: ${i.message}`).join("; ");

/** Why this answer breaks the contract, or null. `ids` are the person's messages so far. */
function problem(replies: unknown[], ids: string[], s: ReturnType<typeof schemas>): string | null {
  for (const [n, reply] of replies.entries()) {
    const at = `replies[${n}]`;
    const type = (reply as { type?: unknown } | null)?.type;
    const schema = typeof type === "string" ? s.replies.get(type) : undefined;
    if (!schema) return `${at}.type: must be one of ${[...s.replies.keys()].join(", ")}`;
    const valid = schema.safeParse(reply);
    if (!valid.success) return issues(valid.error, at);
    const shown = checkReply(reply, WHATSAPP);
    if ("refused" in shown) return `${at}: would not be sent on WhatsApp: ${shown.refused}`;
    const r = reply as { replyTo?: string; messageId?: string; messageIds?: string[] };
    for (const id of [r.replyTo, r.messageId, ...(r.messageIds ?? [])]) {
      if (id !== undefined && !ids.includes(id)) return `${at} names ${JSON.stringify(id)}, which is not one of the person's messages (${ids.join(", ")})`;
    }
  }
  return null;
}

const described = (answers: CaseResult["answers"]) =>
  answers
    .map((a) => {
      const types = a.replies.map((r) => String((r as { type?: unknown }).type));
      return `${a.messageId}: ${types.length ? `${types.length} ${types.length === 1 ? "reply" : "replies"} (${types.join(", ")})` : "no reply"}`;
    })
    .join("; ");

export async function checkEndpoint(options: { url: string; token?: string; timeoutMs?: number }): Promise<CaseResult[]> {
  const s = schemas();
  const timeoutMs = options.timeoutMs ?? 60_000;
  // Fresh conversations on every check, in the cloud's form, so an endpoint that keeps history never mixes runs.
  const session = `check_${randomBytes(4).toString("hex")}`;
  const results: CaseResult[] = [];
  for (const c of CASES) {
    const conversationId = `whatsapp:${session}.${c.id}.whatsapp.1`;
    const answers: CaseResult["answers"] = [];
    let failed: string | null = null;
    for (const [n, { messageId, message }] of c.messages.entries()) {
      let replies: unknown[];
      try {
        replies = await postMessage(options, timeoutMs, { conversationId, messageId, channel: "whatsapp", message });
      } catch (error) {
        failed = `${messageId}: ${error instanceof TurnError ? error.message : (error as Error).message}`;
        break;
      }
      answers.push({ messageId, replies });
      const wrong = problem(replies, c.messages.slice(0, n + 1).map((m) => m.messageId), s);
      if (wrong) {
        failed = `${messageId}: ${wrong}`;
        break;
      }
    }
    results.push({ id: c.id, title: c.title, pass: failed === null, detail: failed ?? described(answers), answers });
  }
  return results;
}

const USAGE = `Usage: chinwag check-endpoint <url> [--token-env NAME] [--agent-timeout <s>] [--json]

Checks an agent's HTTP endpoint against Chinwag's contract (spec/agent-endpoint.openapi.yaml) with
a fixed set of synthetic messages. No cloud, no key, no model call on Chinwag's side.

  --token-env NAME     Send the value of NAME as authorization: Bearer <value>
                       (default: CHINWAG_AGENT_TOKEN, when it is set)
  --agent-timeout <s>  How long one message waits for its answer (default: 60)
  --json               Print the results as JSON

Exit status: 0 when every case passed, 1 otherwise.`;

/** The command: prints one line per case (or JSON) and returns the exit status. */
export async function checkEndpointCli(args: string[], env: Record<string, string | undefined> = process.env, print = console.log, printError = console.error): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { "token-env": { type: "string" }, "agent-timeout": { type: "string", default: "60" }, json: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false } } });
  } catch (error) {
    printError(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    print(USAGE);
    return 0;
  }
  const url = positionals.length === 1 ? positionals[0]! : "";
  if (!/^https?:\/\/[^/]/.test(url) || !URL.canParse(url)) {
    printError(`check-endpoint takes one http:// or https:// URL, such as http://localhost:3000/chinwag.\n\n${USAGE}`);
    return 1;
  }
  const timeout = Number(values["agent-timeout"]);
  if (!(timeout > 0)) {
    printError("--agent-timeout must be a number of seconds above 0.");
    return 1;
  }
  const tokenEnv = values["token-env"];
  const token = (tokenEnv ? env[tokenEnv] : env.CHINWAG_AGENT_TOKEN) || undefined;
  if (tokenEnv && !token) {
    printError(`${tokenEnv} is not set.`);
    return 1;
  }
  const results = await checkEndpoint({ url, token, timeoutMs: timeout * 1000 });
  const passed = results.filter((r) => r.pass).length;
  if (values.json) print(JSON.stringify({ url, passed: passed === results.length, cases: results }, null, 2));
  else {
    for (const r of results) print(`${r.pass ? "PASS" : "FAIL"}  ${r.id} (${r.title}): ${r.detail}`);
    print(`\n${passed} of ${results.length} cases passed.`);
  }
  return passed === results.length ? 0 : 1;
}
