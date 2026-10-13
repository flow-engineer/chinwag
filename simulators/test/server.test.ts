// covers: simulators/src/server.ts simulators/src/platforms.ts src/agent.ts src/conversation.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sqlite, type ChannelInfo, type ChannelSummary, type Deliver } from "../../src/index.ts";
import { WHATSAPP, call, multi, respond } from "../../test/helpers.ts";
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

/** The test cloud's simulators: any person, any platform. */
async function start(helpReply?: string, channels?: ChannelSummary[]) {
  const { fake, connection } = fakeAgent(channels);
  const server = await simulators({ sms: { helpReply }, testCloud: true }).listen(connection, 0);
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

const MARIA = { name: "Maria", phone: "+15555550101" };

/** Pip-like agent with one WhatsApp channel and Maria as its test person, on `database`. */
function agentOn(database: ReturnType<typeof sqlite>, dir?: string) {
  return multi({ channels: { whatsapp: { info: WHATSAPP, phone: true } }, testPeople: [MARIA], database, dir });
}

test("a deployed playground lets in only its token, then only the agent's test people", async () => {
  const h = agentOn(sqlite());
  const play = simulators();
  assert.throws(() => play.handler(h.agent, { token: undefined as unknown as string }), /token/);
  assert.throws(() => play.handler(h.agent, { token: "too-short" }), /32 characters/);
  const token = "t".repeat(40);
  const server = createServer(play.handler(h.agent, { token, base: "/play" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/play`;
  try {
    assert.equal((await fetch(`${url}/`)).status, 401);
    assert.equal((await fetch(`${url}/api/platforms`, { headers: { authorization: "Bearer wrong" } })).status, 401);

    const opened = await fetch(`${url}/?token=${token}&channel=whatsapp`, { redirect: "manual" });
    assert.equal(opened.status, 303);
    assert.equal(opened.headers.get("location"), "/play/?channel=whatsapp", "the token leaves the URL");
    const cookie = opened.headers.get("set-cookie")!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(cookie, new RegExp(token), "the cookie does not hold the token");
    assert.equal((await fetch(`${url}/`, { headers: { cookie: cookie.split(";")[0] } })).status, 200);
    assert.equal((await fetch(`${url}/api/platforms`, { headers: { authorization: `Bearer ${token}` } })).status, 200);

    const stranger = await fetch(`${url}/api/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: "whatsapp", person: "+15555550199", text: "hi" }),
    });
    assert.equal(stranger.status, 403);
    assert.equal(h.calls.length, 0);

    for (let i = 0; i < 9; i++) await fetch(`${url}/api/status`, { headers: { authorization: "Bearer wrong" } });
    assert.equal((await fetch(`${url}/api/status`, { headers: { authorization: `Bearer ${token}` } })).status, 429, "too many wrong tokens: even the right one waits");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the playground shows the person's conversation from the agent's store, also after a restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "parley-play-")), "parley.db");
  const first = agentOn(sqlite(path));
  await first.agent.resume();
  const play = simulators();
  const server = await play.listen(first.agent, 0);
  const send = await fetch(`${server.url}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "whatsapp", person: MARIA.phone, text: "a latte please" }),
  });
  assert.equal(send.status, 202);
  (await first.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Which size?", buttons: ["Small", "Large"] })));
  const id = (await first.agent.testConversation(MARIA.phone))!;
  await first.agent.conversation(id)!.whenIdle();
  await server.close();

  const again = agentOn(sqlite(path), first.dir);
  await again.agent.resume();
  const restarted = await simulators().listen(again.agent, 0);
  try {
    const { lines } = (await (await fetch(`${restarted.url}/api/transcript?channel=whatsapp&person=${encodeURIComponent(MARIA.phone)}`)).json()) as { lines: Line[] };
    const said = lines.flatMap((l) => (l.kind === "in" || l.kind === "out" ? [[l.kind, l.text, l.kind === "out" ? l.buttons : undefined]] : []));
    assert.deepEqual(said, [["in", "a latte please", undefined], ["out", "Which size?", ["Small", "Large"]]]);
  } finally {
    await restarted.close();
  }
});
