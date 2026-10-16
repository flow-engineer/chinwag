// covers: src/traces.ts src/agent.ts src/conversation.ts
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, tool, z, type AgentOptions, type Outbound } from "../src/index.ts";
import { tracesFromEnv } from "../src/traces.ts";
import { SMS, call, respond, scriptedModel } from "./helpers.ts";

const KEY = "trace_key_do-not-log-me";

/** A traces endpoint, played: each request is kept, and `next(n)` waits for the n-th. */
async function fakeEndpoint(status = 200) {
  const requests: Array<{ headers: IncomingMessage["headers"]; body: any; path: string }> = [];
  const waiters: Array<() => void> = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(text), path: req.url ?? "" });
      res.writeHead(status, { "content-type": "application/json" }).end("{}");
      waiters.splice(0).forEach((w) => w());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  async function next(n: number) {
    while (requests.length < n) await new Promise<void>((r) => waiters.push(r));
    return requests[n - 1];
  }
  return { url: `http://127.0.0.1:${port}`, requests, next, close: () => server.close() };
}

/** An SMS agent with one tool, tracing to `url`. */
function agentFor(url: string, content: boolean, intercept?: AgentOptions["intercept"]) {
  const dir = mkdtempSync(join(tmpdir(), "chinwag-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const sent: string[] = [];
  const sms = { name: "sms", kind: "sms" as const, info: SMS, phone: true, send: (_: string, o: Outbound) => void (o.type === "message" && sent.push(o.text)) };
  const lookup = tool({ name: "lookup", description: "Finds a slot.", input: z.object({ day: z.string() }), run: async ({ day }) => `free on ${day}` });
  const agent = createAgent({ dir, model: scripted.model, tools: [lookup], channels: [sms], debounceMs: 0, scheduleCheckMs: 0, id: "cafe", traces: { url, key: KEY, content, version: "v7" }, intercept });
  return { agent, sent, ...scripted };
}

/** One turn: the person asks, the agent acknowledges and looks it up, then answers. */
async function playTurn(h: ReturnType<typeof agentFor>, from: string, offset = 0) {
  await h.agent.message({ channel: "sms", from, message: "Can I move my check-in to Thursday?", messageId: `SM-${offset}` });
  (await h.nextCall(offset)).answer(respond(call("send_sms", { text: "One sec" }), call("lookup", { day: "thursday" })));
  (await h.nextCall(offset + 1)).answer(respond(call("send_sms", { text: "Done: Thursday at 10:00." })));
}

const attrs = (span: any) => Object.fromEntries(span.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));

test("each turn is one trace: the person's ids and channel, its model calls, tools and replies", async () => {
  const endpoint = await fakeEndpoint();
  const h = agentFor(endpoint.url, true);
  await playTurn(h, "+15550100123");
  const request = await endpoint.next(1);
  endpoint.close();

  assert.equal(request.path, "/v1/traces");
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  assert.equal(request.headers["content-type"], "application/json");
  const [resourceSpans] = request.body.resourceSpans;
  assert.deepEqual(attrs(resourceSpans.resource), { "service.name": "cafe", "telemetry.sdk.name": "chinwag", "chinwag.run_kind": "production", "service.version": "v7" });
  const spans = resourceSpans.scopeSpans[0].spans;
  assert.equal(new Set(spans.map((s: any) => s.traceId)).size, 1, "one trace");
  assert.match(spans[0].traceId, /^[0-9a-f]{32}$/);
  const roots = spans.filter((s: any) => !s.parentSpanId);
  assert.equal(roots.length, 1);
  const root = attrs(roots[0]);
  assert.equal(root["gen_ai.operation.name"], "invoke_agent");
  assert.match(String(root["chinwag.conversation_id"]), /^p_/);
  assert.equal(root["chinwag.contact_id"], root["chinwag.conversation_id"]);
  assert.equal(root["chinwag.channel"], "sms");
  assert.equal(root["chinwag.message_id"], "SM-0");
  assert.equal(root["chinwag.user_message"], "Can I move my check-in to Thursday?");
  assert.ok(BigInt(roots[0].endTimeUnixNano) >= BigInt(roots[0].startTimeUnixNano));

  const children = spans.filter((s: any) => s.parentSpanId === roots[0].spanId);
  assert.equal(children.length, spans.length - 1, "every other span hangs off the root");
  const replies = children.filter((s: any) => attrs(s)["chinwag.agent_reply"] !== undefined).map((s: any) => attrs(s)["chinwag.agent_reply"]);
  assert.deepEqual(replies, ["One sec", "Done: Thursday at 10:00."], "the replies exactly as sent");
  const tool = attrs(children.find((s: any) => s.name === "execute_tool lookup"));
  assert.equal(tool["gen_ai.tool.name"], "lookup");
  assert.equal(tool["gen_ai.tool.call.arguments"], '{"day":"thursday"}');
  assert.equal(tool["gen_ai.tool.call.result"], "free on thursday");
  assert.ok(children.filter((s: any) => attrs(s)["gen_ai.operation.name"] === "chat").length >= 2, "a span per model call");
});

test("a message intercept answers, and its reply, are traces of their own, also while a turn is open", async () => {
  const endpoint = await fakeEndpoint();
  const h = agentFor(endpoint.url, true, (_id, text) => (/chest pain/.test(text) ? "Call 911 now." : null));
  const a = await h.agent.message({ channel: "sms", from: "+15550100123", message: "Can I move my check-in?", messageId: "SM-1" });
  const thinking = await h.nextCall(0);
  await h.agent.message({ channel: "sms", from: "+15550100123", message: "chest pain", messageId: "SM-2" });
  thinking.answer(respond(call("send_sms", { text: "Yes, to when?" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  await h.agent.flushTraces();
  endpoint.close();
  const traces = new Map<string, any[]>();
  for (const request of endpoint.requests) for (const span of request.body.resourceSpans[0].scopeSpans[0].spans) traces.set(span.traceId, [...(traces.get(span.traceId) ?? []), span]);
  const shown = [...traces.values()].map((spans) => {
    const root = attrs(spans.find((s: any) => !s.parentSpanId));
    return [root["chinwag.user_message"] ?? null, spans.flatMap((s: any) => attrs(s)["chinwag.agent_reply"] ?? []), spans.some((s: any) => s.name.startsWith("chat"))];
  });
  assert.deepEqual(shown.sort((a, b) => String(a[0]).localeCompare(String(b[0]))), [
    ["Can I move my check-in?", ["Yes, to when?"], true],
    ["chest pain", [], false],
    [null, ["Call 911 now."], false],
  ]);
});

test("under chinwag test, every trace says it is a test's and names the test session, so it is kept apart from real conversations", async (t) => {
  process.env.CHINWAG_RUN_KIND = "test";
  process.env.CHINWAG_TEST_SESSION = "tse_01JTESTSESSION0000000000000";
  t.after(() => {
    delete process.env.CHINWAG_RUN_KIND;
    delete process.env.CHINWAG_TEST_SESSION;
  });
  const endpoint = await fakeEndpoint();
  const h = agentFor(endpoint.url, false);
  await playTurn(h, "+15550100123");
  const request = await endpoint.next(1);
  endpoint.close();
  const [resourceSpans] = request.body.resourceSpans;
  assert.equal(attrs(resourceSpans.resource)["chinwag.run_kind"], "test");
  const root = resourceSpans.scopeSpans[0].spans.find((s: any) => !s.parentSpanId);
  assert.equal(attrs(root)["chinwag.test.session"], "tse_01JTESTSESSION0000000000000");
});

test("without content on, traces hold no text: no messages, replies, tool inputs or results", async () => {
  const endpoint = await fakeEndpoint();
  const h = agentFor(endpoint.url, false);
  await playTurn(h, "+15550100123");
  const request = await endpoint.next(1);
  endpoint.close();
  const all = request.body.resourceSpans[0].scopeSpans[0].spans.flatMap((s: any) => s.attributes.map((a: any) => a.key));
  for (const key of ["chinwag.user_message", "chinwag.agent_reply", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"]) assert.ok(!all.includes(key), key);
  assert.ok(all.includes("chinwag.conversation_id"));
  assert.doesNotMatch(JSON.stringify(request.body), /Thursday|thursday/);
});

test("the endpoint refusing traces never touches the conversation, is logged once, and never shows the key", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
  const endpoint = await fakeEndpoint(500);
  const h = agentFor(endpoint.url, true);
  await playTurn(h, "+15550100123");
  await endpoint.next(1);
  await h.agent.flushTraces();
  await playTurn(h, "+15550100123", 2);
  await endpoint.next(2);
  await h.agent.flushTraces();
  endpoint.close();
  assert.deepEqual(h.sent, ["One sec", "Done: Thursday at 10:00.", "One sec", "Done: Thursday at 10:00."]);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /HTTP 500/);
  assert.doesNotMatch(warnings.join(""), /do-not-log-me/);
});

test("from the environment: a trace key goes to flow.engineer/observe unless a URL is set, content only with CHINWAG_TRACES_CONTENT=1, never under node --test", () => {
  assert.equal(tracesFromEnv({}), undefined);
  assert.deepEqual(tracesFromEnv({ CHINWAG_TRACES_KEY: KEY }), { key: KEY, url: "https://flow.engineer/observe", content: false });
  assert.deepEqual(tracesFromEnv({ CHINWAG_TRACES_KEY: KEY, CHINWAG_TRACES_URL: "  " }), { key: KEY, url: "https://flow.engineer/observe", content: false });
  assert.deepEqual(tracesFromEnv({ CHINWAG_TRACES_KEY: KEY, CHINWAG_TRACES_URL: "https://example.test/traces" }), { key: KEY, url: "https://example.test/traces", content: false });
  assert.deepEqual(tracesFromEnv({ CHINWAG_TRACES_KEY: KEY, CHINWAG_TRACES_URL: "https://example.test/traces", CHINWAG_TRACES_CONTENT: "1" }), { key: KEY, url: "https://example.test/traces", content: true });
  assert.equal(tracesFromEnv({ CHINWAG_TRACES_KEY: KEY, NODE_TEST_CONTEXT: "child-v8" }), undefined);
});
