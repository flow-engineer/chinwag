# Chinwag

**Chat agents that feel like a person texting back**, on WhatsApp, SMS, iMessage, Telegram and your own app.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/flow-engineer/chinwag/blob/main/LICENSE) ![Node 22.18+](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen.svg) ![TypeScript](https://img.shields.io/badge/TypeScript-yes-3178c6.svg)

![Pip, the café example, in the WhatsApp simulator: a double text folded into one reply, a menu lookup, and the order with reply buttons](https://raw.githubusercontent.com/flow-engineer/chinwag/main/docs/playground.png)

## Why

Agent SDKs are built for agents that work alone on long tasks. Put one in a chat and it shows:

- Someone sends "hi", then "I need to move my booking", and gets two replies, the first already wrong.
- A tool is slow and the chat goes silent for forty seconds.
- They text on SMS, then WhatsApp, and the agent has never met them.
- "Remind me at 9 tomorrow" never arrives, because the agent has no clock.

Chinwag makes the chat behaviour the default. You write the agent's prompt, skills and tools; Chinwag handles the conversation.

![What Chinwag handles: double texts, fast acknowledgements, tools that never stall the chat, one person across channels, each platform's rules, restarts, reminders, nudges, skills on demand, and a playground](https://raw.githubusercontent.com/flow-engineer/chinwag/main/docs/features.svg)

## Quick start

Node 22.18 or later. Your agent is TypeScript that Node runs as it is, with no build step.

```bash
npx chinwag new my-agent && cd my-agent && npm install
cp .env.example .env        # then put one model key in it; the file says where to make one
npm start
```

`chinwag new <name>` makes `./<name>/` from the café example (lowercase letters, digits and dashes). Open the link `npm start` prints and text Pip, a café ordering assistant: your starting point. Pick a platform at the top (SMS, WhatsApp, iMessage, Telegram, web), and turn on **Debug** to see every tool call and how fast each message was answered. A model call that fails (a wrong or expired key, say) shows in the chat, in Debug and on the terminal. The café's `src/agent.ts` reads its model id from `CAFE_MODEL` (default: the model for the key you set, see [Models](#models)). The new folder has the coding-agent skills in `.claude/skills/` and an `AGENTS.md` pointing at them, so you can tell Claude Code, Codex or any coding agent what to build.

### In a folder of your own

```bash
npm init -y && npm pkg set type=module && npm i chinwag
```

`src/main.ts`:

```ts
import { createAgent, openAICompatible, sms, whatsapp } from "chinwag";
import { simulators } from "chinwag/simulators";

// No provider connected yet: only the playground's test people reach the agent.
const notConnected = async () => {
  throw new Error("not connected yet");
};

const play = simulators({ title: "Ada" });
const agent = createAgent({
  files: { "AGENTS.md": "# Ada\n\nYou take table bookings for Luigi's, a small restaurant. Be brief and warm." },
  model: openAICompatible({ model: "anthropic/claude-haiku-5.5" }),
  channels: [whatsapp({ sendMessage: notConnected }), sms({ sendMessage: notConnected })],
  testPeople: [{ name: "Sam", phone: "+15555550102" }],
  events: [play.events],
});
const { url } = await play.listen(agent, 8788);
console.log(`Playground: ${url}/`);
```

```bash
echo "OPENROUTER_API_KEY=sk-or-..." > .env
node --env-file=.env src/main.ts
```

Tests run with `npx chinwag test` (see [Testing](#testing)); `npx chinwag --help` lists everything the command does.

## How a turn works

![One turn: two quick messages fold into one turn, an acknowledgement goes out with the tool call, the tool runs, one answer follows; if they write again while a tool runs, the tool moves to the background and its result comes back later](https://raw.githubusercontent.com/flow-engineer/chinwag/main/docs/turn.svg)

| When | Chinwag does |
|---|---|
| They send several messages in a row | Folds them into one turn; a model step in flight restarts with all of them |
| They write | Shows typing at once; the first thing they get is an answer, or an acknowledgement sent with the tool calls |
| The agent calls tools | Runs them in parallel and waits for them, so they get one answer, not an "on it" and a result later |
| They write again while a tool runs | The agent reads it at once; the tool carries on in the background and its result comes back into the chat |
| A tool passes its limit (`deadlineMs`, 60 s by default) | It moves to the background the same way |
| The model writes text without sending it | It is reminded once to send it; text it already sent is not repeated |

## Build an agent

An agent is a prompt, a few skills and plain functions, so a coding agent can build and change one end to end. This is what `chinwag new` makes:

```
my-agent/
  agent/AGENTS.md                the agent's prompt
  agent/skills/<name>/SKILL.md   rules for one kind of request, loaded only when needed
  src/tools.ts                   tools: plain functions with a zod input
  src/agent.ts                   buildAgent(): the one place the agent is built
  src/main.ts                    runs it in the playground
  tests/scenarios/*.yaml         tests: one situation each
  tests/tools/*.yaml             how each tool behaves in tests
```

**Tools** are functions with a zod input. Return anything; it is shown to the model as JSON.

```ts
import { tool, z } from "chinwag";

export const tools = [
  tool({
    name: "get_menu",
    description: "The full menu: items, sizes with prices, milk options and allergens.",
    input: z.object({}),
    run: async () => ({ menu: await pos.menu() }),
  }),
];
```

**The agent** is built in one function, which the playground and the tests both call:

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

**The playground** serves it in every simulator:

```ts
import { simulators } from "chinwag/simulators";
import { buildAgent } from "./agent.ts";

const play = simulators({ title: "My agent" });
await play.listen(buildAgent({ events: [play.events] }), 8788);
```

The playground plays only the test people you declare (`testPeople: [{ name, phone }]`) on the agent's own channels. A test person is a real person to the agent: the same identity, `resolve` and history as if they wrote from their phone, one conversation on every channel, and "Clear history" to start again. Replies go back where the person last wrote from, the playground or the real channel. `simulators({ actions: [{ label, run }] })` adds a Backend panel: each button runs your function on the server (an order ships, a price drops) and its result shows in the trace, so a demo shows the agent reacting to your backend. Locally it answers only on localhost, and its API only its own page, so a site you visit cannot send it messages. On a deployed agent, mount `play.handler(agent, { token })`: it refuses requests without the token (at least 32 characters), swaps `?token=` for a cookie on the playground's path, and limits wrong tries.

`AGENTS.md` says what the agent is for and what it may and may not do. Leave messaging out of it: Chinwag adds how to talk on each channel (its send tool, reactions, formatting, acknowledging first). A skill's `SKILL.md` starts with a `name` and `description`; the agent sees every description and loads a skill when it needs it (`inlineSkills: true` puts them all in the prompt instead).

## Channels and people

![One person: SMS and WhatsApp from the same number, and a signed-in app session, all lead to one conversation; each reply goes out on the channel the message came in on](https://raw.githubusercontent.com/flow-engineer/chinwag/main/docs/one-person.svg)

A channel is a definition: Chinwag knows the platform's rules, your provider only says how to send.

```ts
const wa = whatsapp({
  sendMessage: (to, m) => api.send(to, m),            // m: { text, replyTo?, buttons?, list?, link?, image? }
  react: (to, id, emoji) => api.react(to, id, emoji),
});
const text = sms({ sendMessage: (to, m) => smsApi.send(to, m.text) });
const app = customUI("app", {
  params: { app_link: z.string().describe("A link a tool result gave you") },
  instructions: "Only fill app_link with a URL from a tool result; never make one up.",
  sendMessage: (to, m) => myApp.push(to, m),          // m.text, m.app_link
});

const agent = createAgent({
  dir, model, tools,
  channels: [wa, text, app],
  database: sqlite("data/agent.db"),
  resolve: ({ channel, address }) => members.idFor(channel, address),
  timeZone: "America/New_York",
});
await agent.resume();
await agent.message({ channel: "whatsapp", from: "+15550100100", message: "hi" });
```

- **Each platform's rules are built in:** WhatsApp buttons, lists, replies, reactions and its 24-hour window; SMS as plain text in segments; your app's own fields. Features your provider lacks are never offered to the model.
- **One person, one conversation.** The same number on SMS and WhatsApp is one person, however each provider writes it (`+1 555 010 0100`, `15550100100`: both are `+15550100100`), also when their first messages on both arrive at once. If your SMS provider gives national numbers (`098765 43210`), set `createAgent({ defaultCountryCode: "+91" })`: on every phone channel but WhatsApp, a number with no `+` or `00` is then read as that country's (its trunk 0 dropped), so it joins `919876543210` on WhatsApp; without it, bare digits are taken as international. Anything else (your app, your website) is joined only by your `resolve`. Chinwag never guesses.
- **The agent gets one send tool per channel** (`send_sms`, `send_whatsapp`, `send_app`) and answers each message where it came in. `instructions` guide the agent on that channel only.

## Reminders and nudges

Built in, so you don't write them as tools:

- **Scheduled messages.** People ask ("remind me at 9 tomorrow"); the agent schedules, lists and cancels them in the person's own time zone. When one is due, the agent writes it in the context of the chat.
- **No-contact rules.** "No promotions", "nothing before 9am": the agent keeps them per person, and they apply on every channel to everything the business starts, sent now or scheduled.
- **STOP, START and HELP.** On SMS (STOP; START; HELP, INFO) and WhatsApp (STOP, UNSUBSCRIBE; START), a message that is only the keyword is answered with no model call. STOP keeps a hard rule: no nudge, scheduled message or reminder goes to that person, on any channel, until they text START; the agent still answers when they write, and cannot lift it. Set the replies, or other words, with `sms(provider, { keywords: { replies: { stop, start, help } } })` (`keywords: false` turns them off); without a `help` reply the agent answers HELP. A reply left out sends nothing, for providers that send their own. Which words carriers or regulators expect differs by country (some US carrier rules expect STOPALL, UNSUBSCRIBE, CANCEL, END and QUIT too), so check your market's rules; Chinwag's default on SMS is STOP only. For the fuller list, `sms(provider, { keywords: US_CARRIER_KEYWORDS })` (with your replies: `{ ...US_CARRIER_KEYWORDS, replies }`), or name your own words: `keywords: { stop: ["STOP", "ARRET"] }`.

  Your `intercept` sees these words first, with `message.keyword` set to `"stop"`, `"start"` or `"help"` (`null` for any other message), so an agent that keeps its own opt-out state can update it. `message.channel` is the channel every message came in on, by its name in `channels`. Chinwag keeps or lifts the STOP whatever the hook returns, and also when it throws; a reply the hook returns goes instead of Chinwag's, never both. An agent that keeps its own opt-out for texts only:

  ```ts
  const optedOutOfSms = new Set<string>();
  createAgent({
    // ...
    intercept: (conversationId, text, message) => {
      if (message.channel !== "sms") return null; // a STOP on WhatsApp is Chinwag's alone
      if (message.keyword === "stop") optedOutOfSms.add(conversationId);
      if (message.keyword === "start") optedOutOfSms.delete(conversationId);
      return null; // Chinwag's own reply goes
    },
  });
  ```
- **Nudges, messages your business starts:**

```ts
await agent.nudge({ to: { channel: "whatsapp", address: "+15550100100" }, prompt: "Their order is ready for pickup." });
```

`text` sends it as written, `prompt` lets the agent write it (or decide not to), `template` sends a WhatsApp template with its header, body and button values (`{ name, header?, body?: [...], buttons?: [{ index, value }] }`; a declared one sent with the wrong values throws before it goes). `at` sends it later, and `idempotencyKey` makes a retry safe: the same key sends once, also from two calls at once, and every call gets the first one's result. A nudge a no-contact rule covers, or to someone who texted STOP, is dropped, and outside WhatsApp's 24-hour window only templates go out. `nudge()` always settles, with `status` `sent`, `silent`, `dropped`, `refused`, `failed` or `scheduled` and a `reason`: when the model fails during a nudge, it is `failed`, and the person is sent nothing (only someone who wrote is told something went wrong).

## State, restarts and hosting

- Everything is stored as it happens: history, messages not yet handled, background tools, schedules. SQLite is built in (`sqlite("file.db")`; in memory by default). Postgres: `postgres(pool)` over your own node-postgres pool. Any other engine: implement the three-method `Database` interface, or pass a whole `store` of your own.
- After a restart, `await agent.resume()` carries on: cut-off turns run again, and background tools that were running are reported as interrupted, never silently rerun. A tool's `context.idempotencyKey` is the same when the agent calls it again with the same input in that turn, so your backend can do it once; `context.callId` and `context.signal` (aborted when the person is forgotten) are there too.
- Pass the provider's own id as `messageId` to `agent.message()`: a webhook the provider sends again is taken once. Ids are kept 7 days (`keepMessageIdsDays`); once an hour one runner deletes older ones, a batch at a time, on the scheduled messages' timer.
- `agent.status()` says whether anything is running and for how long it has been idle, so your platform can stop idle agents and start them on the next message.
- Every message, turn, model call (tokens and cost), tool and schedule is an event. Send events wherever you like; `jsonlSink(path)` writes them to a file. An `EventSink` is a function that gets each event (`{ type, conversationId, at, ... }`) and must not throw:

  ```ts
  const log: EventSink = (event) => console.log(event.type, event.conversationId);
  createAgent({ /* ... */ events: [log] });
  ```
- Traces: with `CHINWAG_TRACES_KEY` set, every turn is posted as an OTLP/JSON trace to `<url>/v1/traces`, where the URL is `CHINWAG_TRACES_URL`, else https://flow.engineer/observe (the trace key is made there). `CHINWAG_TRACES_CONTENT=1` adds what was written; without it, metadata only. Under `chinwag test` every trace is marked as a test's (`chinwag.run_kind` "test" and the session as `chinwag.test.session`; otherwise `chinwag.run_kind` is "production"), so the dashboard can keep tests apart from real conversations.

## Testing

Write tests as situations, not scripts. A model plays the person, another plays your tools from the scenario's world, and a judge grades the run.

```yaml
id: latte-correction
channels: [whatsapp]
person:
  persona: Sam, in a hurry; types in short bursts.
  goal: Get a large oat latte for pickup, under the name Sam.
opening:
  - say: "can i get a large latte"
  - say: "oat milk actually"
    after_ms: 1200
world: The point of sale is slow this morning, but orders go through.
expect:
  outcome:
    - Exactly one order is placed, for one large latte with oat milk.
  judge:
    - The agent asks Sam to confirm before placing the order.
```

`expect.calls` and `expect.never` name tools that must or must not be called, checked by code from the recorded calls. `now` and `timezone` set the test's clock, and dates in test files are written against it (`{{now + 1d | date}}`), so they never go stale ([coding-agents/test-skill.md](coding-agents/test-skill.md)). `tests/tools/*.yaml` describe how each tool behaves (normal, slow, each error). Run the suite from the agent's folder:

```bash
npx chinwag test --cloud https://flow.engineer/observe --synthetic --runs 3 --only latte-correction
```

Your agent stays on your machine with its own model and key; the test cloud ([get one](#get-a-test-cloud)) plays the person and the tools and judges each run. The cloud is a hosted service, not part of this package. The command prints pass or fail per run, with the judge's reasons, the cost, and a link to watch each conversation. Before anything is sent it reads every test file as the cloud does, and a mistake stops it with the file and line (`tests/scenarios/latte-correction.yaml:3: person.goal: missing`).

Exit status:

| Exit | Meaning |
|---|---|
| 0 | Every run passed. |
| 1 | A run failed. Or nothing was sent: a wrong flag, a test file that does not parse, no `CHINWAG_CLOUD_KEY`; the message is printed on its own. |
| 2 | The connection, the tunnel or the stream failed (before or after the session opened), the cloud answered 5xx or no JSON, the cloud ended the session for its own failure, or runs errored (the cloud could not play or judge them) and none failed. |
| 3 | The cloud refused: the open (a bad or wrong key, 401/403; an invalid request, 400; busy, 429 `rate_limited`; the spend cap, 429 `spend_cap`; 503 `capacity`), or it ended the session for the spend cap or capacity. |
| 130 | Interrupted (Ctrl-C). |

A busy cloud's refused open (429 other than the spend cap, or 503 `capacity`) with a Retry-After of 60 s or less is sent once more after it, with one line saying so; the spend cap never is. On a cloud that resumes, a dropped stream is opened again for up to 2 minutes, picking up after the last command. On a cloud that can re-open, a session the cloud lost is opened once more for only the runs with no result (the log names them, since they are played and paid for again), and the report covers both sessions with both dashboard links. If the tunnel, the stream, or the connection fails after the session has opened, it exits 2: the runs that had already finished are printed, then `N of M runs finished before: <reason>`, then the dashboard link. Ctrl-C prints that same partial report, says the cloud keeps playing until it is stopped from the dashboard, and exits 130.

Each run's line carries its id (`FAIL  latte-correction #1 (whatsapp) trn_…: 6 turns, …`). `--dotenv <path>` reads the environment from that file instead of the folder's `.env` (variables already set still win; no value is printed), and `--verbose` also prints slow event uploads.

`--json` prints one JSON document on stdout when the command ends, on every exit once its flags are read; every other line goes to stderr:

```json
{
  "version": 1, "outcome": "failed", "exitCode": 1,
  "sessionId": "tse_…", "agent": "agt_…", "dashboard": "https://…", "suiteHash": "…",
  "error": null,
  "counts": { "runs": 2, "passed": 1, "failed": 1, "errored": 0, "notPlayed": 0 },
  "costUsd": { "agent": 0.0123, "test": 0.0456 },
  "runs": [
    { "runId": "trn_…", "scenario": "latte-correction", "channel": "whatsapp", "run": 1, "verdict": "failed",
      "error": null, "ended": "goal_met", "turns": 6, "watch": "https://…",
      "failedChecks": [{ "kind": "judge", "text": "The agent asks Sam to confirm before placing the order.", "reason": "…" }] }
  ]
}
```

`outcome` is `passed` (exit 0), `failed` or `invalid` (1), `errored` or `transport` (2), `refused` (3) or `interrupted` (130). A run's `verdict` is `errored` whenever the cloud names an `error` for it (such as `judge_failed`, `simulator_failed` or `spend_cap`), whatever it `ended` as: the cloud could not play or judge it, so it says nothing about the agent. Its line reads `ERROR` instead of `PASS` or `FAIL`, and the run's `error` is that code (else `null`). `error` is `{ "message", "status", "type", "retryAfterSeconds" }` when the session did not finish (`type` is the cloud's code, such as `spend_cap`; the others are `null` when it did not say).

`--only latte-correction,order-fails` runs only those scenarios (file names without `.yaml`); every tool file still goes. Once the session has opened, every exit (0, 1, 2, 3 or 130) writes `.chinwag/last-session.json` in the agent's folder and prints its path; `chinwag new` git-ignores `.chinwag/`. It holds what each run ended as and the judge's reasons, never the messages (a reason can quote one, which is why the file stays on your machine; the suite is synthetic by `--synthetic`):

```json
{
  "sessionId": "…", "agent": "agt_…", "dashboard": "https://…", "suiteHash": "…", "endedAt": "2026-10-16T09:12:03.000Z",
  "ended": "finished",
  "only": null,
  "runs": [
    { "scenario": "latte-correction", "channel": "whatsapp", "run": 1, "runId": "trn_…", "verdict": "failed",
      "failedChecks": [{ "kind": "judge", "text": "The agent asks Sam to confirm before placing the order.", "reason": "…" }] }
  ]
}
```

`ended` is `finished`, `stopped` (the session broke off or the cloud stopped it) or `interrupted`. `agent` is the cloud's id for the agent (a hosted cloud names it), which `chinwag show` reads. `only` is the scenarios the session was limited to, `null` for the whole suite. `verdict` is `passed`, `failed`, `errored` (the cloud could not play or judge the run) or `not_played` (the session ended first; its `runId` is `null`).

`chinwag show <run-id>` prints one run's record from the cloud, read with `CHINWAG_CLOUD_KEY`: the verdict, every check with the judge's reason, then the conversation in time order with each tool call the simulator played (its input, output and what it changed). `chinwag show last` picks the first run in `.chinwag/last-session.json` that did not pass (its first run when all passed) and names the others. `--json` prints the record exactly as the cloud answered it. It exits 0 when it printed; 1 for a wrong flag, no key or last session, no such run (404) or one past the 30 days runs are kept (410); 2 when the cloud did not answer or answered 5xx; 3 when it refused the key (401, 403) or is busy (429).

`--failed` runs again only the scenarios that did not pass in that file (failed, errored or not played), on every channel each plays: a scenario's channels are part of its file, so one channel cannot be picked alone. It goes with `--runs`; with `--only` it stops and says to pick one, since the two would each pick the scenarios. With nothing to run again it prints `Nothing failed in the last session (<id>).` and exits 0 (and says when that session ran only some scenarios); with no file it says to run `chinwag test` first and exits 1. The loop, for you or a coding agent:

```bash
npx chinwag test --synthetic            # the whole suite
# fix what failed
npx chinwag show last                   # why: the judge's reasons, the conversation and the tool calls
npx chinwag test --synthetic --failed   # only what did not pass; again until it exits 0
npx chinwag test --synthetic            # the whole suite once more before you finish
```

### Get a test cloud

1. Sign in at https://flow.engineer/observe (Google, GitHub or an email link).
2. Workspace → New agent.
3. On the agent's Developers page, "Make a CI key". It starts with `oci_` and is shown once.
4. Put it in the agent's `.env` as `CHINWAG_CLOUD_KEY` (never on the command line).
5. `npx chinwag test --cloud https://flow.engineer/observe --synthetic` from the agent's folder (`--cloud` is that address by default).

Your agent runs on your machine with your own model key. The cloud's person simulator, tool simulator and judge are free up to $5 a day per workspace, with 2 sessions at once; test data only (`--synthetic`), and records are deleted after 30 days.

`--cloud` (or `CHINWAG_CLOUD`) points at another test cloud. A hosted cloud takes its key in `CHINWAG_CLOUD_KEY` and `--synthetic`, your attestation that the test files hold no real customer data; without the key the command stops and says where to make one.

### Test an agent you already have

An agent built on any framework is tested through an HTTP endpoint, with no rewrite. It needs a test cloud like any run (see [Get a test cloud](#get-a-test-cloud)): `CHINWAG_CLOUD_KEY` and `--synthetic` for the hosted one, the default, or `--cloud` for another. From a folder with `tests/scenarios/*.yaml`, with your agent running:

```bash
npx chinwag test --agent-url http://localhost:3000/chinwag --cloud https://flow.engineer/observe --synthetic
```

Before the session opens, the command sends one `HEAD` request to the URL (never a message), and stops with "Could not reach your agent at <url>" if nothing answers; any HTTP status counts as an answer.

`chinwag test` runs on your machine and POSTs each of the person's messages to that URL from there, so your agent never has to be reachable from the internet (`http://localhost` is fine). The request is JSON, with `authorization: Bearer <CHINWAG_AGENT_TOKEN>` when that variable is set:

```json
{
  "conversationId": "whatsapp:ses_8f2a.opening-hours.whatsapp.1",
  "messageId": "m1",
  "channel": "whatsapp",
  "message": { "text": "hi, what time are you open today?", "attachments": [{ "kind": "image", "mime": "image/jpeg", "name": "receipt.jpg", "data": "<base64>" }] }
}
```

Keep the conversation's history by `conversationId`, as you would per phone number. `channel` is the platform the run plays (`whatsapp`, `sms`, `imessage`, `telegram`, `web`), or the name you give with `--channel`. `message.text` is `""` when the person only sent a file; a tapped button or list row also comes as `message.choice` (`{ id, title }`), a quoted message as `message.replyTo`. Answer `200` with the replies to send, in order, in the shape a Chinwag agent sends (`{ "type": "message", "text", "buttons"?, "list"?, "link"?, "image"?, "replyTo"? }`, `{ "type": "reaction", "emoji", "messageId" }`, `{ "type": "template", ... }`, ...); `[]` sends nothing:

```json
{ "replies": [{ "type": "message", "text": "We're open 8am to 6pm today.", "buttons": ["Order ahead"] }] }
```

A minimal server, with no dependencies (the whole file is [`examples/http-agent/server.mjs`](https://github.com/flow-engineer/chinwag/blob/main/examples/http-agent/server.mjs), with a test scenario beside it; it also ships in the package, in `node_modules/chinwag/examples/http-agent`):

```js
import { createServer } from "node:http";

createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const { conversationId, channel, message } = JSON.parse(body);
  const text = await myAgent.reply(conversationId, message.text); // your framework here
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ replies: [{ type: "message", text }] }));
}).listen(3000);
```

Each reply is checked against what the run's platform can show, as a Chinwag agent's is: one that does not fit (buttons on SMS, text over the limit) is not sent, and the run says why. A status other than 200, a body that is not `{ "replies": [...] }` or no answer within 60 seconds (`--agent-timeout <s>`) fails that message's turn, with the reason in the run; the session goes on. A conversation's messages are sent one at a time: the next waits for the last one's answer.

Your agent's own tools run on its side, for real, so `tests/tools/*.yaml` are not used, and outcome, `calls` and `never` checks (which read simulated tool calls) see none: write what must be true as `judge` items. The agent's model cost shows as $0, since Chinwag does not see its model calls. Not yet supported: agents that answer later through a callback instead of in the response, and the person's reactions to the agent's messages.

### Any language

The endpoint's contract is written down in [`spec/`](spec/): [`agent-endpoint.openapi.yaml`](spec/agent-endpoint.openapi.yaml) (OpenAPI 3.1: the request, the answer, statuses, timeouts, the token, and what each platform shows) with JSON Schemas for the [request](spec/request.schema.json) and the [answer](spec/response.schema.json). A coding agent can implement it in any language from those files alone.

Check an endpoint against the contract before a test run, with no cloud, no key and no model call on Chinwag's side:

```bash
npx chinwag check-endpoint http://localhost:3000/chinwag [--token-env NAME] [--json]
```

It sends a fixed set of synthetic messages (a typed message, a double text, a photo, a tapped button quoting the agent, a message that may need no answer) and checks each answer: status 200, `{ "replies": [...] }`, every reply against the schema and what WhatsApp can show, and every id a reply names (`replyTo`, a reaction's `messageId`) one of the person's messages. One line per case; exit 0 when all pass, else 1. The token is the value of `NAME` (default `CHINWAG_AGENT_TOKEN`).

The café's agent as an HTTP endpoint, with its two tools and one model through any OpenAI-compatible API (the same key variables as `openAICompatible`, `MODEL` for the model; `FAKE_MODEL=1` for a fixed reply and no model call): [`examples/http-agent-python`](examples/http-agent-python) (standard library only) and [`examples/http-agent-go`](examples/http-agent-go) (standard library only).

## Models

Any OpenAI-compatible API. With no `apiKey` or `baseURL`, `openAICompatible` uses the first key that has a value: `OPENROUTER_API_KEY` (OpenRouter), `OPENAI_API_KEY` (OpenAI), `ANTHROPIC_API_KEY` (Anthropic), then `GEMINI_API_KEY` (Gemini); with none it stops at once and names them. `MODEL` sets the model id; each key has its own default. Pass `baseURL` and `apiKey` for any other address; a local server that needs no key needs only `baseURL`. Give `contextTokens` (the model's window) and a long chat's history is kept within it: the latest messages go to every call, older ones are left out (the agent is told).

For agents with tools we recommend **Claude Haiku 5.5** (`anthropic/claude-haiku-5.5`) or **GPT-6.1 Sol** (`openai/gpt-6.1-sol`, about 3x the cost). In our tests, GPT Luna repeated tool calls and answered twice.

## `createAgent` options

| Option | What it does |
|---|---|
| `dir` | The folder with `AGENTS.md` and `skills/`; an `AGENTS.md` that can't be read throws, naming the path |
| `files` | `AGENTS.md` and skills as text, instead of `dir`, where there is no folder to read |
| `model` | Any `Model`; `openAICompatible({ model })` for most |
| `tools` | Your tools |
| `channels` | `whatsapp()`, `sms()`, `customUI()` definitions |
| `resolve` | Your key for a person from a channel identity, to join channels |
| `database` | Where state lives (`sqlite()` in memory by default) |
| `store` | Instead of `database`: a store of your own that keeps the state elsewhere |
| `testPeople` | Who the playground may play: `[{ name, phone }]` |
| `templates` | The WhatsApp templates you set up with Meta (header, body, footer, buttons): each send is checked against its declaration, and the playground shows it as WhatsApp does |
| `transcribe` | Speech to text for voice notes, with the provider you choose |
| `context` | Text added to every turn: who this person is, the time |
| `intercept` | Answer some messages without the model; `message.channel` is the channel it came in on, and it sees STOP, START and HELP first, marked in `message.keyword` (they are built in on SMS and WhatsApp) |
| `timeZone` | The business's time zone, for schedules when a person's is unknown |
| `deadlineMs` | The longest a reply waits for a tool (60,000); a tool can set its own |
| `partialAfterMs` | How long a finished tool's result waits for the others (5,000) |
| `debounceMs` | Quiet time after a message before the reply starts (300) |
| `maxSteps` | Model steps per turn (8) |
| `history` | How much of a long chat each model call carries: `{ maxTokens, toolResultChars }` (60% of the model's `contextTokens`, else 50,000 tokens; tool results cut at 12,000 characters) |
| `inlineSkills` | Put every skill in the prompt instead of loading on demand |
| `shareUpdates` | Live status lines on web and app UIs (on); a string replaces the guidance |
| `traces` | Where traces go (from the environment by default, see above) |
| `events` | Where events go |

## With a coding agent

`chinwag new` puts the skills in your agent's `.claude/skills/`. They are also in [`coding-agents/`](https://github.com/flow-engineer/chinwag/tree/main/coding-agents): `skill.md` builds an agent, `tools-skill.md` writes tools and their test files, `test-skill.md` writes scenarios. The café in [`examples/cafe`](https://github.com/flow-engineer/chinwag/tree/main/examples/cafe) is a complete agent with tests to copy from.

## Contributing

| Folder | What it is |
|---|---|
| `src/` | The runtime (`chinwag`) |
| `simulators/` | The playground (`chinwag/simulators`): SMS, WhatsApp, iMessage, Telegram and web, with each platform's rules |
| `testing/` | Test file formats and the `chinwag` command (`chinwag/testing`) |
| `examples/cafe/` | Pip, an ordering assistant, with tests |
| `coding-agents/` | Skills for coding agents |

To work on Chinwag itself, start an agent inside a clone; it imports `src/` and `simulators/src/` by path, so your changes show at once:

```bash
git clone https://github.com/flow-engineer/chinwag
cd chinwag && npm ci
npm run new -- my-agent
echo "OPENROUTER_API_KEY=sk-or-..." > agents/my-agent/.env
cd agents/my-agent && npm start
```

`agents/` is git-ignored, so `git pull` never touches your agents. `npm test` runs the runtime's tests and `cd simulators && npm test` the simulators'. Unit tests never call a real model. Read [AGENTS.md](https://github.com/flow-engineer/chinwag/blob/main/AGENTS.md) before contributing.

## FAQ

**Who is it for?** Anyone putting an agent in front of people in a chat: a booking assistant, a shop's order bot, a support agent. If your agent mostly talks to a person and calls tools, it is for you. If it works alone for an hour on a codebase, use a general agent SDK.

**How is it different from general agent frameworks?** Those give you an agent loop, and a chat is one more thing you build on top. Chinwag is opinionated about chat: one actor per conversation, double texts folded into one turn, tools that never stall the chat, acknowledgements, channel rules, one person across channels, and schedules built in.

**Which channels are real?** WhatsApp, SMS and your own UI (`customUI`) have production definitions today; you plug in any provider by writing `sendMessage`. iMessage and Telegram are in the playground for now.

**Does it host my agent?** No. It runs in your Node process, on your machine or servers. You pay your model and messaging providers directly.

**Is the data mine?** Yes. State lives in your database, and events go wherever you send them.

**What does a double text do mid-reply?** While the agent is thinking, its step restarts with everything they said, so they get one reply. While a tool runs, the agent reads the new message at once and the tool carries on in the background.

## License

[MIT](https://github.com/flow-engineer/chinwag/blob/main/LICENSE)
