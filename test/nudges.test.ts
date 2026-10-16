// covers: src/nudges.ts src/schedules.ts src/store.ts src/conversation.ts src/agent.ts src/channels.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { SMS_KEYWORDS, sms, type TemplateDefinition } from "../src/index.ts";
import { SMS, WHATSAPP, call, last, multi, respond } from "./helpers.ts";

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
  assert.match(next.request.system, /What they asked not to be messaged about[\s\S]*no reminders about the specials/);
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

  h.clock.now = Date.UTC(2026, 9, 13, 1); // the day is over (UTC: no zone set)
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
