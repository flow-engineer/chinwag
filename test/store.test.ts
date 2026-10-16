// covers: src/store.ts src/db.ts src/conversation.ts src/agent.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createAgent, sqlite, Store, tool, type Outbound } from "../src/index.ts";
import { SMS, call, gate, multi, respond, scriptedModel, users } from "./helpers.ts";

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
