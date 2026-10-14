// covers: src/channels.ts src/talk.ts src/conversation.ts src/agent.ts
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgent, customUI, sms, whatsapp, z, type Channel, type Outbound, type WhatsAppProvider } from "../src/index.ts";
import { call, last, respond, scriptedModel } from "./helpers.ts";

function agentWith(channels: Channel[]) {
  const dir = mkdtempSync(join(tmpdir(), "chinwag-"));
  writeFileSync(join(dir, "AGENTS.md"), "You are a test agent.");
  const scripted = scriptedModel();
  const agent = createAgent({ dir, model: scripted.model, debounceMs: 0, channels, scheduleCheckMs: 0 });
  return { agent, ...scripted };
}

const props = (tool: { parameters: unknown }) => Object.keys((tool.parameters as { properties: object }).properties);

/** A WhatsApp provider that records what Chinwag asked it to do. */
function recorder(extra: Partial<WhatsAppProvider> = {}) {
  const calls: unknown[][] = [];
  const provider: WhatsAppProvider = {
    sendMessage: async (to, message) => void calls.push(["sendMessage", to, message]),
    ...extra,
  };
  return { provider, calls };
}

test("WhatsApp offers the agent only what its provider can do; a link it cannot send goes as its URL in the text", async () => {
  const r = recorder({ features: { buttons: false, links: false } });
  const bare = agentWith([whatsapp(r.provider)]);
  const a = await bare.agent.message({ channel: "whatsapp", from: "+15550100100", message: "hi" });
  const first = await bare.nextCall(0);
  assert.deepEqual(props(first.request.tools.find((t) => t.name === "send_whatsapp")!), ["text", "reply_to", "list", "link", "image"]);
  assert.ok(!first.request.tools.some((t) => t.name === "react"), "no react method, no react tool");
  first.answer(respond(call("send_whatsapp", { text: "Here it is", link: { label: "Open in app", url: "https://example.com/l/7" } })));
  await bare.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(r.calls, [["sendMessage", "+15550100100", { text: "Here it is\nhttps://example.com/l/7" }]]);

  const full = recorder({ react: async () => {} });
  const switchedOff = agentWith([whatsapp(full.provider, { disable: ["reactions", "lists", "images"] })]);
  await switchedOff.agent.message({ channel: "whatsapp", from: "+15550100100", message: "hi" });
  const second = await switchedOff.nextCall(0);
  assert.deepEqual(props(second.request.tools.find((t) => t.name === "send_whatsapp")!), ["text", "reply_to", "buttons", "link"]);
  assert.ok(!second.request.tools.some((t) => t.name === "react"), "switched off though the provider has it");
});

test("one send call reaches the provider's sendMessage with everything; reactions, typing and reads go to theirs", async () => {
  const typing: boolean[] = [];
  const r = recorder({
    react: async (to, messageId, emoji) => void r.calls.push(["react", to, messageId, emoji]),
    typing: async (_to, on) => void typing.push(on),
    markRead: async (to, ids) => void r.calls.push(["markRead", to, ids]),
  });
  const h = agentWith([whatsapp(r.provider)]);
  const a = await h.agent.message({ channel: "whatsapp", from: "+15550100100", message: "which day works?" });
  const photo = { url: "https://example.com/flat.jpg" };
  (await h.nextCall(0)).answer(
    respond(
      call("react", { message_id: "m1", emoji: "👍" }),
      call("send_whatsapp", { text: "Pick one", buttons: ["Mon", "Tue"], reply_to: "m1", image: photo }),
      call("send_whatsapp", { text: "2 BHK, Indiranagar", image: photo, link: { label: "Open in app", url: "https://example.com/l/7" } }),
    ),
  );
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(r.calls, [
    ["markRead", "+15550100100", ["m1"]],
    ["react", "+15550100100", "m1", "👍"],
    ["sendMessage", "+15550100100", { text: "Pick one", replyTo: "m1", buttons: ["Mon", "Tue"], image: photo }],
    ["sendMessage", "+15550100100", { text: "2 BHK, Indiranagar", link: { label: "Open in app", url: "https://example.com/l/7" }, image: photo }],
  ]);
  assert.deepEqual(typing, [true, false]);
});

test("a custom UI's params are on its send tool only, checked, handed to its provider, and left out when empty", async () => {
  const sent: unknown[] = [];
  const app = customUI("app", {
    params: { app_link: z.object({ url: z.string(), screen: z.string().optional() }).describe("Pass a tool result's app_link here.") },
    sendMessage: async (_to, message) => void sent.push(message),
  });
  const h = agentWith([app]);
  const a = await h.agent.message({ channel: "app", from: "session-1", message: "show my progress" });
  const first = await h.nextCall(0);
  assert.ok(props(first.request.tools.find((t) => t.name === "send_app")!).includes("app_link"));
  first.answer(respond(call("send_app", { text: "Here it is.", app_link: { screen: "progress" } })));
  const second = await h.nextCall(1);
  assert.match(last(second.request.messages).content, /Not sent, fix and send again/, "app_link without its url goes back to the agent");
  second.answer(respond(call("send_app", { text: "Here it is.", app_link: { url: "https://app.example/progress", screen: "progress" } })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(sent, [{ text: "Here it is.", app_link: { url: "https://app.example/progress", screen: "progress" } }]);

  // A param the model filled with nothing ("" or null) is not sent at all.
  await h.agent.message({ channel: "app", from: "session-1", message: "thanks" });
  (await h.nextCall(2)).answer(respond(call("send_app", { text: "Anytime.", app_link: "" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();
  assert.deepEqual(sent.at(-1), { text: "Anytime." });
});

test("receive() with one of the agent's channel names plays that channel, delivering where it is told", async () => {
  const app = customUI("app", { params: { app_link: z.object({ url: z.string() }) }, sendMessage: async () => assert.fail("the simulator delivers, not the provider") });
  const h = agentWith([app]);
  const out: Outbound[] = [];
  h.agent.receive("sim:1", "show my progress", (o) => void out.push(o), { channelName: "app" });
  const first = await h.nextCall(0);
  assert.ok(props(first.request.tools.find((t) => t.name === "send_app")!).includes("app_link"));
  first.answer(respond(call("send_app", { text: "Here.", app_link: { url: "https://app.example/progress" } })));
  await h.agent.conversation("sim:1")!.whenIdle();
  assert.deepEqual(out.find((o) => o.type === "message"), { type: "message", text: "Here.", fields: { app_link: { url: "https://app.example/progress" } } });
  assert.deepEqual(h.agent.channels(), [{ name: "app", kind: "custom", info: { formatting: "markdown", reactions: false, status: false, readReceipts: false } }]);
});

test("a channel's own instructions are in the prompt only while the person uses that channel", async () => {
  const rule = "Only fill app_link with a URL from a tool result.";
  const app = customUI("app", { params: { app_link: z.object({ url: z.string() }) }, instructions: rule, sendMessage: async () => {} });
  const h = agentWith([sms({ sendMessage: async () => {} }), app]);
  const a = await h.agent.message({ channel: "sms", from: "+15550100100", message: "hi" });
  const first = await h.nextCall(0);
  assert.doesNotMatch(first.request.system, /Only fill app_link/);
  first.answer(respond(call("send_sms", { text: "Hi!" })));
  await h.agent.conversation(a!.conversationId)!.whenIdle();

  // Someone else, on the app.
  const b = await h.agent.message({ channel: "app", from: "session-1", message: "show my progress" });
  const second = await h.nextCall(1);
  assert.ok(second.request.system.includes(`- ${rule}`));
  second.answer(respond(call("send_app", { text: "Here." })));
  await h.agent.conversation(b!.conversationId)!.whenIdle();
});
