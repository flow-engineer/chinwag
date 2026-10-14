---
name: chinwag
description: Build or change a chat agent on Chinwag (WhatsApp, SMS, iMessage, Telegram, web). Load when creating a Chinwag agent, editing its prompt or skills, wiring it into the playground, or when code imports chinwag. Also load the chinwag-tools skill (tools-skill.md) before writing tools and chinwag-tests (test-skill.md) before writing tests.
---

# Building an agent on Chinwag

Chinwag runs chat agents that feel like a person texting back: it folds double texts into one
reply, acknowledges people fast, runs tools in parallel and waits for them, moving one to the
background only when the person writes again or it passes its limit.
You write the agent's prompt, skills and tools; Chinwag handles the conversation.

Two more skills go with this one: `chinwag-tools` (`tools-skill.md`) before writing or changing a
tool, and `chinwag-tests` (`test-skill.md`) before writing or changing a test.

## Start a new agent

`npx chinwag new <name>` (lowercase letters, digits and dashes) makes `./<name>/` from the café
example: a complete agent with tools and tests that depends on the `chinwag` package and imports
`chinwag` and `chinwag/simulators`, with these skills in `.claude/skills/`. Run `npm install` there.
Build in it, changing Pip's prompt, skills, tools and tests into yours. The owner copies
`.env.example` to `.env` and puts `OPENROUTER_API_KEY` in it (never read or print it), then
`npm start` opens the playground; `npm run typecheck` checks the types.

Inside a clone of Chinwag itself, `npm run new -- <name>` copies the café to `agents/<name>/`
instead (git-ignored, so it never collides with a pull). Its imports of `../../../src/` and
`../../../simulators/src/` stay as they are, so changes to Chinwag show at once; the key goes in
`agents/<name>/.env`. The snippets below import `chinwag` and `chinwag/simulators`; in a clone's
agent, keep its relative imports.

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
the agent is for, what it may and may not do. Don't explain messaging in it: Chinwag adds how to
talk to the person (send_<channel>, react, acknowledging first, channel formatting) on its own.

A skill's `SKILL.md` starts with `name` and `description`; the agent sees every description and
loads the full skill only when it decides it needs it. Put rules for one kind of request in a
skill, not in AGENTS.md.

## buildAgent

Build the agent in one function that the playground and the tests both call, so they never
drift apart. Tests pass their own model, events and simulated tools:

```ts
import { fileURLToPath } from "node:url";
import { createAgent, openAICompatible, type EventSink, type Model, type Tool } from "chinwag";
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

Other `createAgent` options: `files` replaces `dir` on hosts with no file system (the folder's
text by path: `{ "AGENTS.md": ..., "skills/<name>/SKILL.md": ... }`); `context(conversationId)` adds who the person is and the time to
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
where Haiku and Sol send one acknowledgement and one answer (measured on Chinwag's own checks, 12 Oct
2026). Use it only if they still want it.

## Channels, people and the database

In production, give the agent its channels once and hand it each incoming message. Each channel
is a definition in its own file; Chinwag knows the platform (WhatsApp's limits, SMS segments), your
provider only says how to send:

```ts
// src/channels/whatsapp.ts: one sendMessage, plus whatever else your provider can do
export const wa = whatsapp({
  sendMessage: (to, m) => api.send(to, m),        // m: { text, replyTo?, buttons?, list?, link?, image? }
  react: (to, id, emoji) => api.react(to, id, emoji),
  // no typing() or markRead(): those features are off, and the agent is never offered them
}, { disable: ["lists"] });

// src/channels/app.ts: your own web or mobile UI, with params of your own
export const app = customUI("app", {
  params: { app_link: z.string().describe("A link a tool result gave you; the app shows it as a button") },
  instructions: "Only fill app_link with a URL from a tool result in this conversation; never make one up.",
  sendMessage: (to, m) => myApp.push(to, m),      // m.text, m.app_link
});

createAgent({ ..., channels: [wa, sms(twilioLike), app], database: sqlite("data/chinwag.db"),
  resolve: ({ channel, address }) => members.idFor(channel, address), timeZone: "America/New_York" });
await agent.resume();                     // a durable database: always before the first message
await agent.message({ channel: "whatsapp", from: "+15550100100", message: "hi" });
```

- Several processes or machines need Postgres, not a SQLite file: `database: postgres(pool)`
  with the app's own node-postgres `Pool` (Chinwag adds no Postgres dependency). An agent that must
  not hold database credentials gets `store` instead of `database`: any object with Store's
  methods (`StoreApi`), such as a client that forwards each call to a service running `new
  Store(postgres(pool), agentId)`.
- Every send tool can carry a `link` ({ label, url }, https): a URL button where the channel has
  one (`linkButton`, WhatsApp's cta_url), else Chinwag puts the URL on a line after the text. Channels
  with `images` also offer an `image` ({ url }, https), the text its caption; elsewhere the text
  goes alone. WhatsApp's rules hold everywhere: a link never with buttons or a list, an image never
  with a list. A provider without them says so (`features: { links: false, images: false }`) and
  never gets them; the URLs come from your tools' results, like app_link's.
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
  test cloud uses it).
- Photos, voice notes and documents: hand them in on the message, `message: { text: caption, attachments: [{ kind: "image" | "audio" | "document", mime, name?, data: () => provider.download(id) }] }`.
  `data` is a loader your provider fetches with its own credentials; never put a media URL where
  the model sees it. Photos (JPEG, PNG, WebP, GIF, up to 5 MB) and PDFs (up to 10 MB) go to the
  model when it reads them (`openAICompatible({ images, pdfs })`: images default on, PDFs on with
  OpenRouter; set `images: false` for a text-only model). Voice notes need
  `createAgent({ transcribe: async ({ mime, data }) => text })` with the speech-to-text the owner
  picks; Chinwag has none. Anything the agent can't read reaches it named, with why, so it asks
  for text. The latest 3 photos and PDFs stay shown; their bytes are never stored.

Built in, so don't build them as tools: scheduled messages (`schedule_message`, `list_scheduled`,
`cancel_scheduled`, in the person's local time), and what a person asked not to be messaged about
(`add_no_contact`, `remove_no_contact`).

Messages the business starts are nudges: `agent.nudge({ to: { channel, address }, text })` sends
as written; `prompt` instead lets the agent write it (or decide not to); `template` sends a
WhatsApp template you already set up. Pass `idempotencyKey` when your system may retry, and `at`
to send later. Outside WhatsApp's 24-hour window only templates go out (`outside_window`).

## The playground

Every agent ships a test playground: people test it as real users before its numbers are live.
Declare who may be played in `createAgent({ testPeople: [{ name: "Maria", phone: "+15555550101" }] })`;
no one else can be. A test person is a real person to the agent: the same identity, `resolve`,
`intercept`, history and schedules as when that number writes through a provider (the playground
is just another phone; they may be test members in your real backend). On phone channels their
address is the number; on others `test:<number>`, joined to the same person. One person is one
conversation across every channel: switch channels and the chat resumes. A listed number may also
write from a real provider once a channel is live; replies, scheduled messages and nudges go back
wherever that person last wrote from on that channel.

`src/main.ts` serves it with the simulators (SMS, WhatsApp, and the web simulator for a custom UI),
each with that platform's real rules, on the agent's own `channels` (declare them, with a provider
that is not connected yet if the numbers are not ready: test people never reach it):

```ts
import { simulators } from "chinwag/simulators";
import { buildAgent } from "./agent.ts";

const play = simulators({ title: "My agent" });
const agent = buildAgent({ events: [play.events] });
await play.listen(agent, 8788);           // 127.0.0.1 only; no token needed there
```

Open the printed link, pick a test person and a channel, and chat; `/person` shows every channel
side by side. The page shows the person's conversation from the agent's store, so it survives
restarts (with a durable `database`), and Clear history forgets the person entirely
(`agent.forgetPerson(conversationId)`: history, schedules, everything). The side panel shows how
fast each message was acknowledged and a trace of every model call and tool. `cards` says how a
custom UI shows a link in its params: `{ match: "/video/", label: "Start video call", kind: "call" }`;
any other link is "Open in app".

On a deployed agent, mount it in your own server with a token of at least 32 characters, from a
secret: `const playground = play.handler(agent, { token: process.env.PLAYGROUND_TOKEN!, base: "/playground" })`,
and hand it the requests under `/playground` (`if (url.pathname.startsWith("/playground")) return playground(req, res)`).
Open `/playground/?token=...` once (it becomes an HttpOnly cookie and leaves the URL) or call the API
with `Authorization: Bearer <token>`. Wrong tokens are limited per address, and every simulated
message is logged with the person, channel, time and address.

## Send traces to a dashboard

Every turn can go to a traces endpoint (OTLP/JSON, posted to `<url>/v1/traces`) as a trace, so
playground and real chats show up in your dashboard and can be graded. No code: set these in the
agent's environment (the key and the URL come from your traces endpoint):

```sh
CHINWAG_TRACES_KEY=...
CHINWAG_TRACES_URL=https://...   # your traces endpoint's URL; required with the key
CHINWAG_TRACES_CONTENT=1         # send what was written; without it, metadata only
```

A key without a URL stops the agent at startup. Without `CHINWAG_TRACES_CONTENT=1` the dashboard
gets ids, timing, model calls and tool names but no messages, so nothing to show or grade. Or in
code: `createAgent({ ..., traces: { url, key, content: true, version: "v3" } })`. Traces are sent in the
background after each turn and a failed send is dropped (logged once), so a dashboard outage never
touches a chat; call `await agent.flushTraces()` before the process exits. Tests run under
`node --test` never send from the environment.
