// covers: simulators/src/server.ts simulators/src/platforms.ts src/agent.ts src/conversation.ts src/channels.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, sqlite, type ChannelInfo, type ChannelSummary, type Deliver, type Incoming, type Model, type TemplateDefinition } from "../../src/index.ts";
import { WHATSAPP, call, gate, multi, respond } from "../../test/helpers.ts";
import { simulators, type AgentConnection, type Line } from "../src/index.ts";

/** An agent that answers nothing by itself: the test delivers through the last `deliver` it got. */
function fakeAgent(channels?: ChannelSummary[]) {
  const fake = {
    deliver: null as Deliver | null,
    conversationIds: [] as string[],
    reactions: [] as { conversationId: string; emoji: string; toText: string }[],
    count: 0,
    options: [] as Array<{ channel: ChannelInfo; channelName?: string }>,
    incomings: [] as Incoming[],
  };
  const connection: AgentConnection = {
    receive: (conversationId, incoming, deliver, options) => {
      fake.deliver = deliver;
      fake.incomings.push(incoming);
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
  const { fake, server, send, lines } = await start("Pip: reply STOP to opt out.");
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
    assert.equal(help.text, "Pip: reply STOP to opt out.");
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

test("WhatsApp and web show a link button and a photo the agent sends; SMS offers neither", async () => {
  const { fake, server, send, lines } = await start();
  try {
    const link = { label: "Open in app", url: "https://example.com/l/7" };
    const image = { url: "https://example.com/flat.jpg" };
    for (const platform of ["whatsapp", "web"]) {
      await send(platform, "show me flats");
      assert.ok(fake.options.at(-1)!.channel.linkButton && fake.options.at(-1)!.channel.images);
      await fake.deliver!({ type: "message", text: "2 BHK, Indiranagar", link, image });
      const out = (await lines(platform)).at(-1);
      assert.ok(out?.kind === "out");
      assert.deepEqual([out.link, out.image], [link, image]);
    }
    await send("sms", "show me flats");
    assert.ok(!fake.options.at(-1)!.channel.linkButton && !fake.options.at(-1)!.channel.images);
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

const SAM = { name: "Sam", phone: "+15555550101" };

/** Pip-like agent with one WhatsApp channel and Sam as its test person, on `database`. */
function agentOn(database: ReturnType<typeof sqlite>, dir?: string) {
  return multi({ channels: { whatsapp: { info: WHATSAPP, phone: true } }, testPeople: [SAM], database, dir });
}

test("a deployed playground lets in only its token, from its own pages, then only the agent's test people", async () => {
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
    const deployed = { host: "agent.example.com", authorization: `Bearer ${token}` };
    assert.equal((await raw(`${url}/api/platforms`, { headers: { ...deployed, "sec-fetch-site": "same-origin" } })).status, 200, "deployed, the Host is the agent's own");
    const crossSite = await raw(`${url}/api/messages`, { method: "POST", headers: { ...deployed, "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: JSON.stringify({ channel: "whatsapp", person: SAM.phone, text: "hi" }) });
    assert.equal(crossSite.status, 403);

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

test("a file sent from a simulator reaches the agent with its bytes, the message box as its caption", async () => {
  const { fake, server, post, lines } = await start();
  try {
    const bytes = new Uint8Array(50_000).fill(7);
    const sent = await post("/api/messages", { platform: "whatsapp", person: "p", text: "", attachments: [{ kind: "document", mime: "application/pdf", name: "invoice.pdf", data: Buffer.from(bytes).toString("base64") }] });
    assert.equal(sent.status, 202);
    const [file] = fake.incomings[0].attachments ?? [];
    assert.deepEqual({ text: fake.incomings[0].text, kind: file.kind, mime: file.mime, name: file.name }, { text: "", kind: "document", mime: "application/pdf", name: "invoice.pdf" });
    assert.deepEqual(await file.data(), bytes);
    const [line] = await lines("whatsapp");
    assert.deepEqual(line.kind === "in" && line.attachments, [{ kind: "document", name: "invoice.pdf" }]);
  } finally {
    await server.close();
  }
});

test("a playground on a port already in use rejects with a message saying so, instead of crashing the process", async () => {
  const h = agentOn(sqlite());
  const taken = await simulators().listen(h.agent, 0);
  try {
    const port = Number(new URL(taken.url).port);
    await assert.rejects(simulators().listen(h.agent, port), { message: `Port ${port} is already in use (another playground?): stop it, or listen on another port.` });
  } finally {
    await taken.close();
  }
});

test("the playground shows the person's conversation from the agent's store, also after a restart", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "chinwag-play-")), "chinwag.db");
  const first = agentOn(sqlite(path));
  await first.agent.resume();
  const play = simulators();
  const server = await play.listen(first.agent, 0);
  const send = await fetch(`${server.url}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "whatsapp", person: SAM.phone, text: "a latte please" }),
  });
  assert.equal(send.status, 202);
  // This WhatsApp has no link button: the link's URL went after the text, and shows so again after a restart.
  const menu = { label: "Menu", url: "https://example.com/menu" };
  (await first.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Which size?", buttons: ["Small", "Large"] }), call("send_whatsapp", { text: "Our menu", link: menu })));
  const id = (await first.agent.testConversation(SAM.phone))!;
  await first.agent.conversation(id)!.whenIdle();
  await server.close();

  const again = agentOn(sqlite(path), first.dir);
  await again.agent.resume();
  const restarted = await simulators().listen(again.agent, 0);
  try {
    const { lines } = (await (await fetch(`${restarted.url}/api/transcript?channel=whatsapp&person=${encodeURIComponent(SAM.phone)}`)).json()) as { lines: Line[] };
    const said = lines.flatMap((l) => (l.kind === "in" || l.kind === "out" ? [[l.kind, l.text, l.kind === "out" ? l.buttons : undefined]] : []));
    assert.deepEqual(said, [["in", "a latte please", undefined], ["out", "Which size?", ["Small", "Large"]], ["out", "Our menu\nhttps://example.com/menu", undefined]]);
  } finally {
    await restarted.close();
  }
});

/** One request with headers fetch would not let a test set (Host), → status and body. */
function raw(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

test("the local playground runs turns only for its own page: another site and a rebound DNS name are refused", async () => {
  const h = agentOn(sqlite());
  await h.agent.resume();
  const server = await simulators().listen(h.agent, 0);
  const own = new URL(server.url).host;
  const where = `channel=whatsapp&person=${encodeURIComponent(SAM.phone)}`;
  const message = JSON.stringify({ channel: "whatsapp", person: SAM.phone, text: "a latte please" });
  const post = (headers: Record<string, string>) => raw(`${server.url}/api/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: message });
  try {
    assert.equal((await post({ "sec-fetch-site": "cross-site", origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ "sec-fetch-site": "same-site", origin: "http://localhost:3000" })).status, 403, "another port on this machine is another origin");
    assert.equal((await post({ origin: "https://evil.example" })).status, 403, "an older browser: the Origin alone");
    assert.equal((await raw(`${server.url}/api/poll?${where}&after=0`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403, "nor can it read the conversation");
    assert.equal((await post({ host: `evil.example:${new URL(server.url).port}`, "sec-fetch-site": "same-origin" })).status, 403, "a DNS name rebound to 127.0.0.1");
    assert.equal((await raw(`${server.url}/`, { headers: { host: "evil.example" } })).status, 403);
    assert.equal(h.calls.length, 0);

    const { seq } = JSON.parse((await raw(`${server.url}/api/transcript?${where}`, { headers: { "sec-fetch-site": "same-origin" } })).body);
    assert.equal((await post({ "sec-fetch-site": "same-origin", origin: server.url })).status, 202);
    (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Which size?" })));
    await h.agent.conversation((await h.agent.testConversation(SAM.phone))!)!.whenIdle();
    const polled = await raw(`${server.url}/api/poll?${where}&after=${seq}`, { headers: { host: own.replace("127.0.0.1", "localhost"), "sec-fetch-site": "same-origin" } });
    assert.equal(polled.status, 200, "the polling fallback, also on localhost");
    assert.ok((JSON.parse(polled.body).events as Array<{ line?: Line }>).some((e) => e.line?.kind === "out" && e.line.text === "Which size?"));
  } finally {
    await server.close();
  }
});

test("a page the live stream can't reach gets the same events by polling, each once and in order", async () => {
  const h = agentOn(sqlite());
  await h.agent.resume();
  const token = "t".repeat(40);
  const server = createServer(simulators().handler(h.agent, { token, base: "/play" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/play`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const where = `channel=whatsapp&person=${encodeURIComponent(SAM.phone)}`;
  type Event = { type: string; seq: number; line?: Line };
  type Polled = { seq: number; events: Event[] };
  const get = async (path: string, after?: number) => (await fetch(`${url}${path}?${where}${after === undefined ? "" : `&after=${after}`}`, { headers })).json();
  const send = async (text: string) =>
    assert.equal((await fetch(`${url}/api/messages`, { method: "POST", headers, body: JSON.stringify({ channel: "whatsapp", person: SAM.phone, text }) })).status, 202);
  const said = (events: Event[]) => events.flatMap((e) => (e.line && (e.line.kind === "in" || e.line.kind === "out") ? [e.line.text] : []));
  const idle = async () => h.agent.conversation((await h.agent.testConversation(SAM.phone))!)!.whenIdle();
  try {
    const { seq: start } = await get("/api/transcript");
    await send("a latte please");
    (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Which size?" })));
    await idle();

    const first = (await get("/api/poll", start)) as Polled;
    assert.deepEqual(said(first.events), ["a latte please", "Which size?"]);

    // Nothing newer yet: this poll waits, and answers with the next message only.
    const waiting = get("/api/poll", first.seq);
    await send("large");
    const second = (await waiting) as Polled;
    assert.deepEqual(said(second.events), ["large"]);
    assert.ok(second.events.every((e) => e.seq > first.seq));

    (await h.nextCall(1)).answer(respond(call("send_whatsapp", { text: "Coming up" })));
    await idle();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("WhatsApp shows a declared template as WhatsApp would, and one not declared by its name and values, also after a reload", async () => {
  const ready: TemplateDefinition = {
    name: "order_ready",
    language: "en",
    category: "utility",
    header: { kind: "text", text: "Order {{1}}" },
    body: "Hi {{1}}, your {{2}} is ready.",
    footer: "Reply STOP to opt out",
    buttons: [{ type: "quick_reply", text: "On my way" }, { type: "url", text: "Track", url: "https://example.com/o/{{1}}" }, { type: "phone", text: "Call us", phone: "+15555550100" }],
  };
  const h = multi({ channels: { whatsapp: { info: WHATSAPP, phone: true, kind: "whatsapp" } }, testPeople: [SAM], database: sqlite(), templates: [ready] });
  await h.agent.resume();
  const server = await simulators().listen(h.agent, 0);
  const where = `channel=whatsapp&person=${encodeURIComponent(SAM.phone)}`;
  const transcript = async () => (await (await fetch(`${server.url}/api/transcript?${where}`)).json()) as { seq: number; lines: Line[] };
  try {
    await fetch(`${server.url}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "whatsapp", person: SAM.phone, text: "hi" }) });
    (await h.nextCall(0)).answer(respond(call("send_whatsapp", { text: "Hi Sam!" })));
    await h.agent.conversation((await h.agent.testConversation(SAM.phone))!)!.whenIdle();
    const { seq } = await transcript();

    const to = { channel: "whatsapp", address: SAM.phone };
    await h.agent.nudge({ to, template: { name: "order_ready", header: { kind: "text", text: "1042" }, body: ["Sam", "latte"], buttons: [{ index: 0, value: "omw_1042" }, { index: 1, value: "1042" }] } });
    await h.agent.nudge({ to, template: { name: "loyalty", body: ["Sam", "120"] } });
    const polled = (await (await fetch(`${server.url}/api/poll?${where}&after=${seq}`)).json()) as { events: Array<{ line?: Line }> };
    const [declared, other] = polled.events.flatMap((e) => (e.line?.kind === "out" ? [e.line] : []));
    assert.deepEqual([declared.text, declared.template], [
      "Hi Sam, your latte is ready.",
      {
        name: "order_ready",
        header: { kind: "text", text: "Order 1042" },
        footer: "Reply STOP to opt out",
        buttons: [{ type: "quick_reply", text: "On my way", payload: "omw_1042" }, { type: "url", text: "Track", url: "https://example.com/o/1042" }, { type: "phone", text: "Call us", phone: "+15555550100" }],
      },
    ]);
    assert.deepEqual([other.text, other.template], ["Sam\n120", { name: "loyalty" }]);

    // From the store, after a reload: the body as it read, the rest as declared.
    const reloaded = (await transcript()).lines.flatMap((l) => (l.kind === "out" && l.template ? [[l.text, l.template.name, l.template.footer]] : []));
    assert.deepEqual(reloaded, [["Hi Sam, your latte is ready.", "order_ready", "Reply STOP to opt out"], ["", "loyalty", undefined]]);
  } finally {
    await server.close();
  }
});

test("the playground's Backend buttons run on the server behind its token, and their results reach the trace, polled too", async () => {
  const h = agentOn(sqlite());
  await h.agent.resume();
  const token = "t".repeat(40);
  const ran: string[] = [];
  const actions = [
    { label: "Order 1042 ships", run: async () => (ran.push("ships"), "sent") },
    { label: "Price drops", run: () => { throw new Error("skipped: quiet hours"); } },
  ];
  const server = createServer(simulators({ actions }).handler(h.agent, { token, base: "/play" }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/play`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const where = `channel=whatsapp&person=${encodeURIComponent(SAM.phone)}`;
  const press = (index: number, auth = headers) => fetch(`${url}/api/actions`, { method: "POST", headers: auth, body: JSON.stringify({ index }) });
  try {
    assert.deepEqual((await (await fetch(`${url}/api/platforms`, { headers })).json()).actions, ["Order 1042 ships", "Price drops"]);
    assert.equal((await press(0, { authorization: "Bearer wrong", "content-type": "application/json" })).status, 401);
    assert.deepEqual(ran, [], "nothing runs without the token");

    const { seq } = await (await fetch(`${url}/api/transcript?${where}`, { headers })).json();
    assert.deepEqual(await (await press(0)).json(), { ok: true, result: "sent" });
    assert.deepEqual(await (await press(1)).json(), { ok: false, error: "skipped: quiet hours" });
    assert.equal((await press(2)).status, 400);
    const polled = (await (await fetch(`${url}/api/poll?${where}&after=${seq}`, { headers })).json()) as { events: Array<Record<string, unknown>> };
    assert.deepEqual(polled.events.map(({ type, label, ok, result, error }) => ({ type, label, ok, result, error })), [
      { type: "action", label: "Order 1042 ships", ok: true, result: "sent", error: undefined },
      { type: "action", label: "Price drops", ok: false, result: undefined, error: "skipped: quiet hours" },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a turn's model error is printed on the terminal and reaches the playground's trace with its text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chinwag-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const play = simulators();
  // The model fails only once the message is taken, so the playground knows whose conversation it is.
  const asked = gate();
  const model: Model = { complete: async () => { await asked.promise; throw new Error("401 Incorrect API key"); } };
  const channels = [{ name: "whatsapp", kind: "custom" as const, info: WHATSAPP, phone: true, send: () => {} }];
  const agent = createAgent({ dir, model, debounceMs: 0, events: [play.events], channels, database: sqlite(), testPeople: [SAM], scheduleCheckMs: 0 });
  await agent.resume();
  const printed = gate<string>();
  const error = console.error;
  console.error = (...args: unknown[]) => { if (String(args[0]).includes("model error")) printed.open(args.map(String).join(" ")); };
  const server = await play.listen(agent, 0);
  const where = `channel=whatsapp&person=${encodeURIComponent(SAM.phone)}`;
  try {
    const { seq } = await (await fetch(`${server.url}/api/transcript?${where}`)).json();
    const sent = await fetch(`${server.url}/api/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "whatsapp", person: SAM.phone, text: "hi" }) });
    assert.equal(sent.status, 202);
    asked.open();
    assert.equal(await printed.promise, "chinwag: model error (Sam): Error: 401 Incorrect API key");
    await agent.conversation((await agent.testConversation(SAM.phone))!)!.whenIdle();
    const polled = (await (await fetch(`${server.url}/api/poll?${where}&after=${seq}`)).json()) as { events: Array<{ type: string; event?: { type: string; error?: string } }> };
    const traced = polled.events.flatMap((e) => (e.type === "trace" && e.event?.type === "model.error" ? [e.event.error] : []));
    assert.deepEqual(traced, ["Error: 401 Incorrect API key"]);
  } finally {
    console.error = error;
    await server.close();
  }
});
