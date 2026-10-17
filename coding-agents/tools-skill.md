---
name: chinwag-tools
description: Write or change a Chinwag agent's tools and their test files (tests/tools/*.yaml). Load when adding a tool to a Chinwag agent, changing what a tool returns, or describing how a tool behaves in tests.
---

# Writing tools for a Chinwag agent

Read the `chinwag` skill (`skill.md`) first if you haven't. Tests that use these tool files are
in the `chinwag-tests` skill (`test-skill.md`). For a company with an existing app or API, build
the context pack first (the `chinwag-context` skill, `context-skill.md`) and write the tools from
it.

## The tool

```ts
import { tool, z } from "chinwag";

export const findSlots = tool({
  name: "find_session_slots",
  description: "Every open time to move the session to, for a date range.",
  input: z.object({
    from_date: z.string().optional().describe("First day to search, YYYY-MM-DD; default today"),
    to_date: z.string().optional().describe("Last day, YYYY-MM-DD; default a week later"),
  }),
  run: async ({ from_date, to_date }, { conversationId }) => backend.findSlots(conversationId, from_date, to_date),
});
```

- The name and description are what the model reads to choose the tool: say what it does and
  what it returns, in one line.
- `input` is a zod schema; Chinwag checks the model's input against it before `run` is called and
  sends the model the error if it doesn't fit.
- `run` returns any JSON-able value; throw to report a failure (the agent sees `Failed: <message>`).
- Don't make tools for talking to the person (send_<channel>, react, share_updates), for reminders
  or scheduled messages, or for opting out of messages: Chinwag has them.
- Key a person's data by `context.person` (who Chinwag verified they are) or `context.conversationId`,
  never by an id the model passed. `context.person` is `key:<resolve's value>`, else
  `phone:<E.164>` (`phone:+15550100100`), else `<channel>:<address>`. To look the person up in the
  owner's backend use `context.key`: exactly what `resolve` returned (`customer-7`), or null when
  they are known only by phone or channel.
- A tool that changes something (books, pays, sends) passes `context.idempotencyKey` to its backend:
  it is the same for the same input in the same turn, also when the turn runs again after a
  restart, so the booking happens once. `context.callId` is the model's id for the call;
  `context.signal` aborts when the person is forgotten.
- Don't decide what runs in the background. The reply waits for every call; one moves to the
  background only if the person writes again meanwhile or it passes its limit (the agent's
  `deadlineMs`, 60 s by default), and its result comes back into the chat by itself. Set
  `deadlineMs` on a tool for its own limit: shorter for one that should never hold a reply long,
  longer for one known to be slow.
- Say what you covered. An agent reads a list as complete: return the range or filter you
  searched ("Mon Oct 12 through Sun Oct 18", "all open times") and never cut results short
  silently. If there are more, say so.

## Tools from the context pack

- One tool per task in `context/workflows.arazzo.yaml`, never one per endpoint: "place an order"
  is one tool even when it is three API calls. A host or a small model chooses well among a few
  task-shaped tools and badly among dozens of raw ones.
- Take the input and output shapes from `context/openapi.yaml` with `context/overlay.yaml` applied,
  the words and rules from `business.md`, and leave out the personal fields `data.md` marks unless
  the task needs them.
- `signIn` and `hints` come from `context/access.yaml` (below).
- When the team sends a new spec, re-read the overlay and the workflows against it, change only the
  tools whose operations changed, and run `chinwag check` and the tests.

## The fields MCP and the CLI read

The same tool is served to Claude and ChatGPT over MCP (`chinwag/mcp`) and as a command (`chinwag/cli`).
These optional fields describe it there. **Chat ignores all of them**: they change nothing on
WhatsApp, SMS or iMessage.

```ts
export const placeOrder = tool({
  name: "place_order",
  title: "Place an order",                         // default: "Place order", from the name
  description: "Place a confirmed pickup order. Returns the order number and when it will be ready.",
  input: z.object({ name: z.string(), items: z.array(item) }),
  output: z.object({ order_id: z.string(), ready_by: z.string() }),  // the result's shape
  status: { running: "Placing your order…", done: "Order placed" },  // at most 64 characters each
  signIn: "required",                              // "required" (default) | "optional" | "none"
  hints: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
  run: async (input, context) => pos.place(input, context.idempotencyKey),
});
```

- `output`: over MCP the result is checked against it and sent as structured content, and the CLI
  shows its fields with `--json` and `--fields`. Give it whenever the result has a fixed shape.
- `signIn`: "none" for what anyone may do signed out (the menu, opening hours), "optional" for what
  works either way and does more signed in, "required" (the default) for everything about a
  person's own account. It applies only where sign-in is set up (the `chinwag-auth` skill).
- `hints` describe the tool to hosts, which ask the person before risky calls; nothing enforces
  them. `readOnly` (default false: a tool counts as a write), `destructive` (a write that may delete
  or overwrite; default true for writes), `idempotent` (calling again with the same input changes
  nothing more; default false), `openWorld` (reaches outside the business's own systems, such as the
  web; default true). Set them honestly: a read-only tool should say so, or hosts treat it as a
  write and the CLI asks for `--yes`.
- `chinwag check` (from the agent's folder) refuses what cannot be served exactly: a name outside
  1 to 128 of `A-Z a-z 0-9 _ - .`, an empty description, a description naming a chat-only tool
  (`send_*`, `share_updates`, `load_skill`), an input that is not a `z.object`, an input or output
  with no exact JSON Schema (`z.date()`, transforms; use an ISO string), `readOnly` with
  `destructive`, or a status line over 64 characters.

## Tools from another MCP server

An existing MCP server's tools become the agent's own, so the agent uses them on WhatsApp or
iMessage like any tool:

```ts
import { mcpTools } from "chinwag/mcp";

export const tools = [
  ...myTools,
  ...(await mcpTools({ name: "todoist", url: "https://ai.todoist.net/mcp", headers: { authorization: `Bearer ${process.env.TODOIST_KEY}` } })),
];
```

- They are pinned: `chinwag mcp update` (from the agent's folder) writes the server's tools to
  `mcp.lock.json`, and only those are used. Commit it with the tests. A tool the server changes or
  removes later is refused with a clear error until the lock is updated, tested and committed; a
  tool it adds is not offered until then. `only: [...]` keeps a few of its tools, `prefix` keeps
  two servers' names apart, and `live: true` skips the lock (for a server you do not build around).
- Each needs a `tests/tools/<tool>.yaml` like any tool. A tool without `readOnlyHint` counts as a
  write. Keep keys in the environment, never in the lock.

## The tool's test file

In tests no real tool runs: a model plays each tool from the scenario's world. `tests/tools/<tool>.yaml`
tells it how the tool behaves: every kind of response it gives, each with an example and how long
it takes. Write one per tool.

```yaml
tool: place_order
behaviour: |
  Order numbers are BL- followed by four digits and go up by one per order. ready_by is about
  ten minutes after the order is placed. Fails if an item, size or milk is not on the menu.
responses:
  - when: The order goes through (usual)
    latency_ms: 4800
    input: { name: Sam, items: [{ item: Latte, size: large, milk: oat, quantity: 1 }] }
    output: { order_id: BL-1040, ready_by: "{{now + 10m}}", pay_at_pickup: true }
  - when: The point of sale is busy; the order still goes through
    latency_ms: 11000
    output: { order_id: BL-1041, ready_by: "{{now + 15m}}", pay_at_pickup: true }
  - when: The point of sale is down
    latency_ms: 3000
    error: Point of sale unavailable
```

- `behaviour`: what the tool does beyond its description, in plain words (ids, ordering, limits,
  when it fails).
- `responses`: one entry per kind of outcome, the usual one first, then slow ones and each error
  the real system can give. `when` says when it happens; `latency_ms` is how long it takes;
  then `output` (what `run` returns) or `error` (what it throws). `input` is optional, as an
  example of a call.
- Use real responses when you have them (copy them from the agent's recorded tool calls, with
  personal data removed); otherwise write realistic ones in exactly the shape `run` returns.
- Examples show the shape, not the answer: the simulator takes ids, names and dates from the
  scenario's world, the call's input and what the agent already said. Write dates as placeholders
  for the test's clock (`{{now + 10m}}`, `{{now + 2d | date}}`; see the `chinwag-tests` skill),
  never as written dates, which go stale.
- Latency lives only here. Scenarios describe situations ("the point of sale is slow this
  morning"); the simulator picks the matching response and latency on each call.
