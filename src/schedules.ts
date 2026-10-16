// Scheduled messages: an agent never runs timers. A
// schedule is a row; when it comes due, a runner moves it on and writes an inbox event in one
// transaction (so it runs once, even with several runners), and the conversation wakes like it
// does for any message. The agent then writes the message with fresh data. Times are the
// person's local time, never UTC (see time.ts).

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NewSchedule, ScheduleRow, StoreApi } from "./store.ts";
import { DAY_INDEX, clock, date, describe, endOfLocalDay, formatLocal, isBareUtc, localDate, localToUtc, nextRun, parts, validZone, type Rule } from "./time.ts";
import { tool, type Tool } from "./tools.ts";

export const LIMITS = {
  /** Active schedules one person may have. */
  perPerson: 10,
  /** The same message to the same person at least this far apart. */
  sameMessageGapMs: 60 * 60_000,
  /** A run found later than this after its time is missed, not sent late. */
  lateMs: 30 * 60_000,
  maxAheadMs: 366 * 86_400_000,
};

/** What the schedule tools need from the conversation they run in. */
export interface ScheduleScope {
  store: StoreApi;
  conversationId: string;
  /** The channel of the person's latest message, where a schedule's messages will go. */
  channel(): string;
  now(): number;
  /** The person's zone, once known. */
  personZone(): string | null;
  setPersonZone(zone: string): Promise<void>;
  /** The agent's own zone (the business's), if set: only for "in N minutes", which needs no one's clock. */
  agentZone?: string;
}

const scheduleInput = z.object({
  message: z.string().min(1).max(500).describe("What to do at that time, written for yourself (\"send today's specials\"), not the finished text"),
  repeat: z.enum(["once", "daily", "weekly", "monthly", "hourly"]),
  time: z.string().optional().describe("HH:MM in their local time"),
  date: z.string().optional().describe("once: YYYY-MM-DD; leave it out for the next time the clock shows `time`"),
  in_minutes: z.number().int().min(1).max(525_600).optional().describe("once: this many minutes from now, instead of time and date"),
  days: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).optional().describe("weekly, or hourly on some days only"),
  day_of_month: z.union([z.number().int().min(1).max(31), z.literal("last")]).optional().describe("monthly: 1 to 31 (a shorter month uses its last day), or \"last\""),
  every_hours: z.number().int().min(1).max(23).optional().describe("hourly: every this many hours"),
  from: z.string().optional().describe("hourly: HH:MM, the first run of the day"),
  to: z.string().optional().describe("hourly: HH:MM, the last run of the day"),
  until: z.string().optional().describe("Repeats: YYYY-MM-DD, the last day it may run"),
  times: z.number().int().min(1).max(1000).optional().describe("Repeats: how many runs in all"),
  timezone: z.string().optional().describe("An IANA zone, only when they named a place; leave it out otherwise"),
  respect_quiet_hours: z.boolean().optional().describe("true for checks and updates that can wait for the morning (\"check for new listings and let me know\"); leave it out when they asked for that time, or for every hour"),
  mode: z.enum(["message", "check"]).optional().describe("check: at that time, look, and message them only if there is something to tell"),
});

export function scheduleTools(scope: ScheduleScope): Tool[] {
  return [
    tool({
      name: "schedule_message",
      description:
        "Message this person later, once or repeatedly, when they ask for a reminder or a regular message. Confirm vague times first (\"end of the month\" is the last day). Tell them plainly what you scheduled, with its time as the result gives it.",
      input: scheduleInput,
      run: (input) => create(scope, input),
    }),
    tool({
      name: "list_scheduled",
      description: "This person's scheduled messages that are still active.",
      input: z.object({}),
      run: async () => ({ scheduled: (await scope.store.schedules(scope.conversationId)).map(summary) }),
    }),
    tool({
      name: "cancel_scheduled",
      description: "Cancel one of this person's scheduled messages, by its id from list_scheduled.",
      input: z.object({ id: z.string() }),
      run: async ({ id }) => ({ cancelled: await scope.store.cancelSchedule(scope.conversationId, id) }),
    }),
  ];
}

export function summary(s: ScheduleRow) {
  const ends = [s.endsOn ? `until ${s.endsOn}` : "", s.maxRuns ? `${s.maxRuns} times in all` : ""].filter(Boolean).join(", ");
  return {
    id: s.id,
    message: s.instruction,
    mode: s.mode,
    summary: describe(s.rule as Rule, s.timeZone) + (ends ? `, ${ends}` : ""),
    next_run: s.nextRunAt ? formatLocal(s.timeZone, s.nextRunAt) : null,
  };
}

/**
 * The zone a schedule uses: the one named (never a bare UTC), else the person's. Their zone is never
 * guessed from the business's: only "in N minutes", which is the same in every zone, goes ahead
 * without it (shown in the business's time).
 */
async function zoneFor(scope: ScheduleScope, named?: string, relative = false): Promise<string | { error: string }> {
  if (named && !isBareUtc(named)) {
    if (!validZone(named)) return { error: `${named} is not a time zone. Use an IANA name such as America/New_York.` };
    await scope.setPersonZone(named);
    return named;
  }
  const known = scope.personZone() ?? (relative ? (scope.agentZone ?? "UTC") : null);
  if (known) return known;
  return { error: "timezone_needed: you do not know their time zone. Ask which city they are in, then schedule again with timezone." };
}

async function create(scope: ScheduleScope, input: z.infer<typeof scheduleInput>) {
  const zone = await zoneFor(scope, input.timezone, input.repeat === "once" && input.in_minutes !== undefined);
  if (typeof zone !== "string") return zone;
  const now = scope.now();
  const rule = ruleOf(input, zone, now);
  if ("error" in rule) return rule;
  const repeats = rule.repeat !== "once";
  if (!repeats && (input.until || input.times)) return { error: "until and times are only for repeats." };
  const next = rule.repeat === "once" ? rule.at : nextRun(rule, zone, now);
  if (!next) return { error: "That never comes due. Check the time and days." };
  if (next < now + 60_000) return { error: "That time is less than a minute away or already past. Pick a later one." };
  if (next > now + LIMITS.maxAheadMs) return { error: "That is more than a year ahead." };
  if (input.until) {
    if (!date(input.until)) return { error: "until must be YYYY-MM-DD." };
    if (input.until < localDate(zone, next)) return { error: "until is before the first run." };
  }

  const active = await scope.store.schedules(scope.conversationId);
  if (active.length >= LIMITS.perPerson) return { error: `They already have ${LIMITS.perPerson} scheduled messages. Cancel one first.` };
  const same = active.find((s) => normalize(s.instruction) === normalize(input.message) && s.nextRunAt !== null && Math.abs(s.nextRunAt - next) < LIMITS.sameMessageGapMs);
  if (same) return { error: "already_scheduled: the same message is already scheduled at about that time.", scheduled: summary(same) };

  const row = {
    id: `s_${randomUUID().slice(0, 8)}`,
    conversationId: scope.conversationId,
    channel: scope.channel(),
    instruction: input.message,
    fixedText: false,
    mode: input.mode ?? "message",
    rule: input.respect_quiet_hours ? { ...rule, quiet: true } : rule,
    timeZone: zone,
    nextRunAt: next,
    maxRuns: input.times ?? null,
    endsOn: input.until ?? null,
    origin: "person" as const,
  };
  await scope.store.addSchedule(row);
  const [saved] = (await scope.store.schedules(scope.conversationId)).filter((s) => s.id === row.id);
  return { scheduled: summary(saved), now: formatLocal(zone, now) };
}

function ruleOf(input: z.infer<typeof scheduleInput>, zone: string, now: number): Rule | { error: string } {
  const time = input.time ? clock(input.time) : null;
  if (input.time && !time) return { error: "time must be HH:MM." };
  if (input.day_of_month !== undefined && input.repeat !== "monthly") return { error: "day_of_month is only for monthly." };
  switch (input.repeat) {
    case "once": {
      if (input.in_minutes) return { repeat: "once", at: Math.ceil((now + input.in_minutes * 60_000) / 60_000) * 60_000 };
      if (!time) return { error: "once needs time (and date), or in_minutes." };
      if (input.date) {
        const d = date(input.date);
        if (!d) return { error: "date must be YYYY-MM-DD." };
        return { repeat: "once", at: localToUtc(zone, d.year, d.month, d.day, time.hour, time.minute) };
      }
      const today = parts(zone, now);
      let at = localToUtc(zone, today.year, today.month, today.day, time.hour, time.minute);
      if (at <= now) {
        const t = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
        at = localToUtc(zone, t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), time.hour, time.minute);
      }
      return { repeat: "once", at };
    }
    case "daily":
      return time ? { repeat: "daily", time: input.time! } : { error: "daily needs time." };
    case "weekly":
      if (!time || !input.days?.length) return { error: "weekly needs time and days." };
      return { repeat: "weekly", time: input.time!, days: input.days.map((d) => DAY_INDEX[d]) };
    case "monthly":
      if (!time || input.day_of_month === undefined) return { error: "monthly needs time and day_of_month." };
      return { repeat: "monthly", time: input.time!, day: input.day_of_month };
    case "hourly": {
      if ((input.from && !clock(input.from)) || (input.to && !clock(input.to))) return { error: "from and to must be HH:MM." };
      return { repeat: "hourly", every: input.every_hours ?? 1, from: input.from, to: input.to, days: input.days?.map((d) => DAY_INDEX[d]) };
    }
  }
}

/** A scheduled message from the business (a nudge with a time): fixed text, or an instruction. */
export function businessSchedule(conversationId: string, channel: string, at: number, zone: string, body: { text?: string; prompt?: string }, quiet = true): NewSchedule {
  return {
    id: `s_${randomUUID().slice(0, 8)}`,
    conversationId,
    channel,
    instruction: body.text ?? body.prompt ?? "",
    fixedText: body.text !== undefined,
    mode: "message",
    rule: quiet ? { repeat: "once", at, quiet: true } : { repeat: "once", at },
    timeZone: zone,
    nextRunAt: at,
    maxRuns: null,
    endsOn: null,
    origin: "api",
  };
}

/** What one due run becomes in the conversation's inbox. */
export interface DueRun {
  run: string;
  schedule: string;
  channel: string;
  mode: ScheduleRow["mode"];
  fixed: boolean;
  text: string;
}

/**
 * Claims every due schedule once: a run found too late is missed (and the schedule moves past
 * now, so nothing floods after downtime), one `blocked` names a reason is skipped, the rest are
 * queued for their conversation. Returns the queued runs with their inbox ids.
 */
/**
 * Claims the schedules due at `now`. One marked `quiet` that comes due in the person's quiet hours
 * (`quietEnd` says when they end) waits: a once moves to their end, a repeat skips that run.
 */
export async function claimDue(store: StoreApi, now: number, quietEnd: (s: ScheduleRow) => Promise<number | null>, blocked: (s: ScheduleRow) => Promise<string | null>): Promise<Array<{ conversationId: string; inbox: number; run: DueRun }>> {
  const queued: Array<{ conversationId: string; inbox: number; run: DueRun }> = [];
  for (const s of await store.dueSchedules(now)) {
    const due = s.nextRunAt!;
    const late = now - due > LIMITS.lateMs;
    const rule = s.rule as Rule;
    let nextAt = nextRun(rule, s.timeZone, late ? now : due);
    if (s.maxRuns && s.runCount + 1 >= s.maxRuns) nextAt = null;
    if (nextAt && s.endsOn && nextAt >= (endOfLocalDay(s.timeZone, s.endsOn) ?? Infinity)) nextAt = null;
    const next = { nextRunAt: nextAt, status: (nextAt ? "active" : "done") as ScheduleRow["status"] };
    const runId = `r_${randomUUID().slice(0, 8)}`;
    if (late) {
      const minutes = Math.round((now - due) / 60_000);
      await store.claimRun(s, next, { id: runId, outcome: "missed", reason: `found ${minutes} minutes after its time; not sent late`, ranAt: now });
      continue;
    }
    const ends = (s.rule as { quiet?: boolean }).quiet ? await quietEnd(s) : null;
    if (ends !== null) {
      const held = rule.repeat === "once";
      await store.claimRun(s, held ? { nextRunAt: ends, status: "active" } : next, { id: runId, outcome: held ? "held" : "skipped", reason: held ? `their quiet hours: moved to ${formatLocal(s.timeZone, ends)}` : "their quiet hours", ranAt: now });
      continue;
    }
    const reason = await blocked(s);
    if (reason) {
      await store.claimRun(s, next, { id: runId, outcome: "skipped", reason, ranAt: now });
      continue;
    }
    const run: DueRun = { run: runId, schedule: s.id, channel: s.channel, mode: s.mode, fixed: s.fixedText, text: s.fixedText ? s.instruction : noteFor(s) };
    const inbox = await store.claimRun(s, next, { id: runId, outcome: "queued", ranAt: now }, { ...run });
    if (inbox) queued.push({ conversationId: s.conversationId, inbox, run });
  }
  return queued;
}

/** The note the agent's turn starts with when a schedule comes due. */
function noteFor(s: ScheduleRow): string {
  const when = describe(s.rule as Rule, s.timeZone);
  if (s.origin === "api") return `[Nudge from the business, not from the person, scheduled earlier: ${s.instruction}] Write it to them now in your own words, or send nothing if it does not fit what they asked not to be messaged about.`;
  if (s.mode === "check") return `[Scheduled check, not from the person: they asked you to check ${when}: ${s.instruction}] Look now. Message them only if there is something to tell; otherwise send nothing.`;
  return `[Scheduled message, not from the person: they asked you to message them ${when}. Do it now: ${s.instruction}] Write that message to them now.`;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
