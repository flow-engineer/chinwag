// Nudges are messages the business starts: sent as written (text), written by the agent (prompt),
// or a template the owner already set up with the channel. What a person asked not to be messaged
// about is the agent's judgement, kept as rules it adds and removes, not a hard stop: a nudge the
// rules cover is not sent. The rules cover only what the business starts, never what the person
// asks for themselves.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store, NoContactRow } from "./store.ts";
import { endOfLocalDay, formatLocal } from "./time.ts";
import { tool, toSpec, type Tool } from "./tools.ts";
import type { Model } from "./types.ts";

export interface NoContactScope {
  store: Store;
  conversationId: string;
  now(): number;
  /** The zone an `until` date is read in. */
  zone(): string;
}

export function noContactTools(scope: NoContactScope): Tool[] {
  return [
    tool({
      name: "add_no_contact",
      description:
        "When they say they do not want to be messaged about something (or at all, or for a while), keep it as a rule, in their words: \"no promotions\", \"nothing before 9am\". Messages the business starts that the rule covers will not be sent. Also cancel their scheduled messages it covers. Not for things they ask for themselves.",
      input: z.object({
        rule: z.string().min(1).max(200),
        until: z.string().optional().describe("YYYY-MM-DD, the last day it applies, when they gave one (\"not this week\")"),
      }),
      run: async ({ rule, until }) => {
        const ends = until ? endOfLocalDay(scope.zone(), until) : null;
        if (until && !ends) return { error: "until must be YYYY-MM-DD." };
        const id = `nc_${randomUUID().slice(0, 6)}`;
        await scope.store.addNoContact(scope.conversationId, id, rule, ends);
        return { added: { id, rule, until: until ?? null } };
      },
    }),
    tool({
      name: "remove_no_contact",
      description: "Remove one of their no-contact rules, by id, when they want those messages again.",
      input: z.object({ id: z.string() }),
      run: async ({ id }) => ({ removed: await scope.store.removeNoContact(scope.conversationId, id) }),
    }),
  ];
}

/** The rules as the agent reads them each turn; empty when there are none. */
export function rulesSection(rules: NoContactRow[], zone: string): string {
  if (!rules.length) return "";
  return [
    "## What they asked not to be messaged about",
    "Messages the business starts (nudges, its scheduled messages) that these cover are not sent. Things they ask for themselves are fine.",
    ...rules.map((r) => `- [${r.id}] ${r.rule}${r.until ? ` (until ${formatLocal(zone, r.until - 1)})` : ""}`),
  ].join("\n");
}

const decision = tool({
  name: "decide",
  description: "Say whether the message may be sent.",
  input: z.object({ send: z.boolean(), rule: z.string().optional().describe("The id of the rule that covers it, when send is false") }),
  run: () => "",
});

/** A fixed-text nudge to a person with rules: one small model call says whether a rule covers it. */
export async function coveredBy(model: Model, rules: NoContactRow[], text: string): Promise<NoContactRow | null> {
  const response = await model.complete({
    system: "A business wants to send this message to a person. The person asked not to be messaged about some things. Decide whether any of their rules covers this message; call decide once.",
    messages: [{ role: "user", content: `Rules:\n${rules.map((r) => `- [${r.id}] ${r.rule}`).join("\n")}\n\nMessage:\n${text}` }],
    tools: [toSpec(decision)],
    signal: new AbortController().signal,
  });
  const call = response.toolCalls.find((c) => c.name === "decide");
  let parsed: { send?: boolean; rule?: string } = {};
  try {
    parsed = JSON.parse(call?.arguments ?? "{}");
  } catch {
    // An unreadable answer sends nothing: a rule the person set is safer kept than broken.
  }
  if (parsed.send === true) return null;
  return rules.find((r) => r.id === parsed.rule) ?? rules[0];
}
