// covers: src/conversation.ts src/events.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { tool } from "../src/index.ts";
import { call, gate, harness, last, respond, say, users } from "./helpers.ts";

test("a double text folds into the reply being written", async () => {
  const h = harness();
  h.send("c7", "hi");
  await h.nextCall(0);
  h.send("c7", "can I move Thursday?");

  const second = await h.nextCall(1);
  assert.deepEqual(users(second.request.messages), ["[m1] hi", "[m2] can I move Thursday?"]);
  second.answer(respond(say("Hi! Sure, which day works?")));

  await h.agent.conversation("c7")!.whenIdle();
  assert.deepEqual(h.sent(), ["Hi! Sure, which day works?"]);
  assert.ok(h.events.some((e) => e.type === "model.restarted"));
});

test("a message sent while tools run is read at once: the tool moves to the background", async () => {
  const release = gate<string>();
  const started = gate();
  const slowish = tool({
    name: "check",
    description: "",
    input: z.object({}),
    deadlineMs: 60_000,
    run: () => {
      started.open();
      return release.promise;
    },
  });
  const h = harness([slowish]);
  h.send("c8", "check my plan");
  (await h.nextCall(0)).answer(respond(say("Checking."), call("check")));
  await started.promise;
  h.send("c8", "and my next session");

  const second = await h.nextCall(1);
  assert.equal(last(second.request.messages).content, "[m2] and my next session");
  const result = second.request.messages.find((m) => m.role === "tool" && m.content.includes("still running"));
  assert.match((result as { content: string }).content, /check started and is still running in the background \(task_1\)/);
  second.answer(respond(say("Your next session is Thursday.")));
  release.open("plan ok");

  const third = await h.nextCall(2);
  assert.match(users(third.request.messages).at(-1)!, /Background result: check \(task_1\)\] plan ok/);
  third.answer(respond(say("And your plan is fine.")));
  await h.agent.conversation("c8")!.whenIdle();
  assert.equal(h.sent().length, 3);
});
