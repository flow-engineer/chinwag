// covers: src/skills.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/index.ts";
import { WEB, call, last, respond, say, scriptedModel } from "./helpers.ts";

test("an agent whose folder or AGENTS.md can't be read throws, naming the path, instead of running with no prompt", () => {
  const { model } = scriptedModel();
  const missing = join(tmpdir(), "chinwag-no-such-folder", "agent");
  assert.throws(() => createAgent({ dir: missing, model }), {
    message: `chinwag: can't read the agent's prompt: ${missing} does not exist. Check createAgent's dir; on a host with no file system (a bundle, an edge runtime), pass files instead.`,
  });
  const empty = mkdtempSync(join(tmpdir(), "chinwag-"));
  assert.throws(() => createAgent({ dir: empty, model }), (error: Error) => error.message.startsWith(`chinwag: can't read the agent's prompt: ${empty} has no AGENTS.md.`));
});

test("skills are listed, and load only when the agent asks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chinwag-"));
  writeFileSync(join(dir, "AGENTS.md"), "Base.");
  mkdirSync(join(dir, "skills", "booking"), { recursive: true });
  writeFileSync(join(dir, "skills", "booking", "SKILL.md"), "---\nname: booking\ndescription: moving sessions\n---\nOffer three slots.");
  const scripted = scriptedModel();
  const agent = createAgent({ dir, model: scripted.model, debounceMs: 0 });
  agent.receive("c12", "reschedule please", () => {}, { channel: WEB });
  const first = await scripted.nextCall(0);
  assert.match(first.request.system, /booking: moving sessions/);
  assert.doesNotMatch(first.request.system, /Offer three slots/);
  first.answer(respond(say("Let me look."), call("load_skill", { name: "booking" })));
  const second = await scripted.nextCall(1);
  assert.equal(last(second.request.messages).content, "Offer three slots.");
  second.answer(respond(say("Here are three times.")));
  await agent.conversation("c12")!.whenIdle();
});
