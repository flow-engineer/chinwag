// covers: src/model.ts
// The agent's model key: the first of OpenRouter, OpenAI, Anthropic and Gemini that has a value,
// with MODEL overriding that provider's default id. A blank line is no key, and no key at all fails
// when the model is made, naming the variables, not on the first message, unless a base URL is named
// (a local server needs no key).
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFromKeys, openAICompatible } from "../src/model.ts";

test("the first key with a value picks the provider, and MODEL overrides its default", () => {
  assert.deepEqual(modelFromKeys({}), { baseURL: "https://openrouter.ai/api/v1", model: "anthropic/claude-haiku-5.5" });
  assert.deepEqual(modelFromKeys({ OPENAI_API_KEY: "sk-openai" }), { apiKey: "sk-openai", baseURL: "https://api.openai.com/v1", model: "gpt-6-luna" });
  assert.deepEqual(modelFromKeys({ ANTHROPIC_API_KEY: "sk-ant" }), { apiKey: "sk-ant", baseURL: "https://api.anthropic.com/v1/", model: "claude-haiku-5-5" });
  assert.deepEqual(modelFromKeys({ GEMINI_API_KEY: "gem" }), { apiKey: "gem", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3.8-flash" });
  assert.equal(modelFromKeys({ OPENAI_API_KEY: "sk-openai", MODEL: "gpt-6.1-sol" }).model, "gpt-6.1-sol");
  assert.equal(modelFromKeys({ OPENROUTER_API_KEY: "sk-or", OPENAI_API_KEY: "sk-openai" }).baseURL, "https://openrouter.ai/api/v1");
  assert.equal(modelFromKeys({ OPENROUTER_API_KEY: "  ", OPENAI_API_KEY: "sk-openai" }).apiKey, "sk-openai");
});

test("with no key and no base URL the model fails when it is made, naming every variable it reads", () => {
  const names = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"];
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  try {
    assert.throws(() => openAICompatible(), { message: "No model key: set one of OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY (in the agent's .env), or pass apiKey, or baseURL for a server that needs none." });
    assert.doesNotThrow(() => openAICompatible({ apiKey: "k" }));
    assert.doesNotThrow(() => openAICompatible({ baseURL: "http://127.0.0.1:11434/v1" }));
  } finally {
    for (const [name, value] of saved) if (value !== undefined) process.env[name] = value;
  }
});
