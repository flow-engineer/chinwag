# The café's agent in Python

Pip, the café's ordering assistant from [`../cafe`](../cafe), as a Python server with no
dependencies (Python 3.11+, standard library only). It implements Chinwag's agent endpoint
([`spec/agent-endpoint.openapi.yaml`](../../spec/agent-endpoint.openapi.yaml)) so `chinwag test` can
talk to it: one POST per message from the person, answered with the replies to send. It reads the
café's instructions from `../cafe/agent/AGENTS.md`, runs the café's `get_menu` and `place_order`
tools itself, and calls any OpenAI-compatible model.

## Run it

```bash
FAKE_MODEL=1 python3 server.py    # no key: every answer is one fixed reply
python3 server.py                 # with a model key set (below)
```

It listens on `http://localhost:3000/chinwag` (`PORT` to change it). The first key that is set
picks the model; `MODEL` overrides its model id:

| Key | Default model |
| --- | --- |
| `OPENROUTER_API_KEY` | `anthropic/claude-haiku-5.5` |
| `OPENAI_API_KEY` | `gpt-6-luna` |
| `ANTHROPIC_API_KEY` | `claude-haiku-5-5` |
| `GEMINI_API_KEY` | `gemini-3.8-flash` |

Set `CHINWAG_AGENT_TOKEN` here and where `chinwag test` runs to require it.

## Check it

In another terminal, against the contract, with no cloud, key or model call on Chinwag's side:

```bash
npx chinwag check-endpoint http://localhost:3000/chinwag
node ../../testing/src/cli.ts check-endpoint http://localhost:3000/chinwag    # from a clone
```

## Test it

From this folder:

```bash
npx chinwag test --agent-url http://localhost:3000/chinwag --synthetic
```

A hosted test cloud needs its key in `CHINWAG_CLOUD_KEY`. The agent's tools run here for real, so
the café's `tests/tools/*.yaml` simulators are not used, and what
[`tests/scenarios/latte-correction.yaml`](tests/scenarios/latte-correction.yaml) checks is written as
judge items.

The tools and the message format have unit tests: `python3 -m unittest`.
