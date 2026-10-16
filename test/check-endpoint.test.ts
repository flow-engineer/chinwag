// covers: testing/src/check-endpoint.ts testing/src/http-agent.ts spec/agent-endpoint.openapi.yaml spec/request.schema.json spec/response.schema.json
// `chinwag check-endpoint`: a conforming endpoint passes every case, and the requests it gets follow
// the spec; each way an answer can break the contract fails its case, saying why; the command exits
// 0 or 1, prints JSON with --json and sends the token it is told to. The spec itself is kept in step
// with the code: the response schema accepts and refuses what the platform check does, and its
// platform table is the simulators' platforms.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { parse } from "yaml";
import { WHATSAPP, z } from "../src/index.ts";
import { channelOf, PLATFORMS } from "../simulators/src/platforms.ts";
import { checkEndpoint, checkEndpointCli } from "../testing/src/check-endpoint.ts";
import { checkReply, type HttpAgentRequest } from "../testing/src/http-agent.ts";

const specFile = (name: string) => readFileSync(new URL(`../spec/${name}`, import.meta.url), "utf8");
const requestSchema = z.fromJSONSchema(JSON.parse(specFile("request.schema.json")));
const responseSchema = z.fromJSONSchema(JSON.parse(specFile("response.schema.json")));

type Answer = (body: HttpAgentRequest, res: ServerResponse, headers: IncomingHttpHeaders) => void;

/** A local endpoint answering with `answer`; every request it got, in order. */
async function endpoint(answer: Answer) {
  const seen: HttpAgentRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as HttpAgentRequest;
      seen.push(body);
      answer(body, res, req.headers);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/chinwag`,
    seen,
    close: () => (server.closeAllConnections(), server.close()),
  };
}

const json = (res: ServerResponse, body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

/** Answers as a good agent would: a reaction to the latest message, then a reply quoting it; nothing to "ok 👍". */
const conforming: Answer = (body, res) =>
  json(res, { replies: body.message.text === "ok 👍" ? [] : [{ type: "reaction", emoji: "👍", messageId: body.messageId }, { type: "message", text: "On it.", replyTo: body.messageId, buttons: ["Menu"] }] });

test("a conforming endpoint passes every case, and every request it gets follows the request schema", async () => {
  const e = await endpoint(conforming);
  const results = await checkEndpoint({ url: e.url });
  e.close();
  assert.deepEqual(results.map((r) => [r.id, r.pass]), [["message", true], ["double-text", true], ["file", true], ["message-ids", true], ["no-reply", true]]);
  assert.equal(results.find((r) => r.id === "no-reply")?.detail, "m1: no reply");
  for (const body of e.seen) assert.deepEqual(requestSchema.safeParse(body).error?.issues, undefined);
  // A double text is two messages of one conversation, in order.
  const double = e.seen.filter((b) => b.conversationId.includes(".double-text."));
  assert.deepEqual(double.map((b) => b.messageId), ["m1", "m2"]);
  assert.match(double[0].conversationId, /^whatsapp:check_[0-9a-f]{8}\.double-text\.whatsapp\.1$/);
  assert.equal(e.seen.find((b) => b.message.attachments)?.message.attachments?.[0].kind, "image");
});

test("each way an answer breaks the contract fails its case, saying why", async () => {
  const wrong: Record<string, Answer> = {
    message: (_, res) => res.writeHead(204).end(),
    "double-text": (b, res) => (b.messageId === "m1" ? conforming(b, res, {}) : res.writeHead(200).end("<html>")),
    file: (_, res) => json(res, { reply: "hi" }),
    "message-ids": (b, res) => json(res, { replies: [{ type: "reaction", emoji: "👍", messageId: "m9" }] }),
    "no-reply": (_, res) => json(res, { replies: [{ type: "message", text: "ok", buttons: ["a", "b", "c", "d"] }, { type: "note", text: "x" }] }),
  };
  const e = await endpoint((body, res, headers) => wrong[body.conversationId.split(".")[1]!]!(body, res, headers));
  const results = await checkEndpoint({ url: e.url });
  e.close();
  const detail = Object.fromEntries(results.map((r) => [r.id, r.pass ? "passed" : r.detail]));
  assert.match(detail.message!, /^m1: .* answered 204$/);
  assert.match(detail["double-text"]!, /^m2: .* answered 200 with a body that is not JSON: <html>/);
  assert.match(detail.file!, /^m1: .* without \{ "replies": \[\.\.\.\] \}/);
  assert.equal(detail["message-ids"], `m1: replies[0] names "m9", which is not one of the person's messages (m1)`);
  assert.match(detail["no-reply"]!, /^m1: replies\[0\]: would not be sent on WhatsApp: buttons/);
});

test("the command exits 0 or 1, prints JSON with --json, and sends the token it is told to", async () => {
  const e = await endpoint((body, res, headers) => (headers.authorization === "Bearer tok_1" ? conforming(body, res, headers) : res.writeHead(401).end()));
  const lines: string[] = [];
  const print = (line: string) => void lines.push(line);
  assert.equal(await checkEndpointCli([e.url], {}, print), 1);
  assert.match(lines[0]!, /^FAIL {2}message \(a typed message\): m1: .* answered 401$/);
  assert.equal(lines.at(-1), "\n0 of 5 cases passed.");
  lines.length = 0;
  assert.equal(await checkEndpointCli([e.url, "--token-env", "MY_TOKEN", "--json"], { MY_TOKEN: "tok_1" }, print), 0);
  const out = JSON.parse(lines.join("\n"));
  assert.equal(out.passed, true);
  assert.equal(out.cases.length, 5);
  assert.equal(await checkEndpointCli([e.url], { CHINWAG_AGENT_TOKEN: "tok_1" }, print), 0);
  assert.equal(await checkEndpointCli([e.url, "--token-env", "MY_TOKEN"], {}, print, print), 1);
  assert.equal(lines.at(-1), "MY_TOKEN is not set.");
  e.close();
});

test("the response schema accepts and refuses what the platform check does", () => {
  const accepted = [
    { type: "message", text: "Hi", replyTo: "m1", buttons: ["Latte", "Cold brew"] },
    { type: "message", text: "Pick one", list: { button: "Menu", rows: [{ id: "latte", title: "Latte", description: "From $4" }] } },
    { type: "message", text: "Our menu", link: { label: "Open", url: "https://example.com/menu" } },
    { type: "message", text: "Here it is", image: { url: "https://example.com/latte.jpg" }, fields: { priority: "high" } },
    { type: "read", messageIds: ["m1"] },
    { type: "reaction", emoji: "👍", messageId: "m1" },
    { type: "template", name: "order_ready", language: "en", body: ["Sam"] },
    { type: "status", text: null },
    { type: "typing", on: true },
  ];
  const refused = [
    { type: "message", text: "" },
    { type: "message", text: "Hi", colour: "blue" },
    { type: "message", text: "Hi", link: { label: "Open", url: "http://example.com" } },
    { type: "message", text: "Hi", list: { button: "Menu", rows: [] } },
    { type: "reaction", emoji: "", messageId: "m1" },
    { type: "template" },
    { type: "status" },
    { type: "typing", on: "yes" },
    { type: "note", text: "Hi" },
  ];
  for (const reply of accepted) {
    assert.ok(responseSchema.safeParse({ replies: [reply] }).success, `schema accepts ${JSON.stringify(reply)}`);
    assert.ok("outbound" in checkReply(reply, WHATSAPP), `platform check accepts ${JSON.stringify(reply)}`);
  }
  for (const reply of refused) {
    assert.ok(!responseSchema.safeParse({ replies: [reply] }).success, `schema refuses ${JSON.stringify(reply)}`);
    assert.ok("refused" in checkReply(reply, WHATSAPP), `platform check refuses ${JSON.stringify(reply)}`);
  }
});

test("the spec's platform table is the simulators' platforms", () => {
  const table = parse(specFile("agent-endpoint.openapi.yaml"))["x-chinwag-platforms"];
  const platforms = Object.fromEntries(PLATFORMS.map((p) => [p.id, JSON.parse(JSON.stringify(channelOf(p)))]));
  assert.deepEqual(table, platforms);
});
