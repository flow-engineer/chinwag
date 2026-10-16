// covers: src/conversation.ts src/talk.ts src/agent.ts src/store.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { tool } from "../src/index.ts";
import { SMS, WEB, WHATSAPP, call, harness, last, multi, respond, say, users } from "./helpers.ts";

test("the person's messages carry ids the agent can react to", async () => {
  const h = harness();
  const id = h.send("c1", "order 1042");
  assert.equal(id, "m1");
  const first = await h.nextCall(0);
  assert.equal(users(first.request.messages).at(-1), "[m1] order 1042");
  first.answer(respond(call("react", { message_id: "m1", emoji: "👍" })));
  await h.agent.conversation("c1")!.whenIdle();
  assert.deepEqual(h.out.filter((o) => o.type === "reaction"), [{ type: "reaction", emoji: "👍", messageId: "m1" }]);
});

test("after their message, a reply of only messages gets one more step, to act on what it said", async () => {
  const plan = tool({ name: "get_plan", description: "", input: z.object({}), run: () => "DASH, sodium under 1,500 mg" });
  const h = harness([plan], 50, WEB, "manual");
  h.send("c4", "send me my plan");
  (await h.nextCall(0)).answer(respond(say("Getting your plan."), say("One moment.")));
  const followUp = await h.nextCall(1);
  const results = followUp.request.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
  assert.deepEqual(results, Array(2).fill(JSON.stringify({ delivered: true, channel: "chat" })), "it sees its messages were delivered");
  followUp.answer(respond(call("get_plan")));
  (await h.nextCall(2)).answer(respond(say("Your plan: DASH, sodium under 1,500 mg.")));
  await h.agent.conversation("c4")!.whenIdle();
  assert.deepEqual(h.sent(), ["Getting your plan.", "One moment.", "Your plan: DASH, sodium under 1,500 mg."]);
  assert.equal(h.calls.length, 3, "one more step only: a second reply of only messages ends the turn");
});

test("a message that fails to arrive comes back to the agent", async () => {
  const h = harness();
  h.send("c9", "hello");
  h.failNext("the number opted out");
  (await h.nextCall(0)).answer(respond(say("Hi there!")));
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /\[Not delivered\] "Hi there!": the number opted out/);
  second.answer(respond());
  // They still have heard nothing, so the agent is reminded once; then the turn ends.
  const third = await h.nextCall(2);
  assert.match(last(third.request.messages).content, /Reply with send_chat/);
  third.answer(respond());
  await h.agent.conversation("c9")!.whenIdle();
  assert.equal(h.calls.length, 3);
});

test("a message the channel refuses goes back to the agent to fix", async () => {
  const h = harness([], 50, WHATSAPP);
  h.send("w2", "which day?");
  (await h.nextCall(0)).answer(respond(call("send_chat", { text: "Pick one", buttons: ["Mon", "Tue", "Wed", "Thu"] })));
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /Not sent, fix and send again/);
  second.answer(respond(call("send_chat", { text: "Pick one", buttons: ["Mon", "Tue", "Wed"] })));
  await h.agent.conversation("w2")!.whenIdle();
  const sent = h.out.filter((o) => o.type === "message");
  assert.deepEqual(sent, [{ type: "message", text: "Pick one", buttons: ["Mon", "Tue", "Wed"] }]);
});

test("WhatsApp's rules for links and images go back to the agent to fix: no link with buttons, no image with a list, a caption's length, https only", async () => {
  const h = harness([], 50, { ...WHATSAPP, linkButton: { labelMax: 20 }, images: { captionMax: 1024 } });
  h.send("w3", "show me flats");
  const link = { label: "Open in app", url: "https://example.com/l/7" };
  const photo = { url: "https://example.com/flat.jpg" };
  const rows = [{ id: "r1", title: "2 BHK" }];
  (await h.nextCall(0)).answer(
    respond(
      call("send_chat", { text: "Pick one", link, buttons: ["Yes"] }),
      call("send_chat", { text: "Pick one", image: photo, list: { button: "Flats", rows } }),
      call("send_chat", { text: "x".repeat(1025), image: photo }),
      call("send_chat", { text: "Here", image: { url: "http://example.com/flat.jpg" } }),
    ),
  );
  const second = await h.nextCall(1);
  const results = second.request.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
  assert.equal(results.length, 4);
  assert.match(results[0], /link cannot also have buttons or a list/);
  assert.match(results[1], /image cannot also have a list/);
  assert.match(results[2], /caption, at most 1024 characters/);
  assert.match(results[3], /Not sent, fix and send again/);
  second.answer(respond(call("send_chat", { text: "2 BHK, Indiranagar", image: photo, link })));
  await h.agent.conversation("w3")!.whenIdle();
  assert.deepEqual(h.out.filter((o) => o.type === "message"), [{ type: "message", text: "2 BHK, Indiranagar", image: photo, link }]);
});

test("a reaction from the person is noted for the next turn without starting one", async () => {
  const h = harness([], 50, WHATSAPP);
  h.send("w4", "thanks");
  (await h.nextCall(0)).answer(respond(say("Anytime!")));
  await h.agent.conversation("w4")!.whenIdle();
  h.agent.reacted("w4", "❤️", "Anytime!");
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 1, "no turn for a reaction alone");
  h.send("w4", "one more thing");
  const second = await h.nextCall(1);
  assert.deepEqual(users(second.request.messages).slice(-2), ['[They reacted ❤️ to your message: "Anytime!"]', "[m2] one more thing"]);
  second.answer(respond(say("Sure, go ahead.")));
  await h.agent.conversation("w4")!.whenIdle();
});

test("a message the provider sends again (a webhook retried) is taken once", async () => {
  const h = multi({ channels: { sms: { info: SMS, phone: true } } });
  const first = { channel: "sms", from: "+15550100100", message: "first", messageId: "SM9f2c" };
  const [a, b] = await Promise.all([h.agent.message(first), h.agent.message(first)]);
  assert.deepEqual(a, b);
  const turn = await h.nextCall(0);
  assert.deepEqual(users(turn.request.messages), ["[SM9f2c] first"]);
  turn.answer(respond(call("send_sms", { text: "Got it." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  await h.agent.message(first);
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.equal(h.calls.length, 1, "no turn for the repeat");
  assert.equal(h.events.filter((e) => e.type === "message.duplicate").length, 2);
});

test("a long conversation sends the model only its latest messages that fit", async () => {
  const report = tool({ name: "report", description: "", input: z.object({}), run: () => "x".repeat(5_000) });
  const h = multi({ channels: { sms: { info: SMS, phone: true } }, tools: [report], history: { maxTokens: 5_000, toolResultChars: 1_000 } });
  const a = await h.message("sms", "+15550100100", "I'm Sam, allergic to nuts");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Noted, Sam." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  for (let i = 0; i < 8; i++) {
    await h.message("sms", "+15550100100", `${i}: ${"a long story ".repeat(120)}`);
    (await h.nextCall(1 + i)).answer(respond(call("send_sms", { text: "Mm." })));
    await h.agent.conversation(a!.conversationId)!.whenIdle();
  }
  await h.message("sms", "+15550100100", "what can I eat?");
  const ask = await h.nextCall(9);
  const sent = ask.request.messages;
  assert.match(sent[0].role === "user" ? sent[0].content : "", /^\[Chinwag\] Older messages of this conversation are no longer shown to you\.$/);
  assert.equal(sent[1].role, "user", "it starts at the start of an entry, never at a tool result");
  assert.ok(!sent.some((m) => m.role === "user" && m.content.includes("allergic")), "the first message is left out");
  assert.match(users(sent).at(-1)!, /what can I eat\?$/);
  const chars = ask.request.system.length + JSON.stringify(ask.request.tools).length + sent.reduce((n, m) => n + (m.content?.length ?? 0) + (m.role === "assistant" ? JSON.stringify(m.toolCalls ?? []).length : 0), 0);
  assert.ok(chars / 3 <= 5_000, `within the budget (${Math.round(chars / 3)} tokens)`);
  assert.ok(h.events.some((e) => e.type === "history.trimmed"));

  ask.answer(respond(call("send_sms", { text: "Checking." }), call("report")));
  const result = await h.nextCall(10);
  assert.match(last(result.request.messages).content, /^x{1000}\n\[Chinwag\] Cut: the result was 5000 characters; only the first 1000 are shown\.$/);
  result.answer(respond(call("send_sms", { text: "Anything without nuts." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
});
