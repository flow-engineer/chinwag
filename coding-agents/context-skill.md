---
name: chinwag-context
description: Build the context pack (OpenAPI spec, overlay, workflows, business, data model, access rules, examples) from an organization's existing codebase, before writing a Chinwag agent's tools. Load when starting an agent for a company that already has an app, API or database, when asked for an OpenAPI spec or "the spec", or when the tools need facts nobody has written down.
---

# The context pack

Tools are only as good as what you know when you write them. Before writing a Chinwag agent's
tools (the `chinwag-tools` skill), gather everything about the organization's systems into one
folder in the agent's repository, `context/`. It is the input for every later step: the tools,
the agent's skills, the sign-in (the `chinwag-auth` skill), the tests and the CLI.

Work from the organization's own code and documents. Never invent: anything you cannot find goes
in `context/README.md` under "Questions for the team", phrased so someone can answer it in a line.

## What goes in it

| File | Format | What it holds |
|---|---|---|
| `context/README.md` | Markdown | The index: where each file came from (repo, path, commit, who confirmed it), environments, and the questions for the team |
| `context/openapi.yaml` | OpenAPI 3.1, **exactly as the team gives it** | Their API: operations, request and response schemas, errors, security schemes |
| `context/overlay.yaml` | [OpenAPI Overlay 1.0](https://spec.openapis.org/overlay/v1.0.0) | Everything you add to their spec, as changes applied to it: clearer descriptions, units ("amount is in paise"), which fields matter, gotchas, operations to avoid |
| `context/workflows.arazzo.yaml` | [Arazzo 1.0](https://spec.openapis.org/arazzo/v1.0) | How calls connect: the steps of each real task, how one step's output feeds the next, what counts as success, what to do when a step fails |
| `context/business.md` | Markdown | What the company does, who its customers are, the words they use, the policies a person would be told ("refunds within 30 days", "never promise delivery times") |
| `context/data.md` | Markdown | The entities and their ids, how they relate ("an order belongs to one store"), and which fields are personal data |
| `context/access.yaml` | YAML | Who may do what: for each task, whether it works signed out, needs the person signed in, needs a write, or needs the person's approval each time; customer or staff only |
| `context/examples/*.md` | Markdown | Real situations and what should happen, including the awkward ones (a refund after the window, an order that fails to pay) |

Never put keys, tokens, passwords or real customers' data in any of these files.

**Why their spec stays untouched:** the team will send new versions. Your knowledge lives in the
overlay, which is applied to each new version the same way, so nothing is lost and you can see
exactly which overlay entries, workflows and tools point at operations that changed.

## Find the API, by stack

Look at the repository's routes, its framework and its dependencies first, then pick the case:

- **A REST API with an OpenAPI spec.** Ask for the latest version, or find it in the repo
  (`openapi.*`, `swagger.*`, a generator such as FastAPI, NestJS's Swagger module, springdoc,
  drf-spectacular, rswag). Use theirs as is.
- **A REST API without a spec.** Draft one from the routes and handlers, with an `operationId` and a
  plain description on every operation, request and response schemas from the code's own types,
  and the error responses the handlers send. Put `x-chinwag-draft: true` at its top and list it in
  the questions: the team confirms it, and from then on it is theirs.
- **GraphQL.** Keep the schema (`context/schema.graphql`) instead of OpenAPI, and describe the
  queries and mutations the tasks use in the workflows file as plain steps.
- **Supabase.** PostgREST generates an OpenAPI spec from the database. It is no longer served with
  the public anon key: the team exports it with a secret key or the Management API
  (`GET /v1/projects/{ref}/database/openapi`), once, and gives you the file. Read the row-level
  security policies (`supabase/migrations`, `pg_policies`) into `access.yaml`: they are the real
  permission model.
- **Firebase (Firestore, Realtime Database, Storage).** There is no API: the database and its
  security rules are the API. There is no OpenAPI; instead:
  - `firestore.rules` (and `database.rules.json`, `storage.rules`) into `access.yaml`: who may read
    and write what, condition by condition;
  - `firestore.indexes.json`: which queries are possible;
  - the app's models and the code that reads and writes each collection into `data.md`: the
    collections, their fields and types, and the ids that link them;
  - Callable or HTTP Cloud Functions are its only real endpoints: list them in `data.md` with their
    input and output.
- **Several of these at once** (a REST API plus Firebase for chat, say): one section per system in
  `data.md`, and say in the workflows which system each step uses.

## Fill the rest

- **Workflows:** one per task the agent or a host should be able to do in one call ("place an
  order" = check stock, create the order, take payment; if payment fails, cancel the order). These
  become the tools: a tool is a task, not an endpoint.
- **Business and data:** from the app's own copy (its website, help pages, emails, the UI's
  strings), its terms and policies, and its models. Mark every personal field (names, phone
  numbers, addresses, payment details) in `data.md`: tools return them only when a task needs them.
- **Access:** from the rules and middleware. For each task in the workflows, write one of
  `signed_out`, `signed_in`, `signed_in_write` or `approval` (the person confirms each time), and
  `staff` when only the team's staff may do it. This is what the tools' `signIn` and `hints` say.
- **Examples:** from support tickets, chat logs or the team's own words, with personal data
  removed. They become test scenarios (the `chinwag-tests` skill).
- **Environments:** a sandbox or test server and how to get test accounts, the rate limits, how
  the API pages results, and whether writes take an idempotency key. In `README.md`.

## Questions for the team

Ask for what the code cannot tell you. The usual ones:

1. The latest OpenAPI spec (3.1), with an `operationId` and a description on every operation.
2. Request and response examples, including the errors.
3. The security schemes and the scopes each operation needs, and how their users sign in today.
4. How results are paged, the rate limits, and whether writes accept an idempotency key.
5. A sandbox or test server, and test accounts.
6. The webhooks or events they send (orders shipped, payments failed).
7. Which tasks customers may do themselves, which need their approval each time, and which are
   staff only.

Then go on to the `chinwag-auth` skill (sign-in) and the `chinwag-tools` skill (the tools).
