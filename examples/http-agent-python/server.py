# The café's agent, Pip, in Python with no dependencies, for `chinwag test --agent-url`: one POST
# per message from the person, answered with the replies to send. Its model is any
# OpenAI-compatible API; its tools run here, for real.
#
#   python3 server.py               listens on http://localhost:3000/chinwag (PORT to change it)
#   FAKE_MODEL=1 python3 server.py  the same, with a fixed reply instead of a model call

import itertools
import json
import os
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

# The café's own instructions (its skills are left out here).
SYSTEM = (Path(__file__).parent / "../cafe/agent/AGENTS.md").read_text()

# The first key that is set picks the provider; MODEL overrides its model. As src/model.ts.
KEYS = [
    ("OPENROUTER_API_KEY", "https://openrouter.ai/api/v1", "anthropic/claude-haiku-5.5"),
    ("OPENAI_API_KEY", "https://api.openai.com/v1", "gpt-6-luna"),
    ("ANTHROPIC_API_KEY", "https://api.anthropic.com/v1/", "claude-haiku-5-5"),
    ("GEMINI_API_KEY", "https://generativelanguage.googleapis.com/v1beta/openai/", "gemini-3.8-flash"),
]
FAKE_REPLY = "Hi, I'm Pip at Bean & Leaf. What can I get you?"

MENU = [
    {"item": "Latte", "sizes": {"small": 4.0, "large": 4.8}, "milks": ["whole", "oat", "almond"], "allergens": ["dairy (unless plant milk)"]},
    {"item": "Flat white", "sizes": {"small": 4.2}, "milks": ["whole", "oat"], "allergens": ["dairy (unless oat)"]},
    {"item": "Cold brew", "sizes": {"small": 4.5, "large": 5.2}, "milks": [], "allergens": []},
    {"item": "Chai", "sizes": {"small": 4.0, "large": 4.6}, "milks": ["whole", "oat"], "allergens": ["dairy (unless oat)"]},
    {"item": "Almond croissant", "sizes": {"one": 4.25}, "milks": [], "allergens": ["gluten", "nuts", "dairy", "egg"]},
    {"item": "Banana bread", "sizes": {"slice": 3.75}, "milks": [], "allergens": ["gluten", "egg", "walnuts"]},
]
order_numbers = itertools.count(1040)


def get_menu():
    return {"menu": MENU, "note": "This is the whole menu."}


def place_order(name, items):
    for line in items:
        entry = next((m for m in MENU if m["item"].lower() == str(line.get("item")).lower()), None)
        if not entry:
            return {"error": f"Unknown item: {line.get('item')}"}
        if line.get("size") not in entry["sizes"]:
            return {"error": f"Unknown size: {line.get('size')}"}
        if line.get("milk") is not None and str(line["milk"]).lower() not in entry["milks"]:
            return {"error": f"Unknown milk: {line['milk']}"}
    ready_by = datetime.now(timezone.utc) + timedelta(minutes=10)
    return {"order_id": f"BL-{next(order_numbers)}", "ready_by": ready_by.isoformat(timespec="seconds").replace("+00:00", "Z"), "pay_at_pickup": True}


TOOLS = {"get_menu": lambda args: get_menu(), "place_order": lambda args: place_order(**args)}
TOOL_DEFS = [
    {"type": "function", "function": {"name": "get_menu", "description": "The full menu: items, sizes with prices in USD, milk options and allergens.", "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "place_order",
        "description": "Place a confirmed pickup order. Returns the order number and when it will be ready.",
        "parameters": {"type": "object", "required": ["name", "items"], "properties": {
            "name": {"type": "string", "description": "The name for the order"},
            "items": {"type": "array", "items": {"type": "object", "required": ["item", "size"], "properties": {
                "item": {"type": "string"},
                "size": {"type": "string"},
                "milk": {"type": "string"},
                "quantity": {"type": "integer", "minimum": 1, "maximum": 20, "default": 1},
            }}},
        }},
    }},
]


def run_tool(call):
    try:
        result = TOOLS[call["function"]["name"]](json.loads(call["function"].get("arguments") or "{}"))
    except Exception as error:  # an unknown tool or bad arguments: the model sees why
        result = {"error": f"{type(error).__name__}: {error}"}
    return {"role": "tool", "tool_call_id": call["id"], "content": json.dumps(result)}


class ModelError(Exception):
    pass


def complete(messages):
    """One model call: the assistant's message, with any tool calls."""
    if os.environ.get("FAKE_MODEL") == "1":
        return {"role": "assistant", "content": FAKE_REPLY}
    provider = next(((os.environ[env].strip(), base, model) for env, base, model in KEYS if os.environ.get(env, "").strip()), None)
    if not provider:
        raise ModelError(f"No model key: set one of {', '.join(k[0] for k in KEYS)}, or FAKE_MODEL=1")
    key, base, model = provider
    body = {"model": os.environ.get("MODEL", "").strip() or model, "messages": [{"role": "system", "content": SYSTEM}, *messages], "tools": TOOL_DEFS}
    request = Request(base.rstrip("/") + "/chat/completions", json.dumps(body).encode(), {"content-type": "application/json", "authorization": f"Bearer {key}"})
    try:
        with urlopen(request, timeout=50) as response:
            message = json.load(response)["choices"][0]["message"]
    except HTTPError as error:
        raise ModelError(f"The model answered {error.code}: {error.read(200).decode(errors='replace')}") from error
    except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
        raise ModelError(f"The model call failed: {error}") from error
    # Only what the next call needs back (tool calls kept whole: some providers sign them).
    return {"role": "assistant", "content": message.get("content"), **({"tool_calls": message["tool_calls"]} if message.get("tool_calls") else {})}


def person_text(message_id, message):
    """The person's message as the model reads it: its id, then short notes. File bytes stay out."""
    tags = [message_id, *(["tapped"] if message.get("choice") else [])]
    notes = []
    if quoted := message.get("replyTo"):
        notes.append(f'(replying to {"your" if quoted["fromAgent"] else "their own"} message "{quoted["text"]}")')
    for file in message.get("attachments", []):
        kind = {"image": "an image", "audio": "a voice note"}.get(file["kind"], "a document")
        notes.append(f"(sent {kind}{': ' + file['name'] if file.get('name') else ''})")
    return " ".join(part for part in [f"[{', '.join(tags)}]", message["text"], *notes] if part)


# Each conversation's messages, as your agent keeps them per phone number. Chinwag sends one
# conversation's messages one at a time, so a conversation is never in two threads at once.
histories = {}


def turn(conversation_id, text):
    """The model and its tools, up to 5 steps; the last text is the reply."""
    history = histories.setdefault(conversation_id, [])
    history.append({"role": "user", "content": text})
    for _ in range(5):
        message = complete(history)
        history.append(message)
        if not message.get("tool_calls"):
            break
        history.extend(run_tool(call) for call in message["tool_calls"])
    return (message.get("content") or "").strip()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/chinwag":
            return self.answer(404)
        # Set CHINWAG_AGENT_TOKEN on both sides to require it.
        token = os.environ.get("CHINWAG_AGENT_TOKEN")
        if token and self.headers.get("authorization") != f"Bearer {token}":
            return self.answer(401)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
            conversation_id, text = body["conversationId"], person_text(body["messageId"], body["message"])
        except (ValueError, KeyError, TypeError, AttributeError) as error:
            return self.answer(400, f"Bad request: {error}")
        try:
            reply = turn(conversation_id, text)
        except ModelError as error:  # Chinwag fails this turn and shows the reason
            return self.answer(502, str(error))
        self.answer(200, json.dumps({"replies": [{"type": "message", "text": reply}] if reply else []}), "application/json")

    def do_GET(self):
        self.answer(404)

    do_PUT = do_PATCH = do_DELETE = do_GET

    def answer(self, status, body="", content_type="text/plain"):
        data = body.encode()
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    server = ThreadingHTTPServer(("", port), Handler)
    print(f"Listening on http://localhost:{port}/chinwag", flush=True)
    server.serve_forever()
