# Working on Parley

Parley is a framework for consumer chat agents: agents people reach on WhatsApp, SMS, iMessage,
Telegram or a web or app chat, that feel like a person texting back.

## Keep it general
- Nothing specific to one business goes in this repository: no customer names, data, prompts
  or business rules. Agents built on Parley live in their own repositories and depend on it;
  Parley never imports from outside this repository.

## Be deliberate: nothing goes in that has not earned its place
- Every file, function, dependency and test must have a reason. No speculative code, helpers
  "for later", extra options, or files nobody asked for.
- Propose a design choice (behaviour, defaults, models, prompts, dependencies, file layout) with
  a recommendation before writing code that depends on it.
- No new dependency without agreement.
- Remove what stops being used (scripts, options, tests) in the same change.

## Tests
- Each test protects one behaviour. Before adding one, say which behaviour, and why no existing
  test already covers it. Prefer fewer tests that matter; merge or delete tests that overlap or no
  longer protect anything.
- Unit tests never call a real model: they drive a scripted model. Wait on explicit gates
  (promises the test resolves), never on sleeps.
- While iterating, run only what a change affects: `npm run test:changed` picks the test files
  by rule and runs them in parallel.
- Every test file starts with `// covers: <src files>`, the source files whose behaviour it
  protects; `test:changed` reads it, so keep it accurate when tests move or code is split. Paths
  are relative to the repository root, also in the simulators package (`simulators/src/server.ts`).
- The full suite (`npm test`, at the root and in `simulators/`) runs before a change is merged.
- Tests that call real models (a simulated person, a judge) run only when someone starts them,
  never in CI, and print what they cost.

## Coding-agent skills
- `coding-agents/` teaches coding agents to build on Parley (`skill.md`), write tools and their
  test files (`tools-skill.md`) and write tests (`test-skill.md`). A change to an API, a file
  format or a convention they describe updates them in the same change.

## Model-facing text
- Parley's own text for the model lives in `src/talk.ts`, `src/conversation.ts`, `src/skills.ts`,
  and the built-in tools' descriptions and notes in `src/schedules.ts` and `src/nudges.ts`. Keep it
  short; every line costs every turn.
- `testing/` is the developer's side of testing: the test file formats (`suite.ts`), and the CLI
  and protocol that send an agent's tests to the test cloud. The cloud plays the person and the
  tools and judges the runs; that runtime is not in this repository.
