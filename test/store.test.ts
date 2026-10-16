// covers: src/store.ts src/db.ts src/conversation.ts src/agent.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createAgent, sqlite, Store, tool, type Outbound } from "../src/index.ts";
import { SMS, WHATSAPP, call, gate, last, multi, respond, scriptedModel, users } from "./helpers.ts";

const CHANNELS = { sms: { info: SMS, phone: true } };
const file = () => join(mkdtempSync(join(tmpdir(), "chinwag-db-")), "chinwag.db");

test("an agent started again on the same database carries on the conversation", async () => {
  const path = file();
  const before = multi({ channels: CHANNELS, database: sqlite(path) });
  await before.agent.resume();
  const a = await before.message("sms", "+15550100100", "hi, I'm Sam");
  (await before.nextCall(0)).answer(respond(call("send_sms", { text: "Hi Sam!" })));
  await before.agent.conversation(a!.conversationId)!.whenIdle();

  const after = multi({ channels: CHANNELS, database: sqlite(path), dir: before.dir });
  await after.agent.resume();
  const b = await after.message("sms", "+15550100100", "what's my name?");
  assert.equal(b!.conversationId, a!.conversationId);
  assert.equal(b!.messageId, "m2", "message ids carry on");
  const first = await after.nextCall(0);
  assert.deepEqual(users(first.request.messages), ["[m1] hi, I'm Sam", "[m2] what's my name?"]);
  first.answer(respond(call("send_sms", { text: "Sam." })));
  await after.agent.conversation(b!.conversationId)!.whenIdle();
});

test("a turn cut off by a restart runs again, and its answer goes out", async () => {
  const path = file();
  const before = multi({ channels: CHANNELS, database: sqlite(path) });
  await before.agent.resume();
  const a = await before.message("sms", "+15550100100", "when is my session?");
  await before.nextCall(0); // the model is thinking when the process dies
  await before.agent.conversation(a!.conversationId)!.stored();

  const after = multi({ channels: CHANNELS, database: sqlite(path), dir: before.dir });
  await after.agent.resume();
  const first = await after.nextCall(0);
  assert.deepEqual(users(first.request.messages), ["[m1] when is my session?"]);
  first.answer(respond(call("send_sms", { text: "Thursday at 10." })));
  await after.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(after.texts("sms"), ["Thursday at 10."]);
});

test("a background tool cut off by a restart is reported to the agent, never run again", async () => {
  const path = file();
  let runs = 0;
  const never = gate<string>();
  const book = tool({ name: "book", description: "", input: z.object({}), run: () => (runs++, never.promise) });
  const before = multi({ channels: CHANNELS, database: sqlite(path), tools: [book] });
  await before.agent.resume();
  const a = await before.message("sms", "+15550100100", "book Friday");
  (await before.nextCall(0)).answer(respond(call("send_sms", { text: "Booking Friday." }), call("book")));
  (await before.nextCall(1)).answer(respond());
  await before.agent.conversation(a!.conversationId)!.stored();
  assert.equal(runs, 1);

  const after = multi({ channels: CHANNELS, database: sqlite(path), dir: before.dir, tools: [book] });
  await after.agent.resume();
  const first = await after.nextCall(0);
  assert.match(users(first.request.messages).at(-1)!, /book \(task_1\) was still running in the background when the agent restarted/);
  first.answer(respond(call("send_sms", { text: "Let me check whether Friday went through." })));
  await after.agent.conversation(a!.conversationId)!.whenIdle();
  assert.equal(runs, 1, "the tool was not called again");
});

test("receive() keeps a one-channel conversation across a restart too", async () => {
  const path = file();
  const dir = multi({ channels: CHANNELS }).dir;
  const start = () => {
    const scripted = scriptedModel();
    const agent = createAgent({ dir, model: scripted.model, debounceMs: 0, database: sqlite(path), scheduleCheckMs: 0 });
    return { agent, ...scripted };
  };
  const out: Outbound[] = [];
  const before = start();
  await before.agent.resume();
  before.agent.receive("chat-1", "hi, I'm Sam", (o) => void out.push(o));
  (await before.nextCall(0)).answer(respond(call("send_chat", { text: "Hi Sam!" })));
  await before.agent.conversation("chat-1")!.whenIdle();

  const after = start();
  await after.agent.resume();
  assert.equal(after.agent.receive("chat-1", "what's my name?", (o) => void out.push(o)), "m2");
  const first = await after.nextCall(0);
  assert.deepEqual(users(first.request.messages), ["[m1] hi, I'm Sam", "[m2] what's my name?"]);
  first.answer(respond(call("send_chat", { text: "Sam." })));
  await after.agent.conversation("chat-1")!.whenIdle();
});

test("a database that survives restarts must be resumed before the first message", async () => {
  const h = multi({ channels: CHANNELS, database: sqlite(file()) });
  await assert.rejects(h.message("sms", "+15550100100", "hi"), /call await agent.resume\(\)/);
});

test("phone keys stored before E.164 are upgraded, so the number's next channel joins them; two already apart stay apart", async () => {
  const database = sqlite(file());
  const store = new Store(database, "default");
  await store.migrate();
  await store.createConversation("p_wa", "phone:15550100100");
  await store.createConversation("p_both_wa", "phone:15550100200");
  await store.createConversation("p_both_sms", "phone:+15550100200");
  // As if the upgrade had not run yet on this database.
  await database.run("DELETE FROM parley_migrations WHERE version = 4");
  const h = multi({ channels: { sms: { info: SMS, phone: true } }, database });
  await h.agent.resume();
  const a = await h.message("sms", "+15550100100", "hi");
  assert.equal(a!.conversationId, "p_wa");
  assert.deepEqual((await store.allConversations()).map((c) => c.personKey).sort(), ["phone:+15550100100", "phone:+15550100200", "phone:15550100200"]);
});

test("a tool gets its call id and a signal, and an idempotency key that is the same when its turn runs again after a restart", async () => {
  const path = file();
  const seen: Array<{ callId: string; idempotencyKey: string; signal: AbortSignal }> = [];
  const never = gate<string>();
  let answer: Promise<string> = never.promise;
  const book = tool({ name: "book", description: "", input: z.object({ slot: z.string() }), deadlineMs: 60_000, run: (_input, context) => (seen.push(context), answer) });
  const before = multi({ channels: CHANNELS, database: sqlite(path), tools: [book] });
  await before.agent.resume();
  const a = await before.message("sms", "+15550100100", "book Friday 10am");
  const booking = call("book", { slot: "fri-10" });
  (await before.nextCall(0)).answer(respond(call("send_sms", { text: "Booking it." }), booking));
  while (!seen.length) await new Promise((resolve) => setImmediate(resolve));
  await before.agent.conversation(a!.conversationId)!.stored(); // the process dies while the booking runs

  answer = Promise.resolve("booked");
  const after = multi({ channels: CHANNELS, database: sqlite(path), dir: before.dir, tools: [book] });
  await after.agent.resume();
  const again = await after.nextCall(0);
  assert.match(last(again.request.messages).content, /Cut off by a restart/);
  again.answer(respond(call("book", { slot: "fri-10" })));
  (await after.nextCall(1)).answer(respond(call("send_sms", { text: "Booked for Friday at 10." })));
  await after.agent.conversation(a!.conversationId)!.whenIdle();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].callId, booking.id);
  assert.notEqual(seen[1].callId, seen[0].callId);
  assert.equal(seen[1].idempotencyKey, seen[0].idempotencyKey, "the backend can tell it is the same booking");

  await before.agent.forgetPerson(a!.conversationId);
  assert.equal(seen[0].signal.aborted, true, "a forgotten person's tools are told to stop");
});

test("with the provider's own message ids, the transcript keeps the person's side, and replies and reactions work after a restart", async () => {
  const path = file();
  const channels = { whatsapp: { info: WHATSAPP, phone: true } };
  const before = multi({ channels, database: sqlite(path) });
  await before.agent.resume();
  const a = await before.agent.message({ channel: "whatsapp", from: "15550100100", message: "is the 10am free?", messageId: "wamid.HBgL1" });
  (await before.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Let me look." })));
  await before.agent.conversation(a!.conversationId)!.whenIdle();

  const after = multi({ channels, database: sqlite(path), dir: before.dir });
  await after.agent.resume();
  await after.agent.message({ channel: "whatsapp", from: "15550100100", message: "?", messageId: "wamid.HBgL2" });
  (await after.nextCall(0)).answer(respond(call("react", { message_id: "wamid.HBgL1", emoji: "👍" }), call("send_whatsapp", { text: "Yes, it's free.", reply_to: "wamid.HBgL1" })));
  await after.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(after.out.map((o) => o.outbound).filter((o) => o.type === "reaction" || o.type === "message"), [
    { type: "reaction", emoji: "👍", messageId: "wamid.HBgL1" },
    { type: "message", text: "Yes, it's free.", replyTo: "wamid.HBgL1" },
  ]);
  const transcript = await after.agent.transcript(a!.conversationId);
  assert.deepEqual(transcript.filter((l) => l.kind === "in").map((l) => l.kind === "in" && [l.id, l.text]), [["wamid.HBgL1", "is the 10am free?"], ["wamid.HBgL2", "?"]]);
});
