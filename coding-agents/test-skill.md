---
name: parley-tests
description: Write or change tests for a Parley agent (tests/scenarios/*.yaml). Load when adding a test scenario, deciding what a Parley agent should be checked on, or turning a bad conversation into a test.
---

# Writing tests for a Parley agent

Read `skill.md` in this folder first if you haven't.

A test is a scenario: a situation to put the agent in, played through a platform simulator by a
model acting as the person, with the agent's tools played by a model from `tests/tools/*.yaml`
(see `tools-skill.md` in this folder). At the end, what happened is checked against `expect`.

```yaml
id: latte-correction
title: Orders a latte, corrects the milk mid-thought, confirms
channels: [whatsapp, sms]   # runs once on each, with a result for each

person:
  persona: Sam, in a hurry on the way to work; types in short bursts, no capitals.
  goal: Get a large oat latte for pickup, under the name Sam.
  knows:
    - Their name is Sam.

opening:
  - say: "can i get a large latte"
  - say: "oat milk actually"
    after_ms: 1200

world: |
  The menu is as in tests/tools/get_menu.yaml. Oat milk is in stock. The café is busy this
  morning, so the point of sale is slow to take orders, but they go through.

max_turns: 8

expect:
  outcome:
    - Exactly one order is placed, for one large latte with oat milk, under the name Sam.
  judge:
    - The order read back to Sam uses oat milk, not whole milk.
    - The agent asks Sam to confirm before placing the order.
    - Sam is told the order number and when it will be ready.
```

## The parts

- `channel`: sms, whatsapp, imessage, telegram or web. The run uses that simulator's real rules
  (SMS has no buttons or reactions; WhatsApp has both).
- `person`: who the model playing the person is (`persona`), what they want (`goal`), and facts
  they only give if asked (`knows`). It sees only what a person would see.
- `opening`: the first messages, sent exactly as written; `after_ms` sends one that long after
  the previous one (a double text). Then the person plays on until `goal` is met or `max_turns`.
- `world`: everything true in this test, in plain words. It is the only place the situation is
  set: stock, outages, slowness, the person's history. The tool simulator plays every tool from
  it, choosing among the responses in `tests/tools/*.yaml`. Never write tool responses or
  latencies in a scenario.
- `expect`:
  - `outcome`: what must have happened, checked against what the tools did ("exactly one
    order is placed", "no order is placed").
  - `judge`: what the conversation must show, one checkable sentence each; a judge model reads
    the transcript and marks each pass or fail with a reason.

How fast the agent first replies to each message is measured on every run from timestamps, not
written in scenarios: the dashboard shows it for the whole run (average, p95, min and max).

## Choosing what to test

- One situation per scenario, named for it (`order-fails`, `latte-correction`).
- Test what would hurt a real person if it broke: wrong order, a claim the order was placed when
  it wasn't, a missed escalation, a slow or missing acknowledgement.
- Write `judge` items as facts a reader can check from the transcript, not taste ("asks Sam to
  confirm before placing the order", not "is helpful").
- Cover the unhappy paths the tool files list (busy, down, unknown item) as their own scenarios.
- When a real conversation went wrong, turn it into a scenario: its world is what was true then,
  its opening is what the person sent.

## Running the tests

Tests run in the Parley cloud: your agent stays on your machine with its own model and key and
connects out to the cloud, which plays the person and the tools and judges.

1. Have a test cloud running. The cloud itself is not part of this repository yet; the CLI and
   the protocol it speaks (`testing/src/protocol.ts`) are.
2. From the agent's folder (it must export `buildAgent` and `tools` from `src/agent.ts`):
   `node --env-file=.env <parley>/testing/src/cli.ts --cloud http://127.0.0.1:8900 [--runs 3]`.
3. It prints PASS or FAIL per run with every failed check and the judge's reason, and a link
   to watch each conversation in the simulator. The dashboard (http://127.0.0.1:8900) shows
   every session over time and each scenario's history.

Only the files in your `tests/` folder run; the cloud keeps each file by its hash and compares
runs only while the tests are the same. Every run calls real models, so it costs a little.
