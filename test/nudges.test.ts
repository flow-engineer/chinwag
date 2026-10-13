// covers: src/nudges.ts src/schedules.ts src/store.ts src/conversation.ts src/agent.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { SMS, WHATSAPP, call, last, multi, respond } from "./helpers.ts";

const SAM = { channel: "sms", address: "+15550100100" };

/** Sam has written once and been answered. */
async function withSam(channels: Record<string, { info: typeof SMS; phone?: boolean }> = { sms: { info: SMS, phone: true } }, clock = { now: Date.UTC(2026, 9, 12, 16) }) {
  const h = multi({ channels, now: () => clock.now });
  const channel = Object.keys(channels)[0];
  const a = await h.message(channel, SAM.address, "hi");
  (await h.nextCall(0)).answer(respond(call(`send_${channel}`, { text: "Hi!" })));
  const conversation = h.agent.conversation(a!.conversationId)!;
  await conversation.whenIdle();
  return { ...h, conversation, clock, to: { channel, address: SAM.address } };
}

test("a text nudge goes out as written with no model call, and the agent knows it sent it", async () => {
  const h = await withSam();
  const result = await h.agent.nudge({ to: h.to, text: "Your order is ready for pickup." });
  assert.equal(result.status, "sent");
  assert.deepEqual(h.texts("sms"), ["Hi!", "Your order is ready for pickup."]);
  assert.equal(h.calls.length, 1, "no model call");
  await h.message("sms", SAM.address, "thanks, on my way");
  const next = await h.nextCall(1);
  const sent = next.request.messages.flatMap((m) => (m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.arguments) : []));
  assert.ok(sent.some((a) => a.includes("Your order is ready for pickup.")));
  next.answer(respond(call("send_sms", { text: "Thanks, logged." })));
  await h.conversation.whenIdle();
});

test("a prompt nudge gives the agent a turn, and it may choose to send nothing", async () => {
  const h = await withSam();
  const silent = h.agent.nudge({ to: h.to, prompt: "Their session is tomorrow at 10am" });
  const turn = await h.nextCall(1);
  assert.match(last(turn.request.messages).content, /^\[Nudge from the business, not from the person: Their session is tomorrow at 10am\]/);
  turn.answer(respond());
  assert.equal((await silent).status, "silent");
  assert.equal(h.calls.length, 2, "no reminder to reply after a nudge it chose not to send");

  const sent = h.agent.nudge({ to: h.to, prompt: "Their session is tomorrow at 10am" });
  (await h.nextCall(2)).answer(respond(call("send_sms", { text: "See you tomorrow at 10!" })));
  assert.equal((await sent).status, "sent");
});

test("a nudge that arrives during a turn waits for it to end", async () => {
  const h = await withSam();
  await h.message("sms", SAM.address, "what's my plan?");
  const thinking = await h.nextCall(1);
  const nudge = h.agent.nudge({ to: h.to, text: "Your reading is due." });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.texts("sms"), ["Hi!"], "not sent mid-turn");
  thinking.answer(respond(call("send_sms", { text: "Your plan: …" })));
  assert.equal((await nudge).status, "sent");
  assert.deepEqual(h.texts("sms"), ["Hi!", "Your plan: …", "Your reading is due."]);
});

test("the same idempotency key sends once", async () => {
  const h = await withSam();
  const first = await h.agent.nudge({ to: h.to, text: "Reminder", idempotencyKey: "reading-2026-10-12" });
  const again = await h.agent.nudge({ to: h.to, text: "Reminder", idempotencyKey: "reading-2026-10-12" });
  assert.equal(again.id, first.id);
  assert.deepEqual(h.texts("sms"), ["Hi!", "Reminder"]);
});

test("a nudge a no-contact rule covers is dropped, and the rules are in the agent's prompt", async () => {
  const h = await withSam();
  await h.message("sms", SAM.address, "please stop sending me promotions");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Got it." }), call("add_no_contact", { rule: "no promotions" })));
  (await h.nextCall(2)).answer(respond());
  await h.conversation.whenIdle();

  const nudge = h.agent.nudge({ to: h.to, text: "Don't forget to log your lunch!" });
  const check = await h.nextCall(3);
  assert.deepEqual(check.request.tools.map((t) => t.name), ["decide"]);
  check.answer(respond(call("decide", { send: false })));
  const result = await nudge;
  assert.equal(result.status, "dropped");
  assert.match(result.reason!, /no promotions/);
  assert.deepEqual(h.texts("sms"), ["Hi!", "Got it."]);

  await h.message("sms", SAM.address, "thanks");
  const next = await h.nextCall(4);
  assert.match(next.request.system, /What they asked not to be messaged about[\s\S]*no promotions/);
  next.answer(respond(call("send_sms", { text: "Anytime." })));
  await h.conversation.whenIdle();
});

test("outside WhatsApp's window, text and prompt nudges are refused before any model call; a template goes out", async () => {
  const h = await withSam({ whatsapp: { info: { ...WHATSAPP, replyWindowHours: 24 }, phone: true } });
  h.clock.now += 25 * 3_600_000;
  const text = await h.agent.nudge({ to: h.to, text: "Reading due" });
  assert.equal(text.status, "refused");
  assert.equal(text.reason, "outside_window");
  assert.equal((await h.agent.nudge({ to: h.to, prompt: "Reading due" })).reason, "outside_window");
  assert.equal(h.calls.length, 1, "no model call");
  const template = await h.agent.nudge({ to: h.to, template: { name: "order_ready", variables: { name: "Sam" } } });
  assert.equal(template.status, "sent");
  assert.deepEqual(h.out.at(-1)!.outbound, { type: "template", name: "order_ready", variables: { name: "Sam" } });
});

test("a nudge for someone who never wrote is refused", async () => {
  const h = await withSam();
  assert.deepEqual(await h.agent.nudge({ to: { channel: "sms", address: "+15550199999" }, text: "hi" }), { id: "", status: "refused", reason: "unknown_person" });
});

test("a nudge with a time waits for it: text goes out as written, a prompt gets a turn", async () => {
  const h = await withSam();
  const inAnHour = h.clock.now + 3_600_000;
  assert.equal((await h.agent.nudge({ to: h.to, text: "Your session starts soon.", at: inAnHour })).status, "scheduled");
  assert.equal((await h.agent.nudge({ to: h.to, prompt: "Their session starts soon", at: inAnHour })).status, "scheduled");
  assert.equal(await h.agent.runDue(), 0, "not due yet");
  h.clock.now = inAnHour;
  assert.equal(await h.agent.runDue(), 2);
  const turn = await h.nextCall(1);
  assert.match(last(turn.request.messages).content, /^\[Nudge from the business, not from the person, scheduled earlier: Their session starts soon\]/);
  turn.answer(respond(call("send_sms", { text: "Your session starts in a few minutes!" })));
  await h.conversation.whenIdle();
  // The text needs no model call; it waits for the prompt nudge's turn to end, as nudges do.
  assert.deepEqual(h.texts("sms"), ["Hi!", "Your session starts in a few minutes!", "Your session starts soon."]);
  assert.equal(h.calls.length, 2);
});

test("a no-contact rule ends at its until date, and goes when the agent removes it", async () => {
  const h = await withSam();
  await h.message("sms", SAM.address, "no reminders today please, and never promotions");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Sure." }), call("add_no_contact", { rule: "no reminders today", until: "2026-10-12" }), call("add_no_contact", { rule: "no promotions ever" })));
  const added = await h.nextCall(2);
  const promoRule = /"id":"(nc_\w+)","rule":"no promotions ever"/.exec(added.request.messages.map((m) => (m.role === "tool" ? m.content : "")).join(" "))![1];
  added.answer(respond());
  await h.conversation.whenIdle();

  h.clock.now = Date.UTC(2026, 9, 13, 1); // the day is over (UTC: no zone set)
  const nudge = h.agent.nudge({ to: h.to, text: "Reading due" });
  const check = await h.nextCall(3);
  assert.doesNotMatch(check.request.messages[0].content as string, /no reminders today/, "the ended rule is gone");
  check.answer(respond(call("decide", { send: true })));
  assert.equal((await nudge).status, "sent");

  await h.message("sms", SAM.address, "actually promotions are fine again");
  (await h.nextCall(4)).answer(respond(call("send_sms", { text: "Done." }), call("remove_no_contact", { id: promoRule })));
  (await h.nextCall(5)).answer(respond());
  await h.conversation.whenIdle();
  assert.equal((await h.agent.nudge({ to: h.to, text: "Log your lunch" })).status, "sent");
  assert.equal(h.calls.length, 6, "no rules left, so no model call for the nudge");
});
