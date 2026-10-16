// covers: src/http.ts src/agent.ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { nudgeHandler, sqlite, Store, peopleHandler } from "../src/index.ts";
import { SMS, call, multi, respond } from "./helpers.ts";

const SAM = { channel: "sms", address: "+15550100100" };
const TOKEN = "n".repeat(40);
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

/** Sam has written once and been answered; the nudge endpoint is served under /nudges. */
async function served(t: TestContext) {
  const database = sqlite();
  const h = multi({ channels: { sms: { info: SMS, phone: true } }, database });
  const first = await h.message("sms", SAM.address, "hi");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Hi!" })));
  const conversation = h.agent.conversation(first!.conversationId)!;
  await conversation.whenIdle();
  const logged: string[] = [];
  t.mock.method(console, "info", (line: string) => void logged.push(line));
  const server = createServer(nudgeHandler(h.agent, { token: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown, headers: Record<string, string> = auth) => fetch(`${url}/nudges`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  const get = (id: string) => fetch(`${url}/nudges/${id}`, { headers: auth });
  return { ...h, database, conversation, logged, url, post, get };
}

test("a short token throws at setup", () => {
  const h = multi({ channels: { sms: { info: SMS, phone: true } } });
  assert.throws(() => nudgeHandler(h.agent, { token: undefined as unknown as string }), /32 characters/);
  assert.throws(() => nudgeHandler(h.agent, { token: "too-short" }), /32 characters/);
});

test("without the token it answers 401, and too many wrong tokens from one address get 429, even the right one", async (t) => {
  const h = await served(t);
  const nudge = { to: SAM, text: "Your order is ready." };
  assert.equal((await h.post(nudge, { "content-type": "application/json" })).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await h.post(nudge, { authorization: "Bearer wrong" })).status, 401);
  const blocked = await h.post(nudge);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("cache-control"), "no-store");
  assert.deepEqual(h.texts("sms"), ["Hi!"], "nothing was sent");
});

test("a bad body gets 400 with what is wrong, and nothing is sent", async (t) => {
  const h = await served(t);
  const bad = async (body: unknown, pattern: RegExp) => {
    const res = await h.post(body);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, pattern);
  };
  await bad("{not json", /JSON/);
  await bad({ to: SAM }, /exactly one of text, prompt or template/);
  await bad({ to: SAM, text: "a", prompt: "b" }, /exactly one of text, prompt or template/);
  await bad({ to: SAM, text: "a", idempotencyKey: "k" }, /idempotencyKey/);
  await bad({ to: SAM, text: "a", at: "tomorrow" }, /at/);
  await bad({ to: { channel: "telegram", address: SAM.address }, text: "a" }, /to.channel must be one of the agent's channels: sms/);
  await bad(JSON.stringify({ to: SAM, text: "x".repeat(20_000) }), /at most 16384 bytes/);
  assert.deepEqual(h.texts("sms"), ["Hi!"]);
});

test("a text nudge is 202 with its id, its GET shows it sent, and the log line has no message in it", async (t) => {
  const h = await served(t);
  const res = await h.post({ to: SAM, text: "Your order is ready.", idempotency_key: "order-1042" });
  assert.equal(res.status, 202);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { id } = (await res.json()) as { id: string };
  assert.match(id, /^n_/);
  // Settled once the same key's nudge() resolves.
  assert.equal((await h.agent.nudge({ to: SAM, text: "Your order is ready.", idempotencyKey: "order-1042" })).status, "sent");
  assert.deepEqual(await (await h.get(id)).json(), { id, status: "sent" });
  assert.deepEqual(h.texts("sms"), ["Hi!", "Your order is ready."]);
  assert.equal(h.logged.length, 1);
  assert.deepEqual({ ...JSON.parse(h.logged[0]), at: undefined, ip: undefined }, { chinwag: "nudge", id, status: "queued", channel: "sms", kind: "text", at: undefined, ip: undefined });
});

test("a prompt nudge answers 202 queued before the agent's turn ends", async (t) => {
  const h = await served(t);
  const res = await h.post({ to: SAM, prompt: "Their order is ready." });
  assert.equal(res.status, 202);
  const { id, status } = (await res.json()) as { id: string; status: string };
  assert.equal(status, "queued");
  const turn = await h.nextCall(1);
  assert.deepEqual(await (await h.get(id)).json(), { id, status: "queued" }, "still in its turn");
  turn.answer(respond(call("send_sms", { text: "Your order's ready!" })));
  await h.conversation.whenIdle();
  assert.deepEqual(await (await h.get(id)).json(), { id, status: "sent" });
});

test("the same idempotency_key returns the first nudge's id and sends once", async (t) => {
  const h = await served(t);
  const nudge = { to: SAM, text: "Reminder", idempotency_key: "reminder-1" };
  const first = (await (await h.post(nudge)).json()) as { id: string };
  await h.agent.nudge({ to: SAM, text: "Reminder", idempotencyKey: "reminder-1" });
  const again = await h.post(nudge);
  assert.equal(again.status, 202);
  assert.deepEqual(await again.json(), { id: first.id, status: "sent" });
  assert.deepEqual(h.texts("sms"), ["Hi!", "Reminder"]);
});

test("a nudge to someone who never wrote is 202 refused, unknown_person", async (t) => {
  const h = await served(t);
  const res = await h.post({ to: { channel: "sms", address: "+15550100199" }, text: "Hello" });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { id: "", status: "refused", reason: "unknown_person" });
});

test("an unknown id is 404, and paths outside its base are not its own, without a token", async (t) => {
  const h = await served(t);
  assert.equal((await h.get("n_missing")).status, 404);
  for (const path of ["/", "/other", "/nudgesx", "/nudges/a/b"]) {
    assert.equal((await fetch(`${h.url}${path}`)).status, 404, path);
  }
});

test("over HTTP a business sets a person's time zone and quiet hours and reads their contact record", async (t) => {
  const h = await served(t);
  const server = createServer(peopleHandler(h.agent, { token: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/people`;
  const put = (path: string, body: unknown, headers: Record<string, string> = auth) => fetch(`${base}/${path}`, { method: "PUT", headers, body: JSON.stringify(body) });
  assert.equal((await put("time-zone", { to: SAM, time_zone: "Asia/Kolkata" }, { "content-type": "application/json" })).status, 401);
  const set = await put("time-zone", { to: SAM, time_zone: "Asia/Kolkata" });
  assert.equal(set.status, 200);
  assert.deepEqual(await set.json(), { status: "set" });
  assert.equal((await new Store(h.database, "default").conversation(h.conversation.id))?.timeZone, "Asia/Kolkata");
  assert.equal((await put("time-zone", { to: { channel: "sms", address: "+15550100999" }, time_zone: "Asia/Kolkata" })).status, 404);
  assert.equal((await put("time-zone", { to: SAM, time_zone: "Mars/Olympus" })).status, 400);
  assert.equal((await put("quiet-hours", { to: SAM, quiet_hours: { from: "21:00", to: "08:00" } })).status, 200);
  assert.equal((await put("quiet-hours", { to: SAM, quiet_hours: { from: "9pm", to: "8am" } })).status, 400);
  const contact = (await (await fetch(`${base}/contact?channel=sms&address=${encodeURIComponent(SAM.address)}`, { headers: auth })).json()) as Record<string, unknown>;
  assert.deepEqual([contact.timeZone, contact.timeZoneSource, contact.quietHours, contact.quietHoursSource], ["Asia/Kolkata", "business", { from: "21:00", to: "08:00" }, "person"]);
  assert.equal((await fetch(`${base}/elsewhere`, { headers: auth })).status, 404);
});
