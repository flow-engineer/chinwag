# Café agent in Go

Pip, the café's ordering assistant from [`../cafe`](../cafe), written in Go with only the standard library and tested by Chinwag through its HTTP endpoint ([`spec/agent-endpoint.openapi.yaml`](../../spec/agent-endpoint.openapi.yaml)). Its instructions are `../cafe/agent/AGENTS.md`; its tools (`get_menu`, `place_order`) are in `tools.go`; its model is any OpenAI-compatible API.

## Run it

From this folder:

```bash
FAKE_MODEL=1 go run .   # no key: every answer is a fixed greeting
go run .                # with a model key from the table
```

It listens on `http://localhost:3000/chinwag` (`PORT` to change it). The first key that is set picks the model:

| Key | Default model |
| --- | --- |
| `OPENROUTER_API_KEY` | `anthropic/claude-haiku-5.5` |
| `OPENAI_API_KEY` | `gpt-6-luna` |
| `ANTHROPIC_API_KEY` | `claude-haiku-5-5` |
| `GEMINI_API_KEY` | `gemini-3.8-flash` |

`MODEL` overrides the model. Set `CHINWAG_AGENT_TOKEN` on both sides to require `authorization: Bearer <token>`.

## Check it

In another terminal, with no cloud, key or model call on Chinwag's side:

```bash
npx chinwag check-endpoint http://localhost:3000/chinwag
node ../../testing/src/cli.ts check-endpoint http://localhost:3000/chinwag   # from a clone of this repo
```

## Test it

From this folder, with the agent running on a real model:

```bash
npx chinwag test --agent-url http://localhost:3000/chinwag --synthetic
```

A hosted test cloud takes its key in `CHINWAG_CLOUD_KEY`. The agent's tools run here, for real, so the café's `tests/tools/*.yaml` simulators are not used, and what must be true is written as `judge` items in [`tests/scenarios/latte-correction.yaml`](tests/scenarios/latte-correction.yaml).

```bash
go test ./...
```
