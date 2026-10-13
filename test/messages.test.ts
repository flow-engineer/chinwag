// covers: src/conversation.ts src/talk.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { tool } from "../src/index.ts";
import { WEB, WHATSAPP, call, harness, last, respond, say, users } from "./helpers.ts";

test("the person's messages carry ids the agent can react to", async () => {
  const h = harness();
  const id = h.send("c1", "table for 2 at 7pm");
  assert.equal(id, "m1");
  const first = await h.nextCall(0);
  assert.equal(users(first.request.messages).at(-1), "[m1] table for 2 at 7pm");
  first.answer(respond(call("react", { message_id: "m1", emoji: "👍" })));
  await h.agent.conversation("c1")!.whenIdle();
  assert.deepEqual(h.out.filter((o) => o.type === "reaction"), [{ type: "reaction", emoji: "👍", messageId: "m1" }]);
});

test("after their message, a reply of only messages gets one more step, to act on what it said", async () => {
  const plan = tool({ name: "get_plan", description: "", input: z.object({}), run: () => "soup of the day, then the pasta" });
  const h = harness([plan], 50, WEB, "manual");
  h.send("c4", "send me my plan");
  (await h.nextCall(0)).answer(respond(say("Getting your plan."), say("One moment.")));
  const followUp = await h.nextCall(1);
  const results = followUp.request.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
  assert.deepEqual(results, Array(2).fill(JSON.stringify({ delivered: true, channel: "chat" })), "it sees its messages were delivered");
  followUp.answer(respond(call("get_plan")));
  (await h.nextCall(2)).answer(respond(say("Your plan: soup of the day, then the pasta.")));
  await h.agent.conversation("c4")!.whenIdle();
  assert.deepEqual(h.sent(), ["Getting your plan.", "One moment.", "Your plan: soup of the day, then the pasta."]);
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
