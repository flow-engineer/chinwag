// covers: src/nudges.ts src/schedules.ts src/store.ts src/conversation.ts src/agent.ts src/channels.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { SMS_KEYWORDS, sms, type TemplateDefinition } from "../src/index.ts";
import { SMS, WEB_APP, WHATSAPP, call, last, multi, respond } from "./helpers.ts";

const SAM = { channel: "sms", address: "+15550100100" };

/** Sam has written once and been answered. */
async function withSam(channels: Parameters<typeof multi>[0]["channels"] = { sms: { info: SMS, phone: true } }, clock = { now: Date.UTC(2026, 9, 12, 16) }, templates?: TemplateDefinition[]) {
  const h = multi({ channels, now: () => clock.now, templates });
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
  await h.message("sms", SAM.address, "done, 128/82");
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
  const nudge = h.agent.nudge({ to: h.to, text: "Your order is ready." });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.texts("sms"), ["Hi!"], "not sent mid-turn");
  thinking.answer(respond(call("send_sms", { text: "Your plan: …" })));
  assert.equal((await nudge).status, "sent");
  assert.deepEqual(h.texts("sms"), ["Hi!", "Your plan: …", "Your order is ready."]);
});

test("the same idempotency key sends once", async () => {
  const h = await withSam();
  const first = await h.agent.nudge({ to: h.to, text: "Reminder", idempotencyKey: "order-2026-10-12" });
  const again = await h.agent.nudge({ to: h.to, text: "Reminder", idempotencyKey: "order-2026-10-12" });
  assert.equal(again.id, first.id);
  assert.deepEqual(h.texts("sms"), ["Hi!", "Reminder"]);
});

test("a nudge a no-contact rule covers is dropped, and the rules are in the agent's prompt", async () => {
  const h = await withSam();
  await h.message("sms", SAM.address, "please stop reminding me about the specials");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Got it." }), call("add_no_contact", { rule: "no reminders about the specials" })));
  (await h.nextCall(2)).answer(respond());
  await h.conversation.whenIdle();

  const nudge = h.agent.nudge({ to: h.to, text: "Don't forget the specials!" });
  const check = await h.nextCall(3);
  assert.deepEqual(check.request.tools.map((t) => t.name), ["decide"]);
  check.answer(respond(call("decide", { send: false })));
  const result = await nudge;
  assert.equal(result.status, "dropped");
  assert.match(result.reason!, /no reminders about the specials/);
  assert.deepEqual(h.texts("sms"), ["Hi!", "Got it."]);

  await h.message("sms", SAM.address, "thanks");
  const next = await h.nextCall(4);
  assert.match(next.request.system, /When and what not to message them[\s\S]*no reminders about the specials/);
  next.answer(respond(call("send_sms", { text: "Anytime." })));
  await h.conversation.whenIdle();
});

test("outside WhatsApp's window, text and prompt nudges are refused before any model call; a template goes out", async () => {
  const h = await withSam({ whatsapp: { info: { ...WHATSAPP, replyWindowHours: 24 }, phone: true } });
  h.clock.now += 25 * 3_600_000;
  const text = await h.agent.nudge({ to: h.to, text: "Order ready" });
  assert.equal(text.status, "refused");
  assert.equal(text.reason, "outside_window");
  assert.equal((await h.agent.nudge({ to: h.to, prompt: "Order ready" })).reason, "outside_window");
  assert.equal(h.calls.length, 1, "no model call");
  const template = await h.agent.nudge({ to: h.to, template: { name: "order_ready", variables: { name: "Sam" } } });
  assert.equal(template.status, "sent");
  assert.deepEqual(h.out.at(-1)!.outbound, { type: "template", name: "order_ready", variables: { name: "Sam" } });
});

test("a declared template is checked before it goes, and the agent is told what it read", async () => {
  const due: TemplateDefinition = {
    name: "order_ready",
    language: "en",
    category: "utility",
    header: { kind: "image" },
    body: "Hi {{1}}, your {{2}} is ready.",
    buttons: [{ type: "quick_reply", text: "Log it now" }, { type: "url", text: "Open app", url: "https://example.com/r/{{1}}" }],
  };
  const h = await withSam({ whatsapp: { info: WHATSAPP, phone: true } }, undefined, [due]);
  const header = { kind: "image" as const, url: "https://example.com/latte.png" };
  await assert.rejects(h.agent.nudge({ to: h.to, template: { name: "order_ready", header, body: ["Sam"], buttons: [{ index: 1, value: "latte" }] } }), /template "order_ready" \(en\) takes 2 body values, got 1/);
  await assert.rejects(h.agent.nudge({ to: h.to, template: { name: "order_ready", header, body: ["Sam", "latte"] } }), /takes the end of button 1's URL/);
  assert.equal(h.out.filter((o) => o.outbound.type === "template").length, 0, "nothing was sent");

  const template = { name: "order_ready", header, body: ["Sam", "latte"], buttons: [{ index: 0, value: "log_order" }, { index: 1, value: "latte" }] };
  assert.equal((await h.agent.nudge({ to: h.to, template })).status, "sent");
  assert.deepEqual(h.out.at(-1)!.outbound, { type: "template", ...template });
  await h.message("whatsapp", SAM.address, "ok");
  const next = await h.nextCall(1);
  assert.ok(next.request.messages.some((m) => m.role === "user" && m.content === '[Chinwag] The business sent them its template "order_ready" on whatsapp. It reads:\nHi Sam, your latte is ready.'));
  next.answer(respond(call("send_whatsapp", { text: "Logged." })));
  await h.conversation.whenIdle();
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
  await h.message("sms", SAM.address, "no reminders today please, and never about specials");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Sure." }), call("add_no_contact", { rule: "no reminders today", until: "2026-10-12" }), call("add_no_contact", { rule: "no specials" })));
  const added = await h.nextCall(2);
  const specialsRule = /"id":"(nc_\w+)","rule":"no specials"/.exec(added.request.messages.map((m) => (m.role === "tool" ? m.content : "")).join(" "))![1];
  added.answer(respond());
  await h.conversation.whenIdle();

  h.clock.now = Date.UTC(2026, 9, 13, 13); // the day is over everywhere: their zone is not known, so it ends where it ends last
  const nudge = h.agent.nudge({ to: h.to, text: "Order ready" });
  const check = await h.nextCall(3);
  assert.doesNotMatch(check.request.messages[0].content as string, /no reminders today/, "the ended rule is gone");
  check.answer(respond(call("decide", { send: true })));
  assert.equal((await nudge).status, "sent");

  await h.message("sms", SAM.address, "actually specials are fine again");
  (await h.nextCall(4)).answer(respond(call("send_sms", { text: "Done." }), call("remove_no_contact", { id: specialsRule })));
  (await h.nextCall(5)).answer(respond());
  await h.conversation.whenIdle();
  assert.equal((await h.agent.nudge({ to: h.to, text: "Today's special" })).status, "sent");
  assert.equal(h.calls.length, 6, "no rules left, so no model call for the nudge");
});

test("a scheduled text from the business goes through their no-contact rules, as one sent now does", async () => {
  const h = await withSam();
  await h.message("sms", SAM.address, "no promotions please");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Got it." }), call("add_no_contact", { rule: "no promotions" })));
  (await h.nextCall(2)).answer(respond());
  await h.conversation.whenIdle();

  assert.equal((await h.agent.nudge({ to: h.to, text: "Big sale today!", at: h.clock.now + 120_000 })).status, "scheduled");
  h.clock.now += 120_000;
  assert.equal(await h.agent.runDue(), 1);
  const check = await h.nextCall(3);
  assert.deepEqual(check.request.tools.map((t) => t.name), ["decide"]);
  check.answer(respond(call("decide", { send: false })));
  await h.conversation.whenIdle();
  assert.deepEqual(h.texts("sms"), ["Hi!", "Got it."], "the scheduled sale text was dropped");
  assert.ok(h.events.some((e) => e.type === "model.call" && e.purpose === "no-contact check"), "the check's cost is an event");
});

test("STOP on SMS stops everything the business starts, with no model call, until START; HELP gets the owner's reply", async () => {
  const keywords = { ...SMS_KEYWORDS, replies: { stop: "You're unsubscribed. Reply START to resume.", help: "Reply STOP to opt out." } };
  const h = await withSam({ sms: { info: SMS, phone: true, kind: "sms", keywords } });
  assert.equal(await h.message("sms", SAM.address, "Stop."), null);
  assert.equal(await h.message("sms", SAM.address, "help"), null);
  assert.deepEqual(h.texts("sms"), ["Hi!", "You're unsubscribed. Reply START to resume.", "Reply STOP to opt out."]);

  assert.match((await h.agent.nudge({ to: h.to, text: "Your order is ready." })).reason!, /they texted Stop\. on sms/);
  assert.equal((await h.agent.nudge({ to: h.to, prompt: "Tell them about the sale" })).status, "dropped");
  assert.equal((await h.agent.nudge({ to: h.to, template: { name: "order_ready" } })).status, "dropped");
  await h.agent.nudge({ to: h.to, text: "Your session starts soon.", at: h.clock.now + 120_000 });
  h.clock.now += 120_000;
  assert.equal(await h.agent.runDue(), 0, "the scheduled one is skipped");
  assert.equal(h.calls.length, 1, "no model call for any of it");

  // They write again: the agent answers, knows about the STOP and what they were sent, and cannot lift it itself.
  await h.message("sms", SAM.address, "what time do you open?");
  const asked = await h.nextCall(1);
  const stopped = asked.request.messages.findIndex((m) => m.role === "user" && m.content.startsWith("[m2] Stop.\n"));
  assert.match(asked.request.messages[stopped].content as string, /They texted "Stop\." on sms/);
  assert.deepEqual(asked.request.messages.slice(stopped + 1, stopped + 4).map((m) => m.role === "assistant" ? m.toolCalls![0].arguments : m.content.split("\n")[0]), [
    '{"text":"You\'re unsubscribed. Reply START to resume."}',
    '{"delivered":true,"channel":"sms"}',
    "[m3] help",
  ]);
  const stopRule = /\[(nc_stop_\w+)\]/.exec(asked.request.system)![1];
  asked.answer(respond(call("send_sms", { text: "We open at 9." }), call("remove_no_contact", { id: stopRule })));
  const removed = await h.nextCall(2);
  assert.match(last(removed.request.messages).content, /only when they text START/);
  removed.answer(respond());
  await h.conversation.whenIdle();
  assert.equal((await h.agent.nudge({ to: h.to, text: "Your order is ready." })).status, "dropped");

  assert.equal(await h.message("sms", SAM.address, "START"), null);
  await h.conversation.whenIdle();
  assert.equal((await h.agent.nudge({ to: h.to, text: "Your order is ready." })).status, "sent");
  assert.equal(h.calls.length, 3);
  const shown = (await h.agent.transcript(h.conversation.id)).flatMap((l) => (l.kind === "in" || l.kind === "out") && /stop|help|start|unsubscribed|opt out/i.test(l.text) ? [[l.kind, l.text]] : []);
  assert.deepEqual(shown, [["in", "Stop."], ["out", "You're unsubscribed. Reply START to resume."], ["in", "help"], ["out", "Reply STOP to opt out."], ["in", "START"]], "START had no reply to send");
  assert.deepEqual(h.events.filter((e) => e.answered && e.type === "message.out").map((e) => e.text), ["You're unsubscribed. Reply START to resume.", "Reply STOP to opt out."]);
});

test("intercept sees STOP, START and HELP first, marked as keywords; its own reply goes instead of Chinwag's, and the STOP holds", async () => {
  const seen: Array<[string, string | null]> = [];
  const keywords = { ...SMS_KEYWORDS, replies: { stop: "You're unsubscribed.", start: "Welcome back.", help: "Reply STOP to opt out." } };
  const h = multi({
    channels: { sms: { info: SMS, phone: true, kind: "sms", keywords } },
    intercept: (_id, text, message) => {
      seen.push([text, message.keyword]);
      return message.keyword === "stop" ? "Okay, no more texts from us." : message.keyword === "help" ? "Text us any question." : null;
    },
  });
  assert.equal(await h.message("sms", SAM.address, "STOP"), null);
  assert.equal((await h.agent.nudge({ to: SAM, text: "Your order is ready." })).status, "dropped");
  assert.equal(await h.message("sms", SAM.address, "help"), null);
  assert.equal(await h.message("sms", SAM.address, "Start"), null);
  assert.equal((await h.agent.nudge({ to: SAM, text: "Your order is ready." })).status, "sent");
  assert.deepEqual(seen, [["STOP", "stop"], ["help", "help"], ["Start", "start"]]);
  assert.deepEqual(h.texts("sms"), ["Okay, no more texts from us.", "Text us any question.", "Welcome back.", "Your order is ready."], "one reply each: the hook's, else Chinwag's");
  assert.equal(h.calls.length, 0);
});

/** Answers chest pain by rule, and says nothing to "ok". */
const emergency: Parameters<typeof multi>[0]["intercept"] = (_id, text) => (/chest pain/i.test(text) ? "Call 911 now." : text === "ok" ? "" : null);

test("a message intercept answers is kept with its reply: the next turn reads both, the transcript shows them, and both are events", async () => {
  const h = multi({ channels: { sms: { info: SMS, phone: true } }, intercept: emergency });
  assert.equal(await h.message("sms", SAM.address, "I have chest pain"), null);
  assert.deepEqual(h.texts("sms"), ["Call 911 now."]);
  assert.equal(h.calls.length, 0, "no model call for it");
  const a = await h.message("sms", SAM.address, "it's better now");
  const next = await h.nextCall(0);
  assert.deepEqual(
    next.request.messages.map((m) => [m.role, m.role === "assistant" ? m.toolCalls!.map((c) => [c.name, c.arguments]) : m.content]),
    [
      ["user", "[m1] I have chest pain\n[Chinwag] The business's own rules answered this for you on sms, as written:"],
      ["assistant", [["send_sms", '{"text":"Call 911 now."}']]],
      ["tool", '{"delivered":true,"channel":"sms"}'],
      ["user", "[m2] it's better now"],
    ],
  );
  next.answer(respond(call("send_sms", { text: "Glad to hear it." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  const transcript = await h.agent.transcript(a!.conversationId);
  assert.deepEqual(transcript.map((l) => (l.kind === "in" || l.kind === "out") && [l.kind, l.channel, l.text]), [
    ["in", "sms", "I have chest pain"],
    ["out", "sms", "Call 911 now."],
    ["in", "sms", "it's better now"],
    ["out", "sms", "Glad to hear it."],
  ]);
  const answered = h.events.filter((e) => e.answered);
  assert.deepEqual(answered.map((e) => [e.type, e.text, e.channel, e.direct]), [["message.in", "I have chest pain", "sms", undefined], ["message.out", "Call 911 now.", "sms", true]]);
  assert.ok(!h.events.some((e) => e.type === "message.in" && e.text === "it's better now" && e.answered), "messages the agent answers are not marked");
});

test("a message intercept answers with silence is kept, with nothing sent back", async () => {
  const h = multi({ channels: { sms: { info: SMS, phone: true } }, intercept: emergency });
  await h.message("sms", SAM.address, "ok");
  assert.deepEqual(h.texts("sms"), []);
  const a = await h.message("sms", SAM.address, "when do you open?");
  const next = await h.nextCall(0);
  assert.deepEqual(next.request.messages.map((m) => [m.role, m.content]), [
    ["user", "[m1] ok\n[Chinwag] The business's own rules took this message for you on sms and sent nothing back."],
    ["user", "[m2] when do you open?"],
  ]);
  next.answer(respond(call("send_sms", { text: "At 9." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual((await h.agent.transcript(a!.conversationId)).map((l) => (l.kind === "in" || l.kind === "out") && [l.kind, l.text]), [["in", "ok"], ["in", "when do you open?"], ["out", "At 9."]]);
  assert.deepEqual(h.events.filter((e) => e.answered).map((e) => e.type), ["message.in"]);
});

test("a message intercept answers while a turn runs is answered at once, and joins that turn's history after its step, in order", async () => {
  const h = multi({ channels: { sms: { info: SMS, phone: true } }, intercept: emergency });
  const a = await h.message("sms", SAM.address, "what should I eat today?");
  const thinking = await h.nextCall(0);
  await h.message("sms", SAM.address, "chest pain, help");
  assert.deepEqual(h.texts("sms"), ["Call 911 now."], "sent while the model was still thinking");
  assert.equal(thinking.request.signal.aborted, false, "the step in flight goes on");
  thinking.answer(respond(call("send_sms", { text: "Oats and fruit." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  // The turn takes the exchange in after its step: one more step reads it (the helper answers it with nothing).
  assert.equal(h.calls.length, 1);
  const after = h.followUps.at(-1)!;
  assert.deepEqual(after.messages.slice(1).map((m) => [m.role, m.role === "assistant" ? m.toolCalls![0].arguments : m.content.split("\n")[0]]), [
    ["assistant", '{"text":"Oats and fruit."}'],
    ["tool", '{"delivered":true,"channel":"sms"}'],
    ["user", "[m2] chest pain, help"],
    ["assistant", '{"text":"Call 911 now."}'],
    ["tool", '{"delivered":true,"channel":"sms"}'],
  ]);
  assert.deepEqual((await h.agent.transcript(a!.conversationId)).map((l) => (l.kind === "in" || l.kind === "out") && l.text), ["what should I eat today?", "Oats and fruit.", "chest pain, help", "Call 911 now."]);
});

test("a STOP is kept, and Chinwag's reply sent, when intercept throws on it", async () => {
  const keywords = { ...SMS_KEYWORDS, replies: { stop: "You're unsubscribed." } };
  let calls = 0;
  const h = multi({ channels: { sms: { info: SMS, phone: true, kind: "sms", keywords } }, intercept: () => { calls++; throw new Error("the flag store is down"); } });
  assert.equal(await h.message("sms", SAM.address, "STOP"), null);
  assert.equal(calls, 1, "the hook saw it");
  assert.deepEqual(h.texts("sms"), ["You're unsubscribed."]);
  assert.equal((await h.agent.nudge({ to: SAM, text: "Your order is ready." })).status, "dropped");
});

test("receive() keeps a STOP the hook answered, and sends only the hook's reply", async () => {
  const keywords = { ...SMS_KEYWORDS, replies: { stop: "You're unsubscribed." } };
  const h = multi({ channels: { sms: { info: SMS, phone: true, kind: "sms", keywords } }, intercept: (_id, _text, message) => (message.keyword === "stop" ? "Okay, no more texts." : null) });
  await h.agent.resume();
  const sent: string[] = [];
  assert.equal(h.agent.receive("c1", "STOP", (o) => void (o.type === "message" && sent.push(o.text)), { channelName: "sms" }), null);
  await h.agent.conversation("c1")!.stored();
  assert.deepEqual(sent, ["Okay, no more texts."]);
  assert.equal((await h.agent.nudge({ to: { channel: "sms", address: "c1" }, text: "Your order is ready." })).status, "dropped");
});

test("receive() sends a message intercept answers while it runs, and keeps both", async () => {
  const h = multi({ channels: { sms: { info: SMS, phone: true } }, intercept: emergency });
  await h.agent.resume();
  const sent: string[] = [];
  assert.equal(h.agent.receive("c1", "chest pain", (o) => void (o.type === "message" && sent.push(o.text)), { channelName: "sms", messageId: "r1" }), null);
  assert.deepEqual(sent, ["Call 911 now."], "delivered before receive() returned");
  await h.agent.conversation("c1")!.whenIdle();
  assert.deepEqual((await h.agent.transcript("c1")).map((l) => (l.kind === "in" || l.kind === "out") && [l.kind, l.text]), [["in", "chest pain"], ["out", "Call 911 now."]]);
});

test("intercept is told the channel each message came in on, from a provider, the playground and receive(), keywords included", async () => {
  const seen: Array<[string, string | null]> = [];
  const h = multi({
    channels: { sms: { info: SMS, phone: true, kind: "sms", keywords: SMS_KEYWORDS }, app: { info: WEB_APP } },
    testPeople: [{ name: "Sam", phone: SAM.address }],
    intercept: (_id, _text, message) => (seen.push([message.channel, message.keyword]), ""),
  });
  await h.message("sms", SAM.address, "STOP");
  await h.message("app", "u1", "hi");
  await h.agent.simulate({ person: SAM.address, channel: "app", message: "hi" });
  await h.agent.simulate({ person: SAM.address, channel: "sms", message: "hi" });
  h.agent.receive("c1", "hi", () => {}, { channelName: "app" });
  h.agent.receive("c2", "hi", () => {});
  assert.deepEqual(seen, [["sms", "stop"], ["app", null], ["app", null], ["sms", null], ["app", null], ["chat", null]]);
  assert.equal(h.calls.length, 0);
});

test("with keywords: false, STOP is a message like any other: the hook sees no keyword and the agent answers", async () => {
  const seen: Array<string | null> = [];
  const keywords = sms({ sendMessage: async () => {} }, { keywords: false }).keywords;
  const h = multi({ channels: { sms: { info: SMS, phone: true, kind: "sms", keywords } }, intercept: (_id, _text, message) => (seen.push(message.keyword), null) });
  const a = await h.message("sms", SAM.address, "STOP");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Stop what?" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(seen, [null]);
  assert.deepEqual(h.texts("sms"), ["Stop what?"]);
  assert.equal((await h.agent.nudge({ to: SAM, text: "Your order is ready." })).status, "sent");
});

test("a model error in a nudge texts the person nothing, and the nudge settles as failed; their own turn still says sorry", async () => {
  const h = await withSam();
  await h.message("sms", SAM.address, "no promos please");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Got it." }), call("add_no_contact", { rule: "no promotions" })));
  (await h.nextCall(2)).answer(respond());
  await h.conversation.whenIdle();

  const text = h.agent.nudge({ to: h.to, text: "Your session is tomorrow at 10." });
  (await h.nextCall(3)).fail(new Error("503 overloaded"));
  assert.deepEqual(await text, { id: (await text).id, status: "failed", reason: "their no-contact rules could not be checked: 503 overloaded" });
  const prompt = h.agent.nudge({ to: h.to, prompt: "Their session is tomorrow at 10" });
  (await h.nextCall(4)).fail(new Error("503 overloaded"));
  assert.deepEqual(await prompt, { id: (await prompt).id, status: "failed", reason: "the agent's turn failed: 503 overloaded" });
  await h.conversation.whenIdle();
  assert.deepEqual(h.texts("sms"), ["Hi!", "Got it."], "no apology to someone who did not write");
  assert.equal(h.events.filter((e) => e.type === "model.error").length, 2);

  await h.message("sms", SAM.address, "is it at 10?");
  (await h.nextCall(5)).fail(new Error("503 overloaded"));
  await h.conversation.whenIdle();
  assert.equal(h.texts("sms").at(-1), "Sorry, something went wrong on my side. Could you send that again?");
});

test("two calls with one idempotency key at once send once, and both get its result; a scheduled one is written once", async () => {
  const h = await withSam();
  const nudge = { to: h.to, text: "Reminder", idempotencyKey: "order-1" };
  const [a, b] = await Promise.all([h.agent.nudge(nudge), h.agent.nudge(nudge)]);
  assert.deepEqual(a, b);
  assert.equal(a.status, "sent");
  assert.deepEqual(h.texts("sms"), ["Hi!", "Reminder"]);

  const later = { to: h.to, text: "Your session starts soon.", at: h.clock.now + 120_000, idempotencyKey: "session-1" };
  const [c, d] = await Promise.all([h.agent.nudge(later), h.agent.nudge(later)]);
  assert.deepEqual(c, d);
  h.clock.now += 120_000;
  assert.equal(await h.agent.runDue(), 1, "one schedule, so it goes out once");
});

// --- Quiet hours ---

const ELEVEN_PM_NY = Date.UTC(2026, 9, 13, 3);
const SEVEN_AM_NY = Date.UTC(2026, 9, 13, 11);

/** Sam in New York (the business set it), at 11pm their time: inside the default quiet hours, 22:00 to 07:00. */
async function samAtNight() {
  const h = await withSam(undefined, { now: ELEVEN_PM_NY });
  assert.deepEqual(await h.agent.setTimeZone({ to: h.to, timeZone: "America/New_York" }), { status: "set" });
  return h;
}

test("in their quiet hours nudges are held, and when the hours end everything held reaches one turn", async () => {
  const h = await samAtNight();
  const shipped = await h.agent.nudge({ to: h.to, prompt: "Their order shipped" });
  const coupon = await h.agent.nudge({ to: h.to, text: "Your coupon code is SAVE10" });
  assert.deepEqual([shipped.status, coupon.status], ["held", "held"]);
  assert.equal(shipped.reason, "quiet_hours");
  assert.equal(h.calls.length, 1, "no model call while they sleep");
  assert.deepEqual(h.texts("sms"), ["Hi!"]);

  await h.agent.runDue();
  assert.equal(h.calls.length, 1, "still their quiet hours: nothing released");
  h.clock.now = SEVEN_AM_NY;
  await h.agent.runDue();
  const turn = await h.nextCall(1);
  assert.match(last(turn.request.messages).content, /held for their quiet hours since Mon 12 Oct 2026 23:00 \(New York time\); Their order shipped\][\s\S]*cover them all in one short message/);
  turn.answer(respond(call("send_sms", { text: "Morning! Your order shipped." })));
  await h.conversation.whenIdle();
  assert.deepEqual(h.texts("sms").sort(), ["Hi!", "Morning! Your order shipped.", "Your coupon code is SAVE10"], "a text nudge goes as written, a prompt one in the agent's words");
  assert.equal((await h.agent.nudgeState(shipped.id))?.status, "sent");
});

test("held nudges go as soon as the person writes, in the turn that answers them", async () => {
  const h = await samAtNight();
  await h.agent.nudge({ to: h.to, prompt: "Their order shipped" });
  await h.message("sms", SAM.address, "can't sleep, what's my order status?");
  const { call: turn } = await h.callWith(1, (c) => /order shipped/.test(JSON.stringify(c.request.messages)));
  const seen = JSON.stringify(turn.request.messages);
  assert.ok(seen.includes("what's my order status") && seen.includes("held for their quiet hours"), "their message and what was held, in one turn");
  turn.answer(respond(call("send_sms", { text: "It shipped tonight." })));
  await h.conversation.whenIdle();
});

test("a held nudge past its expiresAt is dropped as expired; respectQuietHours false sends it now", async () => {
  const h = await samAtNight();
  const stale = await h.agent.nudge({ to: h.to, text: "Your table is ready", expiresAt: ELEVEN_PM_NY + 30 * 60_000 });
  assert.equal(stale.status, "held");
  h.clock.now = SEVEN_AM_NY;
  await h.agent.runDue();
  assert.equal((await h.agent.nudgeState(stale.id))?.status, "expired");
  assert.deepEqual(h.texts("sms"), ["Hi!"]);

  h.clock.now = ELEVEN_PM_NY;
  assert.equal((await h.agent.nudge({ to: h.to, text: "Your account was locked", respectQuietHours: false })).status, "sent");
});

test("without their time zone quiet hours do not apply; a person may set their own, or none", async () => {
  const h = await withSam(undefined, { now: ELEVEN_PM_NY });
  assert.equal((await h.agent.nudge({ to: h.to, text: "Order shipped" })).status, "sent", "their zone is not known: nothing is held");
  assert.equal((await h.agent.contact(h.to))?.quietHoursSource, "no_time_zone");

  await h.agent.setTimeZone({ to: h.to, timeZone: "America/New_York" });
  assert.deepEqual(await h.agent.setQuietHours({ to: h.to, quietHours: "off" }), { status: "set" });
  assert.equal((await h.agent.nudge({ to: h.to, text: "Second" })).status, "sent", "they turned quiet hours off");

  await h.message("sms", SAM.address, "please nothing after 9pm or before 9am");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Got it." }), call("set_quiet_hours", { set: "hours", from: "21:00", to: "09:00" })));
  (await h.nextCall(2)).answer(respond());
  await h.conversation.whenIdle();
  const contact = await h.agent.contact(h.to);
  assert.deepEqual([contact?.quietHours, contact?.quietHoursSource, contact?.timeZoneSource], [{ from: "21:00", to: "09:00" }, "person", "business"]);
  h.clock.now = Date.UTC(2026, 9, 13, 12, 30); // 8:30am New York: inside their own hours, not the default
  assert.equal((await h.agent.nudge({ to: h.to, text: "Third" })).status, "held");
});

test("a pause drops what the business starts with no model call, and the contact record shows it", async () => {
  const h = await withSam();
  await h.message("sms", SAM.address, "no messages until the 20th please");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Paused." }), call("pause_messages", { until: "2026-10-20" })));
  (await h.nextCall(2)).answer(respond());
  await h.conversation.whenIdle();
  const result = await h.agent.nudge({ to: h.to, prompt: "Tell them about the sale" });
  assert.equal(result.status, "dropped");
  assert.match(result.reason ?? "", /pause/);
  assert.equal(h.calls.length, 3, "no model call to judge it");
  const contact = await h.agent.contact(h.to);
  assert.equal(contact?.pauses.length, 1);
  assert.deepEqual(contact?.topics, []);
});

test("a reminder that can wait skips its runs in their quiet hours; a business schedule moves to when they end", async () => {
  const h = await samAtNight();
  h.clock.now = Date.UTC(2026, 9, 12, 16); // noon, to schedule
  await h.message("sms", SAM.address, "check for new listings every night at 11 and let me know");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Will do." }), call("schedule_message", { message: "check listings", repeat: "daily", time: "23:00", mode: "check", respect_quiet_hours: true })));
  (await h.nextCall(2)).answer(respond());
  await h.conversation.whenIdle();
  const later = await h.agent.nudge({ to: h.to, prompt: "Their order shipped", at: ELEVEN_PM_NY });
  assert.equal(later.status, "scheduled");

  h.clock.now = ELEVEN_PM_NY;
  await h.agent.runDue();
  assert.equal(h.calls.length, 3, "nothing ran in their quiet hours");
  const outcomes = (await h.database.query("SELECT outcome, reason FROM schedule_runs ORDER BY ran_at")).map((r) => `${r.outcome}: ${r.reason}`);
  assert.ok(outcomes.some((o) => o === "skipped: their quiet hours"), outcomes.join(" | "));
  assert.ok(outcomes.some((o) => /^held: their quiet hours: moved to Tue 13 Oct 2026 07:00/.test(o)), outcomes.join(" | "));
});

// --- WhatsApp's closed window: the agent's template, else the fallback ---

const WAITING: TemplateDefinition = { name: "message_waiting", language: "en", category: "utility", body: "You have a new message. Reply to see it." };
const SHIPPED: TemplateDefinition = { name: "order_shipped", language: "en", category: "utility", body: "Hi {{1}}, your order {{2}} has shipped." };

/** Sam on WhatsApp, last heard from 25 hours ago, with a fallback template. */
async function samWindowClosed() {
  const clock = { now: Date.UTC(2026, 9, 12, 16) };
  const h = multi({ channels: { whatsapp: { info: { ...WHATSAPP, replyWindowHours: 24 }, phone: true } }, now: () => clock.now, templates: [WAITING, SHIPPED], fallbackTemplate: { name: "message_waiting" } });
  const a = await h.message("whatsapp", SAM.address, "hi");
  (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi!" })));
  const conversation = h.agent.conversation(a!.conversationId)!;
  await conversation.whenIdle();
  clock.now += 25 * 3_600_000;
  return { ...h, conversation, clock, to: { channel: "whatsapp", address: SAM.address } };
}

const templatesSent = (h: { out: Array<{ outbound: { type: string } }> }) => h.out.flatMap((o) => (o.outbound.type === "template" ? [(o.outbound as unknown as { name: string }).name] : []));

test("past the window, the agent sends a template that says the nudge, filled in", async () => {
  const h = await samWindowClosed();
  const nudge = h.agent.nudge({ to: h.to, prompt: "Their order 1042 shipped" });
  const turn = await h.nextCall(1);
  assert.match(last(turn.request.messages).content, /window is closed[\s\S]*send_template/);
  assert.ok(turn.request.tools.some((t) => t.name === "send_template" && !/message_waiting:/.test(t.description)), "the fallback is Chinwag's, not offered");
  turn.answer(respond(call("send_template", { name: "order_shipped", body: ["Sam", "1042"] })));
  (await h.nextCall(2)).answer(respond());
  assert.equal((await nudge).status, "sent");
  assert.deepEqual(templatesSent(h), ["order_shipped"]);
});

test("past the window with no template that fits, the fallback goes, the nudge waits for their reply, and template.missing says what", async () => {
  const h = await samWindowClosed();
  const nudge = h.agent.nudge({ to: h.to, prompt: "Their refund was approved" });
  (await h.nextCall(1)).answer(respond());
  const result = await nudge;
  assert.deepEqual([result.status, result.reason], ["held", "window_closed"]);
  await h.sentWhere((o) => o.outbound.type === "template");
  assert.deepEqual(templatesSent(h), ["message_waiting"]);
  assert.deepEqual(h.events.filter((e) => e.type === "template.missing").map((e) => e.prompt), ["Their refund was approved"]);

  await h.message("whatsapp", SAM.address, "what's new?");
  const { call: reply } = await h.callWith(2, (c) => JSON.stringify(c.request.messages).includes("Their refund was approved") && !/window is closed/.test(JSON.stringify(c.request.messages.at(-1))));
  reply.answer(respond(call("send_whatsapp", { text: "Your refund was approved." })));
  await h.conversation.whenIdle();
  assert.equal((await h.agent.nudgeState(result.id))?.status, "sent");
});

test("a text nudge past the window sends the fallback at once and goes as written when they reply", async () => {
  const h = await samWindowClosed();
  const result = await h.agent.nudge({ to: h.to, text: "Your code is 4417" });
  assert.deepEqual([result.status, result.reason], ["held", "window_closed"]);
  await h.sentWhere((o) => o.outbound.type === "template");
  assert.deepEqual(templatesSent(h), ["message_waiting"]);
  assert.equal(h.calls.length, 1, "no model call");
  await h.message("whatsapp", SAM.address, "ok?");
  (await h.nextCall(1)).answer(respond(call("send_whatsapp", { text: "Here it is." })));
  await h.sentWhere((o) => o.outbound.type === "message" && o.outbound.text === "Your code is 4417");
  await h.conversation.whenIdle();
  assert.equal((await h.agent.nudgeState(result.id))?.status, "sent");
});

test("a fallback template that is not declared, or needs values, throws at setup", () => {
  assert.throws(() => multi({ channels: { whatsapp: { info: WHATSAPP, phone: true } }, templates: [WAITING], fallbackTemplate: { name: "nope" } }), /not one of the declared templates/);
  assert.throws(() => multi({ channels: { whatsapp: { info: WHATSAPP, phone: true } }, templates: [SHIPPED], fallbackTemplate: { name: "order_shipped" } }), /body values/);
});

