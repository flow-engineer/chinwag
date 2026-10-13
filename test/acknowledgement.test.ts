// covers: src/conversation.ts src/events.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { tool } from "../src/index.ts";
import { call, harness, last, respond, say } from "./helpers.ts";

test("typing shows the moment a message arrives, before the reply starts", () => {
  const h = harness();
  h.send("c0", "hi");
  assert.deepEqual(h.out, [{ type: "typing", on: true }]);
  assert.equal(h.calls.length, 0);
});

test("a first response that only calls tools is held until the agent acknowledges", async () => {
  let ran = 0;
  const lookup = tool({ name: "lookup", description: "", input: z.object({}), run: () => (ran++, { next: "Thursday 10am" }) });
  const h = harness([lookup]);
  h.send("c2", "when is my session?");

  (await h.nextCall(0)).answer(respond(call("lookup")));
  const second = await h.nextCall(1);
  assert.equal(ran, 0, "held calls do not run");
  assert.match(last(second.request.messages).content, /have not heard from you/);
  second.answer(respond(say("Checking…"), call("lookup")));

  const third = await h.nextCall(2);
  assert.equal(ran, 1);
  assert.match(last(third.request.messages).content, /Thursday/);
  third.answer(respond(say("Thursday at 10.")));
  await h.agent.conversation("c2")!.whenIdle();
  assert.deepEqual(h.sent(), ["Checking…", "Thursday at 10."]);
  assert.ok(h.events.some((e) => e.type === "ack.required"));
});

test("typing stops once the person is acknowledged", async () => {
  const lookup = tool({ name: "lookup", description: "", input: z.object({}), run: () => "ok" });
  const h = harness([lookup]);
  h.send("c3", "check please");
  (await h.nextCall(0)).answer(respond(call("react", { message_id: "m1", emoji: "👌" }), call("lookup")));
  const typingAfterReaction = () => {
    const at = h.out.findIndex((o) => o.type === "reaction");
    return h.out.slice(at + 1).filter((o) => o.type === "typing");
  };
  (await h.nextCall(1)).answer(respond(say("All good.")));
  await h.agent.conversation("c3")!.whenIdle();
  assert.deepEqual(typingAfterReaction(), [{ type: "typing", on: false }]);
});

test("plain text from the model is never shown, and the agent is reminded to reply", async () => {
  const h = harness();
  h.send("c10", "hey");
  (await h.nextCall(0)).answer({ text: "Hello!", toolCalls: [] });
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /^\[Parley\] INTERNAL MESSAGE, not from them: your text above never reached them\. Reply with send_chat, without mentioning this note, that text or any delay\./);
  second.answer(respond(say("Hey! How can I help?")));
  await h.agent.conversation("c10")!.whenIdle();
  assert.deepEqual(h.sent(), ["Hey! How can I help?"]);
});
