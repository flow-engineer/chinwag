// covers: testing/src/http-agent.ts
// An agent on another framework, tested by its HTTP endpoint (chinwag test --agent-url): each of the
// person's messages is one POST of the contract's JSON, its { replies } go to the platform after the
// checks a Chinwag agent's send gets, and a failed answer (a status, a timeout) ends only that turn,
// saying why. The turn's events let the cloud know when the agent is done.
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { SMS, WHATSAPP, type ChannelInfo, type ChinwagEvent, type Incoming, type Outbound } from "../src/index.ts";
import { httpAgent, type HttpAgentOptions, type HttpAgentRequest } from "../testing/src/http-agent.ts";

interface Seen {
  body: HttpAgentRequest;
  headers: IncomingHttpHeaders;
}

/** One message through httpAgent to a local endpoint; resolves once its turn has ended. */
async function turn(answer: (res: ServerResponse) => void, incoming: Incoming, options: { info?: ChannelInfo; conversationId?: string } & Partial<HttpAgentOptions> = {}) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ body: JSON.parse(raw), headers: req.headers });
      answer(res);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const delivered: Outbound[] = [];
  const events: ChinwagEvent[] = [];
  const logged: string[] = [];
  let ended!: () => void;
  const done = new Promise<void>((resolve) => (ended = resolve));
  const agent = httpAgent({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/chinwag`,
    events: [(e) => (events.push(e), e.type === "turn.end" && ended())],
    log: (line) => logged.push(line),
    ...options,
  });
  const id = agent.receive(options.conversationId ?? "whatsapp:ses_1.a.whatsapp.1", incoming, (o) => void delivered.push(o), { channel: options.info ?? WHATSAPP, messageId: "m1" });
  await done;
  server.closeAllConnections();
  server.close();
  return { id, seen, delivered, events, logged, types: events.map((e) => e.type) };
}

const replies = (body: unknown) => (res: ServerResponse) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));

test("a message is one POST of the contract; its reply goes to the person", async () => {
  const r = await turn(replies({ replies: [{ type: "message", text: "Hi Sam, what can I get you?", buttons: ["Latte", "Cold brew"] }] }), { text: "hi" });
  assert.equal(r.id, "m1");
  assert.deepEqual(r.seen[0].body, { conversationId: "whatsapp:ses_1.a.whatsapp.1", messageId: "m1", channel: "whatsapp", message: { text: "hi" } });
  assert.equal(r.seen[0].headers["content-type"], "application/json");
  assert.equal(r.seen[0].headers.authorization, undefined);
  assert.deepEqual(r.delivered, [{ type: "message", text: "Hi Sam, what can I get you?", buttons: ["Latte", "Cold brew"] }]);
  assert.deepEqual(r.types, ["message.in", "turn.start", "message.out", "turn.end"]);
});

test("several replies go in order; an empty list is no reply", async () => {
  const two = await turn(replies({ replies: [{ type: "reaction", emoji: "👍", messageId: "m1" }, { type: "message", text: "One large oat latte." }, { type: "message", text: "Ready in 5." }] }), { text: "large oat latte" });
  assert.deepEqual(two.delivered, [{ type: "reaction", emoji: "👍", messageId: "m1" }, { type: "message", text: "One large oat latte." }, { type: "message", text: "Ready in 5." }]);
  const none = await turn(replies({ replies: [] }), { text: "ok" });
  assert.deepEqual(none.delivered, []);
  assert.deepEqual(none.types, ["message.in", "turn.start", "turn.end"]);
});

test("a reply the platform cannot show is not sent, and the run says why", async () => {
  const r = await turn(replies({ replies: [{ type: "message", text: "Pick one", buttons: ["A", "B"] }, { type: "message", text: "Or text us your order." }] }), { text: "menu?" }, { info: SMS, conversationId: "sms:ses_1.a.sms.1" });
  assert.deepEqual(r.delivered, [{ type: "message", text: "Or text us your order." }]);
  const refused = r.events.find((e) => e.type === "message.undelivered");
  assert.equal(refused?.text, "Pick one");
  assert.match(String(refused?.reason), /buttons/);
  assert.equal(r.seen[0].body.channel, "sms");
});

test("a status other than 200 ends the turn with that status, without a reply", async () => {
  const r = await turn((res) => res.writeHead(500).end("database down"), { text: "hi" });
  assert.deepEqual(r.delivered, []);
  assert.match(String(r.events.find((e) => e.type === "model.error")?.error), /answered 500: database down/);
  assert.match(String(r.events.find((e) => e.type === "message.undelivered")?.reason), /answered 500/);
  assert.match(r.logged[0], /whatsapp:ses_1\.a\.whatsapp\.1: .*answered 500/);
  assert.equal(r.types.at(-1), "turn.end");
});

test("an answer that never comes ends the turn at the timeout", async () => {
  const r = await turn(() => {}, { text: "hi" }, { timeoutMs: 50 });
  assert.deepEqual(r.delivered, []);
  assert.match(String(r.events.find((e) => e.type === "model.error")?.error), /no answer from http:\/\/127\.0\.0\.1:\d+\/chinwag within 0\.05 s/);
});

test("the token goes as a bearer header, --channel names the channel, files go as base64", async () => {
  const photo = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
  const r = await turn(replies({ replies: [] }), { text: "my receipt", attachments: [{ kind: "image", mime: "image/jpeg", name: "receipt.jpg", data: async () => photo }] }, { token: "tok_1", channel: "app" });
  assert.equal(r.seen[0].headers.authorization, "Bearer tok_1");
  assert.deepEqual(r.seen[0].body.message, { text: "my receipt", attachments: [{ kind: "image", mime: "image/jpeg", name: "receipt.jpg", data: Buffer.from(photo).toString("base64") }] });
  assert.equal(r.seen[0].body.channel, "app");
});
