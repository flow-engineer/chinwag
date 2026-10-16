// covers: src/agent.ts src/conversation.ts src/talk.ts src/store.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { sqlite, Store, tool } from "../src/index.ts";
import { SMS, WEB_APP, WHATSAPP, call, last, multi, respond, users } from "./helpers.ts";

const PHONES = { sms: { info: SMS, phone: true }, whatsapp: { info: WHATSAPP, phone: true } };

test("the same phone number on two channels is one person, in one conversation, however each channel writes it", async () => {
  const h = multi({ channels: PHONES });
  const a = await h.message("sms", "+1 (555) 010-0100", "hi");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Hi!" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  // WhatsApp gives the number as bare international digits.
  const b = await h.message("whatsapp", "15550100100", "it's me on WhatsApp");
  assert.equal(b!.conversationId, a!.conversationId);
  const second = await h.nextCall(1);
  assert.deepEqual(users(second.request.messages), ["[sms · m1] hi", "[whatsapp · m2] it's me on WhatsApp"], "one history across both channels");
  second.answer(respond(call("send_whatsapp", { text: "Got you here too." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
});

test("first messages from one number on two channels at once make one conversation", async () => {
  const database = sqlite();
  const h = multi({ channels: PHONES, database });
  const [a, b] = await Promise.all([h.message("sms", "+15550007777", "hi"), h.message("whatsapp", "15550007777", "hi")]);
  assert.equal(a!.conversationId, b!.conversationId);
  assert.deepEqual((await new Store(database, "default").allConversations()).map((c) => c.personKey), ["phone:+15550007777"]);
});

test("different numbers, and a web visitor with no resolver, are never joined", async () => {
  const h = multi({ channels: { ...PHONES, web: { info: WEB_APP } } });
  const a = await h.message("sms", "+15550100100", "hi");
  const b = await h.message("sms", "+15550100200", "hi");
  const c = await h.message("web", "+15550100100", "hi");
  assert.equal(new Set([a!.conversationId, b!.conversationId, c!.conversationId]).size, 3);
});

test("the owner's resolver joins a web visitor to the person, and tools get who they are", async () => {
  const seen: string[] = [];
  const whoami = tool({ name: "whoami", description: "", input: z.object({}), run: (_input, context) => (seen.push(context.person), "ok") });
  const h = multi({
    channels: { sms: { info: SMS, phone: true }, web: { info: WEB_APP } },
    tools: [whoami],
    resolve: ({ address }) => (address === "+15550100100" || address === "session-sam" ? "customer-7" : null),
  });
  const a = await h.message("sms", "+15550100100", "hi");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Hi!" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  const b = await h.message("web", "session-sam", "same person here");
  assert.equal(b!.conversationId, a!.conversationId);
  (await h.nextCall(1)).answer(respond(call("send_web", { text: "Hello again." }), call("whoami")));
  (await h.nextCall(2)).answer(respond());
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(seen, ["key:customer-7"]);
});

test("each channel's send tool is named for it from the first message; a second channel adds one and changes nothing", async () => {
  const h = multi({ channels: { sms: { info: SMS, phone: true }, web: { info: WEB_APP } }, resolve: () => "customer-7" });
  await h.message("sms", "+15550100100", "hi");
  const first = await h.nextCall(0);
  assert.deepEqual(first.request.tools.filter((t) => t.name.startsWith("send_")).map((t) => t.name), ["send_sms"]);
  first.answer(respond(call("send_sms", { text: "Hi!" })));
  const b = await h.message("web", "session-sam", "hey");
  const { call: c } = await h.callWith(1, (x) => users(x.request.messages).at(-1)!.includes("hey"));
  const names = c.request.tools.map((t) => t.name);
  assert.ok(names.includes("send_sms") && names.includes("send_web"));
  // The earlier send is still a call to a tool the agent has, and says where it went.
  const earlier = c.request.messages.findIndex((m) => m.role === "assistant" && m.toolCalls?.some((t) => t.name === "send_sms"));
  assert.ok(earlier >= 0);
  assert.equal((c.request.messages[earlier + 1] as { content: string }).content, JSON.stringify({ delivered: true, channel: "sms" }));
  const props = (name: string) => Object.keys((c.request.tools.find((t) => t.name === name)!.parameters as { properties: object }).properties);
  assert.deepEqual(props("send_sms"), ["text", "confirm", "link"]);
  assert.ok(props("send_web").includes("buttons"));
  c.answer(respond(call("send_web", { text: "Hey!" })));
  await h.agent.conversation(b!.conversationId)!.whenIdle();
});

test("messages on two channels in one turn each get their answer on their own channel", async () => {
  const h = multi({ channels: { sms: { info: SMS, phone: true }, web: { info: WEB_APP } }, resolve: () => "customer-7" });
  await h.message("web", "session-sam", "hi");
  (await h.nextCall(0)).answer(respond(call("send_web", { text: "Hi!" })));
  await h.message("web", "session-sam", "find my latest recipes");
  const b = await h.message("sms", "+15550100100", "when is my next appointment?");
  const { call: c } = await h.callWith(1, (x) => users(x.request.messages).at(-1)!.includes("appointment"));
  assert.match(users(c.request.messages).join("\n"), /\[web · m2\] find my latest recipes\n\[sms · m3\] when is my next appointment\?/);
  c.answer(respond(call("send_web", { text: "Your latest recipes: …" }), call("send_sms", { text: "Thursday at 10am." })));
  await h.agent.conversation(b!.conversationId)!.whenIdle();
  assert.deepEqual(h.texts("web"), ["Hi!", "Your latest recipes: …"]);
  assert.deepEqual(h.texts("sms"), ["Thursday at 10am."]);
});

test("a send on a channel missing from their last 5 messages is held until the agent confirms", async () => {
  const h = multi({ channels: { sms: { info: SMS, phone: true }, web: { info: WEB_APP } }, resolve: () => "customer-7" });
  const a = await h.message("sms", "+15550100100", "hi");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Hi!" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  for (const text of ["one", "two", "three", "four", "text me the link"]) await h.message("web", "session-sam", text);
  const { call: c, index } = await h.callWith(1, (x) => users(x.request.messages).at(-1)!.includes("text me the link"));
  c.answer(respond(call("send_sms", { text: "Here's the link: …" })));
  const next = await h.nextCall(index + 1);
  assert.match(last(next.request.messages).content, /have not written on sms in their last 5 messages.*confirm: true/);
  assert.deepEqual(h.texts("sms"), ["Hi!"], "nothing went out yet");
  next.answer(respond(call("send_sms", { text: "Here's the link: …", confirm: true })));
  // They asked on web and heard nothing there: the agent is reminded to answer on web too.
  const reminder = await h.nextCall(index + 2);
  assert.match(last(reminder.request.messages).content, /have not heard from you on web/);
  reminder.answer(respond(call("send_web", { text: "I've texted it to you." })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(h.texts("sms"), ["Hi!", "Here's the link: …"]);
});

test("with messages waiting on two channels, tool calls wait until both have heard from the agent", async () => {
  let ran = 0;
  const lookup = tool({ name: "lookup", description: "", input: z.object({}), run: () => (ran++, "Thursday 10am") });
  const h = multi({ channels: { sms: { info: SMS, phone: true }, web: { info: WEB_APP } }, tools: [lookup], resolve: () => "customer-7" });
  await h.message("web", "session-sam", "hi");
  (await h.nextCall(0)).answer(respond(call("send_web", { text: "Hi!" })));
  await h.message("web", "session-sam", "check my plan");
  const b = await h.message("sms", "+15550100100", "and my appointment");
  const { call: c, index } = await h.callWith(1, (x) => users(x.request.messages).at(-1)!.includes("appointment"));
  c.answer(respond(call("send_web", { text: "On it." }), call("lookup")));
  const held = await h.nextCall(index + 1);
  assert.equal(ran, 0, "held calls do not run");
  assert.match(last(held.request.messages).content, /have not heard from you on sms yet/);
  held.answer(respond(call("send_web", { text: "On it." }), call("send_sms", { text: "Checking." }), call("lookup")));
  (await h.nextCall(index + 2)).answer(respond(call("send_sms", { text: "Thursday at 10am." })));
  await h.agent.conversation(b!.conversationId)!.whenIdle();
  assert.equal(ran, 1);
  assert.ok(h.events.some((e) => e.type === "ack.required"));
});
