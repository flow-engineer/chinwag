// Nudges are messages the business starts: sent as written (text), written by the agent (prompt),
// or a template the owner already set up with the channel. What a person asked not to be messaged
// about is the agent's judgement, kept as rules it adds and removes: a message the business starts
// that the rules cover is not sent. The rules cover only what the business starts, never what the
// person asks for themselves. A channel's STOP keyword is different: a hard rule, written without
// the model, that stops everything the business starts until they text START (channels.ts).

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NoContactRow, QuietHours, StoreApi } from "./store.ts";
import { clock, endOfLocalDay, formatLocal } from "./time.ts";
import { tool, toSpec, type Tool } from "./tools.ts";
import type { Model, ModelResponse } from "./types.ts";

export interface NoContactScope {
  store: StoreApi;
  conversationId: string;
  now(): number;
  /** Their zone, once known: an `until` date is read in it. */
  zone(): string | null;
  setQuietHours(hours: QuietHours | "off" | null): Promise<void>;
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
        // Their zone unknown, the day ends where it ends last (UTC-12): the rule never lifts early.
        const ends = until ? endOfLocalDay(scope.zone() ?? "Etc/GMT+12", until) : null;
        if (until && !ends) return { error: "until must be YYYY-MM-DD." };
        const id = `nc_${randomUUID().slice(0, 6)}`;
        await scope.store.addNoContact(scope.conversationId, id, rule, ends);
        return { added: { id, rule, until: until ?? null } };
      },
    }),
    tool({
      name: "pause_messages",
      description: "When they want nothing at all from the business for a while (\"no messages this week\", \"pause until Monday\"): nothing it starts goes until that day ends. Remove it with remove_no_contact.",
      input: z.object({ until: z.string().describe("YYYY-MM-DD, the last day of the pause") }),
      run: async ({ until }) => {
        const ends = endOfLocalDay(scope.zone() ?? "Etc/GMT+12", until);
        if (!ends) return { error: "until must be YYYY-MM-DD." };
        if (ends <= scope.now()) return { error: "That day is already over." };
        const id = `nc_${randomUUID().slice(0, 6)}`;
        await scope.store.addNoContact(scope.conversationId, id, `pause: nothing the business starts until ${until} is over`, ends, "pause");
        return { paused: { id, until } };
      },
    }),
    tool({
      name: "set_quiet_hours",
      description: "When they say when not to be messaged by the clock (\"not after 9pm\", \"nothing before 8\"): their quiet hours, in their own time, when what the business starts waits. off: none at all; default: back to the usual ones.",
      input: z.object({
        from: z.string().optional().describe("HH:MM their time, when quiet starts"),
        to: z.string().optional().describe("HH:MM their time, when it ends"),
        set: z.enum(["hours", "off", "default"]).describe("hours: from and to; off: no quiet hours; default: the usual ones"),
      }),
      run: async ({ from, to, set }) => {
        if (set !== "hours") {
          await scope.setQuietHours(set === "off" ? "off" : null);
          return { quiet_hours: set };
        }
        if (!from || !to || !clock(from) || !clock(to)) return { error: "from and to are HH:MM, such as 21:00 and 08:00." };
        await scope.setQuietHours({ from, to });
        return { quiet_hours: { from, to }, ...(scope.zone() ? {} : { note: "Their time zone is not known, so these apply once it is: ask where they are." }) };
      },
    }),
    tool({
      name: "remove_no_contact",
      description: "Remove one of their no-contact rules, by id, when they want those messages again.",
      input: z.object({ id: z.string() }),
      run: async ({ id }) => {
        const rule = (await scope.store.noContact(scope.conversationId, scope.now())).find((r) => r.id === id);
        if (rule?.hard) return { error: "That is their STOP: it ends only when they text START." };
        return { removed: await scope.store.removeNoContact(scope.conversationId, id) };
      },
    }),
  ];
}

/** The rules as the agent reads them each turn; empty when there are none. */
export function rulesSection(rules: NoContactRow[], zone: string, quiet: QuietHours | null = null): string {
  if (!rules.length && !quiet) return "";
  return [
    "## When and what not to message them",
    "Messages the business starts (nudges, its scheduled messages) that these cover are not sent. Things they ask for themselves are fine.",
    ...(quiet ? [`- Quiet hours: ${quiet.from} to ${quiet.to}, their time: what the business starts waits until they end (set_quiet_hours changes them).`] : []),
    ...rules.map((r) => `- [${r.id}] ${r.rule}${r.until ? ` (until ${formatLocal(zone, r.until - 1)})` : ""}`),
  ].join("\n");
}

const decision = tool({
  name: "decide",
  description: "Say whether the message may be sent.",
  input: z.object({ send: z.boolean(), rule: z.string().optional().describe("The id of the rule that covers it, when send is false") }),
  run: () => "",
});

/**
 * A fixed-text message the business starts, to a person with rules: one small model call says
 * whether a rule covers it. Rejects when the model does; the caller sends nothing then.
 */
export async function coveredBy(model: Model, rules: NoContactRow[], text: string): Promise<{ rule: NoContactRow | null; usage?: ModelResponse["usage"]; model?: string }> {
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
  const said = { usage: response.usage, model: response.model };
  if (parsed.send === true) return { rule: null, ...said };
  return { rule: rules.find((r) => r.id === parsed.rule) ?? rules[0], ...said };
}
