---
name: parley
description: Build or change a chat agent on Parley (WhatsApp, SMS, iMessage, Telegram, web). Load when creating a Parley agent, editing its prompt or skills, wiring it into the playground, or when code imports parley. Also read tools-skill.md before writing tools and test-skill.md before writing tests, both in this folder.
---

# Building an agent on Parley

Parley runs chat agents that feel like a person texting back: it folds double texts into one
reply, acknowledges people fast, runs tools in parallel and waits for them, moving one to the
background only when the person writes again or it passes its limit.
You write the agent's prompt, skills and tools; Parley handles the conversation.

This folder has two more skills: read `tools-skill.md` before writing or changing a tool, and
`test-skill.md` before writing or changing a test.

## Layout

```
my-agent/
  agent/AGENTS.md              the agent's prompt (the model reads it every turn)
  agent/skills/<name>/SKILL.md skills the agent loads when it needs them
  src/tools.ts                 the agent's tools (see tools-skill.md)
  src/agent.ts                 buildAgent(): the one place the agent is built
  src/main.ts                  runs it in the playground
  tests/tools/*.yaml           how each tool behaves in tests (see tools-skill.md)
  tests/scenarios/*.yaml       the tests (see test-skill.md)
```

`agent/AGENTS.md` is the agent's prompt, not instructions for coding agents. Keep it short: what
the agent is for, what it may and may not do. Don't explain messaging in it: Parley adds how to
talk to the person (send_<channel>, react, acknowledging first, channel formatting) on its own.

A skill's `SKILL.md` starts with `name` and `description`; the agent sees every description and
loads the full skill only when it decides it needs it. Put rules for one kind of request in a
skill, not in AGENTS.md.

## buildAgent

Build the agent in one function that the playground and the tests both call, so they never
drift apart. Tests pass their own model, events and simulated tools:

```ts
import { fileURLToPath } from "node:url";
import { createAgent, openAICompatible, type EventSink, type Model, type Tool } from "parley";
import { tools as myTools } from "./tools.ts";

export const tools = myTools;

export function buildAgent(options: { model?: Model; events?: EventSink[]; tools?: Tool[] } = {}) {
  return createAgent({
    dir: fileURLToPath(new URL("../agent", import.meta.url)),
    model: options.model ?? openAICompatible({ model: "anthropic/claude-haiku-5.5" }),
    tools: options.tools ?? myTools,
    events: options.events ?? [],
  });
}
```

Other `createAgent` options: `context(conversationId)` adds who the person is and the time to
every turn (cheaper than a lookup tool); `intercept(conversationId, text)` answers a message
without the model (return the reply, `""` for silence, or `null` to let the agent answer);
`deadlineMs` (default 60,000) is the longest a reply waits for a tool before it moves to the
background (set a tool's own `deadlineMs` for a known-slow one); `partialAfterMs` (default 5,000)
is how long a finished tool's result waits for the others of its response; `shareUpdates` turns live status lines on web and app UIs off, or replaces their
guidance with a string.

Models are reached through any OpenAI-compatible API; `openAICompatible` defaults to OpenRouter
and reads `OPENROUTER_API_KEY`.

Which model: recommend Claude Haiku 5.5 (`anthropic/claude-haiku-5.5`, the default above) or OpenAI
GPT-6.1 Sol (`openai/gpt-6.1-sol`, about 3x the cost, the most exact). If the owner asks for Luna
(`~openai/gpt-luna-latest`, `openai/gpt-6-luna`), advise against it before using it: with tools
that run in the background it repeats tool calls, sends extra "on it" messages and answers twice,
where Haiku and Sol send one acknowledgement and one answer (measured on Parley's own checks, 12 Oct
2026). Use it only if they still want it.

## Channels, people and the database

In production, give the agent its channels once and hand it each incoming message. Each channel
is a definition in its own file; Parley knows the platform (WhatsApp's limits, SMS segments), your
provider only says how to send:

```ts
// src/channels/whatsapp.ts: one sendMessage, plus whatever else your provider can do
export const wa = whatsapp({
  sendMessage: (to, m) => api.send(to, m),        // m: { text, replyTo?, buttons?, list? }
  react: (to, id, emoji) => api.react(to, id, emoji),
  // no typing() or markRead(): those features are off, and the agent is never offered them
}, { disable: ["lists"] });

// src/channels/app.ts: your own web or mobile UI, with params of your own
export const app = customUI("app", {
  params: { app_link: z.string().describe("A link a tool result gave you; the app shows it as a button") },
  instructions: "Only fill app_link with a URL from a tool result in this conversation; never make one up.",
  sendMessage: (to, m) => myApp.push(to, m),      // m.text, m.app_link
});

createAgent({ ..., channels: [wa, sms(twilioLike), app], database: sqlite("data/parley.db"),
  resolve: ({ channel, address }) => members.idFor(channel, address), timeZone: "America/New_York" });
await agent.resume();                     // a durable database: always before the first message
await agent.message({ channel: "whatsapp", from: "+15550100100", message: "hi" });
```

- The simulators and the test cloud play an agent's own channels with these definitions (the web
  simulator plays a customUI), so the model sees the production tools; they show params such as
  app_link under the message instead of calling your sendMessage.
- `instructions` (on `customUI`, and in `whatsapp()`'s and `sms()`'s options) is your guidance for
  the agent on that channel, in its prompt only while the person uses it. Data a param carries,
  such as a link, comes from your tools' results: a tool that has a screen returns its link
  (`{ ..., app_link }`), and the agent only passes it on.
- One person is one conversation across every channel they use. Channels are joined only by what
  each verified: your `resolve` key, else the same phone number on channels marked `phone`. Never
  join people any other way.
- With several channels the agent gets a send tool per channel (`send_sms`, `send_web`) and
  answers each message where it came. Don't add your own.
- After a restart, `resume()` carries on: cut-off turns run again, background tools that were
  running are reported as interrupted (never rerun).
- `agent.receive(conversationId, message, deliver)` still works for one channel at a time (the
  playground uses it).

Built in, so don't build them as tools: scheduled messages (`schedule_message`, `list_scheduled`,
`cancel_scheduled`, in the person's local time), and what a person asked not to be messaged about
(`add_no_contact`, `remove_no_contact`).

Messages the business starts are nudges: `agent.nudge({ to: { channel, address }, text })` sends
as written; `prompt` instead lets the agent write it (or decide not to); `template` sends a
WhatsApp template you already set up. Pass `idempotencyKey` when your system may retry, and `at`
to send later. Outside WhatsApp's 24-hour window only templates go out (`outside_window`).

## The playground

`src/main.ts` serves the agent in the local simulators (SMS, WhatsApp, iMessage, Telegram, web),
each with that platform's real rules:

```ts
import { simulators } from "@parley/simulators";
import { buildAgent } from "./agent.ts";

const play = simulators({ title: "My agent" });
const agent = buildAgent({ events: [play.events] });
await play.listen(agent, 8788);
```

Open the printed link, pick a platform, and chat. The side panel shows how fast each message was
acknowledged and a trace of every model call and tool.

For an agent with several channels, `simulators({ shareConversations: true, cards: [...] })` and
`/person` show one person (a test number the browser remembers) on each of its channels side by
side, as one conversation. `cards` says how a custom UI shows a link in its params:
`{ match: "/video/", label: "Start video call", kind: "call" }`; any other link is "Open in app".
