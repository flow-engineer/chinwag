// covers: src/agent.ts src/store.ts src/conversation.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { sqlite, type Database, type Outbound } from "../src/index.ts";
import { Store } from "../src/store.ts";
import { WEB_APP, WHATSAPP, call, multi, respond, users } from "./helpers.ts";

const SAM = { name: "Sam", phone: "+15555550101" };
const NOON_NY = Date.UTC(2026, 9, 12, 16);

/** An agent with WhatsApp (a phone channel) and an app, Sam as its test person, and the playground attached. */
function playground(database: Database = sqlite()) {
  const clock = { now: NOON_NY };
  const h = multi({ channels: { whatsapp: { info: WHATSAPP, phone: true }, app: { info: WEB_APP } }, testPeople: [SAM], database, now: () => clock.now, timeZone: "America/New_York" });
  const played: Array<{ channel: string; outbound: Outbound }> = [];
  h.agent.attachPlayground(({ person, channel, outbound }) => {
    assert.equal(person.phone, SAM.phone);
    played.push({ channel, outbound });
  });
  const shown = (channel?: string) => played.flatMap((p) => (p.outbound.type === "message" && (!channel || p.channel === channel) ? [p.outbound.text] : []));
  return { ...h, clock, played, shown, store: new Store(database, "default") };
}

test("only the agent's test people can be simulated", async () => {
  const h = playground();
  await assert.rejects(h.agent.simulate({ person: "+15555550199", channel: "whatsapp", message: "hi" }), /only the agent's testPeople/);
  assert.equal(h.calls.length, 0);
  await h.agent.resume();
  assert.equal((await h.store.allConversations()).length, 0, "nothing was made for them");
});

test("a test person who switches channels resumes the same conversation", async () => {
  const h = playground();
  const a = await h.agent.simulate({ person: SAM.phone, channel: "whatsapp", message: "hi" });
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi Sam!" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  const b = await h.agent.simulate({ person: "+1 (555) 555-0101", channel: "app", message: "now in the app" });
  assert.equal(b!.conversationId, a!.conversationId);
  const second = await h.nextCall(1);
  assert.deepEqual(users(second.request.messages), ["[whatsapp · m1] hi", "[app · m2] now in the app"]);
  second.answer(respond(call("send_app", { text: "Here too." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(h.shown(), ["Hi Sam!", "Here too."], "both replies reached the playground");
  assert.deepEqual(h.out, [], "the providers were never called");
  assert.deepEqual(
    (await h.store.identities(a!.conversationId)).map((i) => [i.channel, i.address]).sort(),
    [["app", "test:+15555550101"], ["whatsapp", "+15555550101"]],
  );
});

test("a scheduled message goes where the person last wrote from: the playground, then the provider", async () => {
  const h = playground();
  const a = await h.agent.simulate({ person: SAM.phone, channel: "whatsapp", message: "hi" });
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi!" })));
  const conversation = h.agent.conversation(a!.conversationId)!;
  await conversation.whenIdle();
  const due = (id: string) =>
    h.store.addSchedule({ id, conversationId: a!.conversationId, channel: "whatsapp", instruction: "check in", fixedText: false, mode: "message", rule: { repeat: "once", at: h.clock.now + 60_000 }, timeZone: "America/New_York", nextRunAt: h.clock.now + 60_000, maxRuns: null, endsOn: null, origin: "person" });

  await due("s1");
  h.clock.now += 61_000;
  assert.equal(await h.agent.runDue(), 1);
  (await h.nextCall(1)).answer(respond(call("send_whatsapp", { text: "Checking in!" })));
  await conversation.whenIdle();
  assert.deepEqual(h.shown(), ["Hi!", "Checking in!"]);
  assert.deepEqual(h.out, []);

  // The same number writes from WhatsApp itself once the channel is live: a real message, not refused.
  await h.message("whatsapp", SAM.phone, "on my real phone now");
  (await h.nextCall(2)).answer(respond(call("send_whatsapp", { text: "Got it." })));
  await conversation.whenIdle();
  await due("s2");
  h.clock.now += 61_000;
  assert.equal(await h.agent.runDue(), 1);
  (await h.nextCall(3)).answer(respond(call("send_whatsapp", { text: "Checking in again!" })));
  await conversation.whenIdle();
  assert.deepEqual(h.texts("whatsapp"), ["Got it.", "Checking in again!"]);
  assert.deepEqual(h.shown(), ["Hi!", "Checking in!"], "nothing more went to the playground");
});

test("forgetting a person stops their turn, leaves nothing of them, and their next message starts fresh", async () => {
  const db = sqlite();
  const h = playground(db);
  const a = await h.agent.simulate({ person: SAM.phone, channel: "whatsapp", message: "remind me tomorrow at 9 to pick up the order" });
  const first = await h.nextCall(0);
  first.answer(respond(call("send_whatsapp", { text: "Will do." }), call("schedule_message", { message: "remind them to pick up the order", repeat: "once", time: "09:00" }), call("add_no_contact", { rule: "no promotions" })));
  (await h.nextCall(1)).answer(respond());
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  await h.agent.nudge({ to: { channel: "whatsapp", address: SAM.phone }, text: "Fresh scones today", at: h.clock.now + 3_600_000 });
  await h.agent.simulate({ person: SAM.phone, channel: "app", message: "also, one more thing" });
  const inFlight = await h.nextCall(2);

  await h.agent.forgetPerson(a!.conversationId);
  assert.ok(inFlight.request.signal.aborted, "the turn in progress was cut off");
  for (const table of ["conversations", "identities", "messages", "inbox", "background_tools", "schedules", "schedule_runs", "nudges", "no_contact"]) {
    assert.deepEqual(await db.query(`SELECT * FROM ${table}`), [], `${table} is empty`);
  }
  assert.equal(h.agent.conversation(a!.conversationId), undefined);

  const b = await h.agent.simulate({ person: SAM.phone, channel: "whatsapp", message: "hello?" });
  assert.notEqual(b!.conversationId, a!.conversationId);
  const fresh = await h.nextCall(3);
  assert.deepEqual(users(fresh.request.messages), ["[whatsapp · m1] hello?"]);
  assert.doesNotMatch(fresh.request.system, /no promotions/);
  fresh.answer(respond(call("send_whatsapp", { text: "Hi! How can I help?" })));
  await h.agent.conversation(b!.conversationId)!.whenIdle();
});
