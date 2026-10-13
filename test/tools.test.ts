// covers: src/conversation.ts src/tools.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { tool } from "../src/index.ts";
import { WEB, call, gate, harness, last, respond, say, users } from "./helpers.ts";

test("tools in one response run together, and messages go out while they run", async () => {
  const a = gate<string>();
  const b = gate<string>();
  const started: string[] = [];
  const toolA = tool({ name: "a", description: "", input: z.object({}), deadlineMs: 60_000, run: () => (started.push("a"), a.promise) });
  const toolB = tool({ name: "b", description: "", input: z.object({}), deadlineMs: 60_000, run: () => (started.push("b"), b.promise) });
  const h = harness([toolA, toolB]);
  h.send("c5", "do both");
  (await h.nextCall(0)).answer(respond(say("On it."), call("a"), call("b")));
  while (started.length < 2) await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.sent(), ["On it."], "the message is out before the tools finish");
  a.open("A done");
  b.open("B done");
  const second = await h.nextCall(1);
  const results = second.request.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
  assert.deepEqual(results, [JSON.stringify({ delivered: true, channel: "chat" }), "A done", "B done"]);
  second.answer(respond(say("Both done.")));
  await h.agent.conversation("c5")!.whenIdle();
});

test("with nothing new from them, the reply waits for its tool and gets the result itself", async () => {
  const done = gate<string>();
  const book = tool({ name: "book", description: "", input: z.object({}), run: () => done.promise });
  const h = harness([book], 60_000);
  h.send("c4", "move my session to Friday");
  (await h.nextCall(0)).answer(respond(say("Booking Friday."), call("book")));
  while (!h.events.some((e) => e.type === "tool.start")) await new Promise((r) => setImmediate(r));
  done.open("booked Friday 2pm");
  const second = await h.nextCall(1);
  assert.equal(last(second.request.messages).content, "booked Friday 2pm");
  second.answer(respond(say("Done: Friday at 2pm.")));
  await h.agent.conversation("c4")!.whenIdle();
  assert.ok(!h.events.some((e) => e.type === "tool.detached"), "nothing went to the background");
  assert.deepEqual(h.sent(), ["Booking Friday.", "Done: Friday at 2pm."]);
});

test("a tool still running a while after another finished: the finished result goes back now", async () => {
  const slow = gate<string>();
  const plan = tool({ name: "get_plan", description: "", input: z.object({}), deadlineMs: 60_000, run: () => "Weekly plan" });
  const labs = tool({ name: "get_labs", description: "", input: z.object({}), deadlineMs: 60_000, run: () => slow.promise });
  const h = harness([plan, labs]);
  h.send("c3", "my plan and my labs");
  (await h.nextCall(0)).answer(respond(say("Getting both."), call("get_plan"), call("get_labs")));
  const second = await h.nextCall(1);
  const results = second.request.messages.filter((m) => m.role === "tool").map((m) => (m as { content: string }).content);
  assert.equal(results[1], "Weekly plan");
  assert.match(results[2], /get_labs started and is still running in the background \(task_1\).*The other results are in: tell them this now only if it answers what they asked; the rest is coming\./);
  second.answer(respond(say("Your plan: weekly. Labs are coming.")));
  slow.open("A1c 6.1");
  (await h.nextCall(2)).answer(respond(say("Your A1c is 6.1.")));
  await h.agent.conversation("c3")!.whenIdle();
  assert.ok(h.events.some((e) => e.type === "tool.detached" && e.why === "partial"));
});

test("a tool past its own limit moves to the background and its result comes back into the chat", async () => {
  const done = gate<string>();
  const book = tool({ name: "book", description: "", input: z.object({}), run: () => done.promise });
  const h = harness([book], 10);
  h.send("c6", "move my session to Friday");

  (await h.nextCall(0)).answer(respond(say("Booking Friday."), call("book")));
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /still running in the background \(task_1\)\. Do not call book again/);
  second.answer(respond());

  assert.equal(h.agent.status().backgroundTasks, 1);
  assert.equal(h.agent.status().busy, true);
  done.open("booked Friday 2pm");

  const third = await h.nextCall(2);
  assert.match(users(third.request.messages).at(-1)!, /Background result: book .* booked Friday 2pm/);
  third.answer(respond(say("Done: Friday at 2pm.")));

  await h.agent.conversation("c6")!.whenIdle();
  assert.deepEqual(h.sent(), ["Booking Friday.", "Done: Friday at 2pm."]);
  assert.equal(h.agent.status().busy, false);
});

test("a background result the agent answers in plain text is sent back once, with its send tool named", async () => {
  const done = gate<string>();
  const book = tool({ name: "book", description: "", input: z.object({}), run: () => done.promise });
  const h = harness([book], 10);
  h.send("c7", "move my session to Friday");
  (await h.nextCall(0)).answer(respond(say("Booking Friday."), call("book")));
  (await h.nextCall(1)).answer(respond());
  done.open("booked Friday 2pm");
  (await h.nextCall(2)).answer({ text: "Done: Friday at 2pm.", toolCalls: [] });
  const reminder = await h.nextCall(3);
  assert.match(last(reminder.request.messages).content, /^\[Parley\] INTERNAL MESSAGE, not from them: they have not heard from you since the result above.*without mentioning this note/);
  assert.match(reminder.request.system, /Lines starting \[Parley\] are INTERNAL MESSAGES/);
  reminder.answer(respond(say("Done: Friday at 2pm.")));
  await h.agent.conversation("c7")!.whenIdle();
  assert.deepEqual(h.sent(), ["Booking Friday.", "Done: Friday at 2pm."]);
  assert.equal(h.calls.length, 4);
});

test("a tool result the agent answers in plain text, after acknowledging, is sent back once", async () => {
  const log = tool({ name: "log_run", description: "", input: z.object({}), run: () => "logged 5 km" });
  const h = harness([log], 60_000);
  h.send("c2", "log my run: 5 km");
  (await h.nextCall(0)).answer(respond(say("Logging that now."), call("log_run")));
  (await h.nextCall(1)).answer({ text: "Logged your 5 km run; your coach will see it today.", toolCalls: [] });
  const reminder = await h.nextCall(2);
  assert.match(last(reminder.request.messages).content, /^\[Parley\] INTERNAL MESSAGE, not from them: they have not heard from you since the result above/);
  reminder.answer(respond(say("Logged your 5 km run; your coach will see it today.")));
  await h.agent.conversation("c2")!.whenIdle();
  assert.deepEqual(h.sent(), ["Logging that now.", "Logged your 5 km run; your coach will see it today."]);
  assert.equal(h.calls.length, 3);
});

test("plain text that repeats a message already sent in the turn is not sent back", async () => {
  const log = tool({ name: "log_run", description: "", input: z.object({}), run: () => "logged 5 km" });
  const h = harness([log], 60_000);
  h.send("c1", "log my run: 5 km");
  (await h.nextCall(0)).answer(respond(say("Logged; your coach will see it today."), call("log_run")));
  (await h.nextCall(1)).answer({ text: "Logged; your coach will see it today.", toolCalls: [] });
  await h.agent.conversation("c1")!.whenIdle();
  assert.deepEqual(h.sent(), ["Logged; your coach will see it today."]);
  assert.equal(h.calls.length, 2, "no reminder: it already said that");
});

test("a reply of only messages after a tool was used ends the turn: no extra step", async () => {
  const done = gate<string>();
  const book = tool({ name: "book", description: "", input: z.object({}), run: () => done.promise });
  const h = harness([book], 10, WEB, "manual");
  h.send("c8", "move my session to Friday");
  (await h.nextCall(0)).answer(respond(say("Booking Friday."), call("book")));
  (await h.nextCall(1)).answer(respond(say("Still on it.")));
  done.open("booked Friday 2pm");
  const next = await h.nextCall(2);
  assert.match(users(next.request.messages).at(-1)!, /Background result: book/, "the next call is the result's turn, not a follow-up");
  next.answer(respond(say("Done: Friday at 2pm.")));
  await h.agent.conversation("c8")!.whenIdle();
  assert.equal(h.calls.length, 3);
});

test("a call identical to one still running in the background is not run again", async () => {
  const done = gate<string>();
  let runs = 0;
  const plan = tool({ name: "get_plan", description: "", input: z.object({ week: z.number() }), run: () => (runs++, done.promise) });
  const h = harness([plan], 10);
  h.send("c9", "send me my plan");
  (await h.nextCall(0)).answer(respond(say("Getting your plan."), call("get_plan", { week: 3 })));
  const second = await h.nextCall(1);
  second.answer(respond(call("get_plan", { week: 3 }), call("get_plan", { week: 4 })));
  const third = await h.nextCall(2);
  const results = third.request.messages.slice(-2).map((m) => (m as { content: string }).content);
  assert.match(results[0], /Not run: get_plan with this input is already running in the background \(task_1\)/);
  assert.match(results[1], /still running in the background \(task_2\)/, "a different input runs");
  assert.equal(runs, 2);
  third.answer(respond());
  done.open("Weekly plan");
  (await h.nextCall(3)).answer(respond(say("Your plan: weekly.")));
  await h.agent.conversation("c9")!.whenIdle();
  assert.ok(h.events.some((e) => e.type === "tool.repeated"));
});
