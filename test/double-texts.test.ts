// covers: src/conversation.ts src/events.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { createAgent, tool, type EventSink } from "../src/index.ts";
import { call, gate, harness, last, respond, say, scriptedModel, users } from "./helpers.ts";

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

test("a double text that comes before the first model call (the turn still loading) joins that call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chinwag-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const loading = gate();
  const loaded = gate<string>();
  const agent = createAgent({ dir, model: scripted.model, debounceMs: 0, context: () => (loading.open(), loaded.promise) });
  agent.receive("c9", "hi", () => undefined);
  await loading.promise;
  agent.receive("c9", "can I move Thursday?", () => undefined);
  loaded.open("");

  const first = await scripted.nextCall(0);
  assert.deepEqual(users(first.request.messages), ["[m1] hi", "[m2] can I move Thursday?"]);
  first.answer(respond(say("Hi! Sure, which day works?")));
  await agent.conversation("c9")!.whenIdle();
});

test("the context block is an event, so a judge can see what the agent was given", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chinwag-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const events: Array<{ type: string; text?: unknown }> = [];
  const sink: EventSink = (e) => events.push(e);
  sink.context = true;
  const agent = createAgent({
    dir,
    model: scripted.model,
    debounceMs: 0,
    context: () => "Name: Sam. Next: Thursday 10:00.",
    events: [sink],
  });
  agent.receive("c1", "when is it?", () => undefined);
  const first = await scripted.nextCall(0);
  assert.match(String(first.request.system ?? ""), /Name: Sam/);
  first.answer(respond(say("Thursday at 10.")));
  await agent.conversation("c1")!.whenIdle();
  assert.equal(events.find((e) => e.type === "turn.context")?.text, "Name: Sam. Next: Thursday 10:00.");
});

test("turn.context stays off unless a sink asks for it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chinwag-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const events: string[] = [];
  const agent = createAgent({
    dir,
    model: scripted.model,
    debounceMs: 0,
    context: () => "Name: Sam. Next: Thursday 10:00.",
    events: [(e) => events.push(e.type)],
  });
  agent.receive("c1", "when is it?", () => undefined);
  const first = await scripted.nextCall(0);
  assert.match(String(first.request.system ?? ""), /Name: Sam/);
  first.answer(respond(say("Thursday at 10.")));
  await agent.conversation("c1")!.whenIdle();
  assert.equal(events.includes("turn.context"), false);
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
