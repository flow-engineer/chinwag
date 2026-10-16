---
name: chinwag-tools
description: Write or change a Chinwag agent's tools and their test files (tests/tools/*.yaml). Load when adding a tool to a Chinwag agent, changing what a tool returns, or describing how a tool behaves in tests.
---

# Writing tools for a Chinwag agent

Read the `chinwag` skill (`skill.md`) first if you haven't. Tests that use these tool files are
in the `chinwag-tests` skill (`test-skill.md`).

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
    output: { order_id: BL-1040, ready_by: "2026-10-11T15:42:00Z", pay_at_pickup: true }
  - when: The point of sale is busy; the order still goes through
    latency_ms: 11000
    output: { order_id: BL-1041, ready_by: "2026-10-11T15:55:00Z", pay_at_pickup: true }
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
- Latency lives only here. Scenarios describe situations ("the point of sale is slow this
  morning"); the simulator picks the matching response and latency on each call.
