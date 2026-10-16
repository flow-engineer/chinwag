---
name: chinwag-tests
description: Write or change tests for a Chinwag agent (tests/scenarios/*.yaml). Load when adding a test scenario, deciding what a Chinwag agent should be checked on, or turning a bad conversation into a test.
---

# Writing tests for a Chinwag agent

Read the `chinwag` skill (`skill.md`) first if you haven't.

A test is a scenario: a situation to put the agent in, played through a platform simulator by a
model acting as the person, with the agent's tools played by a model from `tests/tools/*.yaml`
(see the `chinwag-tools` skill, `tools-skill.md`). At the end, what happened is checked against `expect`.

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
  A step may send a file: `- { say: "here is my receipt", attach: { kind: image, file: fixtures/receipt.jpg } }`
  (`kind`: image, audio or document; `file` a path in `tests/`; `say` is its caption and may be
  left out). The file is read on your machine and never uploaded; the person and the judge see it
  by name only.
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

Tests run in the Chinwag cloud: your agent stays on your machine with its own model and key and
connects out to the cloud, which plays the person and the tools and judges.

1. Have a test cloud: the hosted one at https://flow.engineer/observe, the default (see "Get a test
   cloud" below), or another with `--cloud <url>` or `CHINWAG_CLOUD`.
2. From the agent's folder (it must export `buildAgent` and `tools` from `src/agent.ts`), which reads
   the agent's `.env` itself: `npx chinwag test --synthetic [--runs 3]` (`npm test -- --synthetic`
   in an agent `chinwag new` made).
3. It first reads every test file as the cloud does; a mistake stops it with
   `tests/scenarios/<file>.yaml:<line>: <field>: <what is wrong>`, one line each, and nothing is sent.
   Then it prints PASS or FAIL per run, with its run id, every failed check and the judge's reason,
   and a link to watch each conversation in the simulator. The cloud's dashboard, at its own
   address, shows every session over time and each scenario's history.
4. `--json` prints one JSON report on stdout at the end, whatever the exit (everything else goes to
   stderr): `outcome`, `exitCode`, `sessionId`, `agent`, `error`, `counts`, `costUsd` and per run
   `runId`, `scenario`, `channel`, `run`, `verdict`, `error` (the cloud's code when it could not play
   or judge the run, such as `judge_failed`; the run is then `errored` and its line reads `ERROR`,
   whatever it ended as), `ended`, `turns`, `watch` and `failedChecks` (`kind`, `text` and the judge's
   `reason`). Each session that opened also leaves
   `.chinwag/last-session.json` in the agent's folder (its path is printed on every exit): `sessionId`,
   `agent`, `dashboard`, `suiteHash`, `endedAt`, `ended` (`finished`, `stopped` or `interrupted`),
   `only` (the scenarios it was limited to, else `null`) and per run `scenario` (file name without
   `.yaml`), `channel`, `run`, `runId`, `verdict` (`passed`, `failed`, `errored`: the cloud could not
   play or judge it, or `not_played`: the session ended first) and `failedChecks` (with reasons).
   Read these instead of parsing the printed lines.
   Exit status: 0 all passed; 1 a run failed, or nothing was sent (a wrong flag, a test file that does
   not parse, no key); 2 the connection or the cloud failed, or runs errored and none failed; 3 the
   cloud refused (key, busy, spend cap, capacity); 130 Ctrl-C. On 2 or 3 the agent is not at fault:
   say what the cloud said (`error` in the report), do not change the agent for it.
5. `--only a,b` runs only those scenarios (file names without `.yaml`). `--failed` runs only the ones
   that did not pass in the last session, on every channel each plays; it goes with `--runs`, never
   with `--only`. It prints `Nothing failed in the last session (<id>).` and exits 0 when there is
   nothing to run again, and exits 1 when there is no last session.

Work in this loop, and never finish on a partial run:

1. `npx chinwag test --synthetic`: the whole suite.
2. Fix what failed (the agent, or a test that asks for the wrong thing; say which).
3. `npx chinwag test --synthetic --failed`, again until every run in it passes (exit 0).
4. `npx chinwag test --synthetic`: the whole suite once more, since a fix can break another scenario.

### When a run fails

1. `npx chinwag test --synthetic --json > report.json`, and read the runs whose `verdict` is not
   `passed` (`jq '.runs[] | select(.verdict != "passed")' report.json`).
2. `npx chinwag show last` (the first run that did not pass; it names the others) or
   `npx chinwag show <runId>`: the checks with the judge's reasons, then the conversation in time
   order with every tool call the simulator played, its input, output and what it changed.
   `--json` gives the whole record.
3. Decide which is wrong, and say which:
   - the agent: it said or did the wrong thing; fix its prompt, tools or code;
   - the test: a check asks for the wrong thing, or the scenario cannot reach its goal; fix the YAML;
   - the simulator: a tool output that could not happen, or a person who left the scenario; fix
     `tests/tools/*.yaml` or the scenario's `world` and `person`.
4. `npx chinwag test --synthetic --failed`, then `--runs 3 --only <scenario>` on what you fixed, so
   a pass is not luck.
5. The whole suite once more.

### Get a test cloud

The owner does these; never ask for the key in chat or print it:

1. Sign in at https://flow.engineer/observe (Google, GitHub or an email link).
2. Workspace → New agent.
3. On the agent's Developers page, "Make a CI key". It starts with `oci_` and is shown once.
4. Put it in the agent's `.env` as `CHINWAG_CLOUD_KEY` (never on the command line).
5. `npx chinwag test --cloud https://flow.engineer/observe --synthetic` from the agent's folder (`--cloud` is that address by default).

Your agent runs on your machine with your own model key. The cloud's person simulator, tool simulator and judge are free up to $5 a day per workspace, with 2 sessions at once; test data only (`--synthetic`), and records are deleted after 30 days. `--synthetic` is the promise that the test files hold no real customer or member data;
the CLI refuses a hosted cloud without it and the key. `--environment staging` or `production` is
kept with the session.

The open goes to the front door with the key; the session then plays at the tunnel the cloud
answers, with the session's own token. `--agent-version` (else `GITHUB_SHA`) and `--ref` (else
GitHub's branch) are kept with the session. A CI step (GitHub Actions shown):

```yaml
- run: npx chinwag test --cloud https://flow.engineer/observe --synthetic --environment staging
  env:
    CHINWAG_CLOUD_KEY: ${{ secrets.CHINWAG_CLOUD_KEY }}
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
```

Only the files in your `tests/` folder run; the cloud keeps each file by its hash and compares
runs only while the tests are the same. Every run calls real models, so it costs a little.

## An agent on another framework, in any language

An agent not built on Chinwag is tested through an HTTP endpoint: `npx chinwag test --agent-url <url>`.
To implement one:

1. Read the contract, `spec/agent-endpoint.openapi.yaml` (in the chinwag package or the repository),
   with `spec/request.schema.json` and `spec/response.schema.json`. Implement exactly that: one
   POST per message of the person's, answered in the same response with status 200 and
   `{ "replies": [...] }` (`[]` for no reply, never 204). Keep history by `conversationId`, ignore
   request fields you do not know, and check `authorization: Bearer` when `CHINWAG_AGENT_TOKEN` is set.
2. Only send what the run's platform shows (`x-chinwag-platforms` in the spec): no buttons on SMS,
   text within `maxLength`. Name the person's messages by the `messageId` they came with.
3. Start the endpoint and run `npx chinwag check-endpoint <url>` (`--token-env NAME` when it needs
   a token). Fix every FAIL line; it must end "5 of 5 cases passed". Give the agent a mode with no
   model call (the examples' `FAKE_MODEL=1`) so the check costs nothing.
4. Then write scenarios as above, with one difference: the agent's own tools run for real, so there
   are no `tests/tools/*.yaml`, no `world` for tools and no `outcome` checks; write what must be true
   as `judge` items. Run `npx chinwag test --agent-url <url>`.

`examples/http-agent-python` and `examples/http-agent-go` are the café's agent done this way.
