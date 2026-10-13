// covers: simulators/src/server.ts simulators/src/platforms.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChannelInfo, ChannelSummary, Deliver } from "../../src/index.ts";
import { simulators, type AgentConnection, type Line } from "../src/index.ts";

/** An agent that answers nothing by itself: the test delivers through the last `deliver` it got. */
function fakeAgent(channels?: ChannelSummary[]) {
  const fake = {
    deliver: null as Deliver | null,
    conversationIds: [] as string[],
    reactions: [] as { conversationId: string; emoji: string; toText: string }[],
    count: 0,
    options: [] as Array<{ channel: ChannelInfo; channelName?: string }>,
  };
  const connection: AgentConnection = {
    receive: (conversationId, _incoming, deliver, options) => {
      fake.deliver = deliver;
      fake.conversationIds.push(conversationId);
      fake.options.push(options);
      return `m${++fake.count}`;
    },
    ...(channels ? { channels: () => channels } : {}),
    reacted: (conversationId, emoji, toText) => void fake.reactions.push({ conversationId, emoji, toText }),
    status: () => ({ busy: false, idleForMs: 0, backgroundTasks: 0, conversations: 0 }),
  };
  return { fake, connection };
}

async function start(helpReply?: string, channels?: ChannelSummary[], shareConversations = false) {
  const { fake, connection } = fakeAgent(channels);
  const server = await simulators({ sms: { helpReply }, shareConversations }).listen(connection, 0);
  const post = (path: string, body: unknown) =>
    fetch(server.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const send = async (platform: string, text: string) => assert.equal((await post("/api/messages", { platform, person: "p", text })).status, 202);
  const lines = async (platform: string): Promise<Line[]> => (await (await fetch(`${server.url}/api/transcript?platform=${platform}&person=p`)).json()).lines;
  return { fake, server, post, send, lines };
}

test("SMS: after STOP the carrier answers and blocks the agent; START lets it through; HELP is the configured reply", async () => {
  const { fake, server, send, lines } = await start("Cafe: reply STOP to opt out.");
  try {
    await send("sms", "stop");
    const stopped = (await lines("sms")).at(-1);
    assert.ok(stopped?.kind === "out" && stopped.carrier && stopped.text.startsWith("You have successfully been unsubscribed"));
    assert.throws(() => fake.deliver!({ type: "message", text: "Still there?" }), /STOP/);

    await send("sms", "START");
    fake.deliver!({ type: "message", text: "Welcome back" });
    const after = await lines("sms");
    assert.ok(after.some((l) => l.kind === "out" && l.carrier && l.text.startsWith("You have successfully been re-subscribed")));
    const last = after.at(-1);
    assert.ok(last?.kind === "out" && !last.carrier);
    assert.equal(last.text, "Welcome back");

    await send("sms", "HELP");
    const help = (await lines("sms")).at(-1);
    assert.ok(help?.kind === "out" && help.carrier);
    assert.equal(help.text, "Cafe: reply STOP to opt out.");
  } finally {
    await server.close();
  }
});

test("a person can react to an agent message on WhatsApp, not on SMS", async () => {
  const { fake, server, post, send } = await start();
  try {
    for (const platform of ["whatsapp", "sms"]) {
      await send(platform, "hi");
      fake.deliver!({ type: "message", text: `hello on ${platform}` });
    }
    const react = (platform: string) => post("/api/reactions", { platform, person: "p", messageId: "a1", emoji: "👍" });
    assert.equal((await react("sms")).status, 400);
    assert.equal(fake.reactions.length, 0);
    assert.equal((await react("whatsapp")).status, 202);
    assert.deepEqual(fake.reactions, [{ conversationId: "whatsapp:p", emoji: "👍", toText: "hello on whatsapp" }]);
  } finally {
    await server.close();
  }
});

test("the web simulator plays the agent's own custom UI, and shows the params it sent", async () => {
  const app: ChannelSummary = { name: "app", kind: "custom", info: { reactions: false, status: true, formatting: "markdown" } };
  const { fake, server, send, lines } = await start(undefined, [app]);
  try {
    await send("web", "show my progress");
    assert.deepEqual(fake.options.at(-1), { channel: app.info, channelName: "app" });
    await fake.deliver!({ type: "message", text: "Here it is.", fields: { app_link: { url: "https://app.example/progress", screen: "progress" } } });
    const out = (await lines("web")).at(-1);
    assert.ok(out?.kind === "out");
    assert.deepEqual(out.fields, { app_link: { url: "https://app.example/progress", screen: "progress" } });

    await send("sms", "hi");
    assert.equal(fake.options.at(-1)!.channelName, undefined, "SMS is not one of this agent's channels: the platform's own rules");
  } finally {
    await server.close();
  }
});

test("shared conversations: one person on the agent's SMS and app is one conversation, each reply on its own platform", async () => {
  const channels: ChannelSummary[] = [
    { name: "sms", kind: "sms", info: { reactions: false, status: false, formatting: "plain" } },
    { name: "app", kind: "custom", info: { reactions: false, status: false, formatting: "markdown" } },
  ];
  const { fake, server, send, lines } = await start(undefined, channels, true);
  try {
    await send("sms", "hi");
    const bySms = fake.deliver!;
    await send("web", "show my progress");
    assert.deepEqual(fake.conversationIds, ["person:p", "person:p"]);
    await bySms({ type: "message", text: "Hi by text" });
    await fake.deliver!({ type: "message", text: "Here in the app" });
    assert.deepEqual((await lines("sms")).filter((l) => l.kind === "out").map((l) => l.kind === "out" && l.text), ["Hi by text"]);
    assert.deepEqual((await lines("web")).filter((l) => l.kind === "out").map((l) => l.kind === "out" && l.text), ["Here in the app"]);
  } finally {
    await server.close();
  }
});
