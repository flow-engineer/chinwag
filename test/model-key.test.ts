// covers: src/model.ts
// The agent's model key: the first of OpenRouter, OpenAI, Anthropic and Gemini that has a value,
// with MODEL overriding that provider's default id. A blank line is no key.
import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFromKeys } from "../src/model.ts";

test("the first key with a value picks the provider, and MODEL overrides its default", () => {
  assert.deepEqual(modelFromKeys({}), { baseURL: "https://openrouter.ai/api/v1", model: "anthropic/claude-haiku-5.5" });
  assert.deepEqual(modelFromKeys({ OPENAI_API_KEY: "sk-openai" }), { apiKey: "sk-openai", baseURL: "https://api.openai.com/v1", model: "gpt-6-luna" });
  assert.deepEqual(modelFromKeys({ ANTHROPIC_API_KEY: "sk-ant" }), { apiKey: "sk-ant", baseURL: "https://api.anthropic.com/v1/", model: "claude-haiku-5-5" });
  assert.deepEqual(modelFromKeys({ GEMINI_API_KEY: "gem" }), { apiKey: "gem", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3.8-flash" });
  assert.equal(modelFromKeys({ OPENAI_API_KEY: "sk-openai", MODEL: "gpt-6.1-sol" }).model, "gpt-6.1-sol");
  assert.equal(modelFromKeys({ OPENROUTER_API_KEY: "sk-or", OPENAI_API_KEY: "sk-openai" }).baseURL, "https://openrouter.ai/api/v1");
  assert.equal(modelFromKeys({ OPENROUTER_API_KEY: "  ", OPENAI_API_KEY: "sk-openai" }).apiKey, "sk-openai");
});
