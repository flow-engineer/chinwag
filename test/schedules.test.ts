// covers: src/schedules.ts src/time.ts src/store.ts src/db.ts src/conversation.ts src/agent.ts
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sqlite, type Database } from "../src/index.ts";
import { Store } from "../src/store.ts";
import { claimDue, scheduleTools } from "../src/schedules.ts";
import { SMS, call, last, multi, respond } from "./helpers.ts";

const CHANNELS = { sms: { info: SMS, phone: true } };
const NOON_NY = Date.UTC(2026, 9, 12, 16);
const SAM = "+15550100100";

/** Sam has written once and been answered; the clock is the test's. */
async function withSam(db: Database = sqlite()) {
  const clock = { now: NOON_NY };
  const h = multi({ channels: CHANNELS, database: db, now: () => clock.now, timeZone: "America/New_York" });
  await h.agent.resume();
  const a = await h.message("sms", SAM, "hi");
  (await h.nextCall(0)).answer(respond(call("send_sms", { text: "Hi!" })));
  const conversation = h.agent.conversation(a!.conversationId)!;
  await conversation.whenIdle();
  return { ...h, db, clock, conversationId: a!.conversationId, conversation, store: new Store(db, "default") };
}

const runRows = async (db: Database) => (await db.query("SELECT outcome, reason FROM schedule_runs")).map((r) => ({ ...r }));

test("a schedule that comes due becomes a turn, and its message goes out", async () => {
  const h = await withSam();
  await h.message("sms", SAM, "remind me in an hour to pick up my order");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Will do." }), call("schedule_message", { message: "remind them their order is ready", repeat: "once", in_minutes: 60 })));
  const result = await h.nextCall(2);
  assert.match(last(result.request.messages).content, /"summary":"once, Mon 12 Oct 2026 13:00 \(New York time\)"/);
  result.answer(respond());
  await h.conversation.whenIdle();

  h.clock.now += 61 * 60_000;
  assert.equal(await h.agent.runDue(), 1);
  const turn = await h.nextCall(3);
  assert.match(last(turn.request.messages).content, /^\[Scheduled message, not from the person: .* Do it now: remind them their order is ready\]/);
  turn.answer(respond(call("send_sms", { text: "Your order is ready!" })));
  await h.conversation.whenIdle();
  assert.deepEqual(h.texts("sms").at(-1), "Your order is ready!");
  assert.deepEqual(await runRows(h.db), [{ outcome: "sent", reason: null }]);
  assert.equal(await h.agent.runDue(), 0, "a once is done");
});

test("two runners claim a due run only once", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "chinwag-db-")), "chinwag.db");
  const h = await withSam(sqlite(path));
  await h.store.addSchedule({ id: "s1", conversationId: h.conversationId, channel: "sms", instruction: "check in", fixedText: false, mode: "message", rule: { repeat: "daily", time: "11:00" }, timeZone: "America/New_York", nextRunAt: NOON_NY - 60_000, maxRuns: null, endsOn: null, origin: "person" });
  const other = multi({ channels: CHANNELS, database: sqlite(path), now: () => h.clock.now, dir: h.dir });
  await other.agent.resume();
  const claimed = await Promise.all([h.agent.runDue(), other.agent.runDue()]);
  assert.equal(claimed[0] + claimed[1], 1);
  assert.equal((await runRows(h.db)).length, 1);
});

test("a run found more than 30 minutes late is missed, not sent, and the schedule moves on", async () => {
  const h = await withSam();
  await h.store.addSchedule({ id: "s1", conversationId: h.conversationId, channel: "sms", instruction: "check in", fixedText: false, mode: "message", rule: { repeat: "daily", time: "10:00" }, timeZone: "America/New_York", nextRunAt: NOON_NY - 2 * 3_600_000, maxRuns: null, endsOn: null, origin: "person" });
  assert.equal(await h.agent.runDue(), 0);
  assert.deepEqual((await runRows(h.db)).map((r) => r.outcome), ["missed"]);
  const [s] = await h.store.schedules(h.conversationId);
  assert.equal(s.nextRunAt, Date.UTC(2026, 9, 13, 14), "tomorrow at 10:00 New York time");
  assert.equal(h.calls.length, 1, "no turn for a missed run");
});

test("list and cancel see only this person's schedules", async () => {
  const h = await withSam();
  const other = await h.message("sms", "+15550100200", "hi");
  (await h.nextCall(1)).answer(respond(call("send_sms", { text: "Hi!" })));
  await h.agent.conversation(other!.conversationId)!.whenIdle();
  const base = { channel: "sms", fixedText: false, mode: "message" as const, rule: { repeat: "daily", time: "09:00" }, timeZone: "America/New_York", nextRunAt: NOON_NY + 86_400_000, maxRuns: null, endsOn: null, origin: "person" as const };
  await h.store.addSchedule({ ...base, id: "s_sam", conversationId: h.conversationId, instruction: "sam's" });
  await h.store.addSchedule({ ...base, id: "s_other", conversationId: other!.conversationId, instruction: "theirs" });

  await h.message("sms", SAM, "what have I got scheduled? and cancel s_other");
  (await h.nextCall(2)).answer(respond(call("send_sms", { text: "Checking." }), call("list_scheduled"), call("cancel_scheduled", { id: "s_other" })));
  const results = (await h.nextCall(3)).request.messages.filter((m) => m.role === "tool").slice(-2).map((m) => (m as { content: string }).content);
  assert.match(results[0], /s_sam/);
  assert.doesNotMatch(results[0], /s_other/);
  assert.equal(results[1], '{"cancelled":false}');
  assert.equal((await h.store.schedules(other!.conversationId)).length, 1);
});

test("a check with nothing to report sends nothing and is recorded as quiet", async () => {
  const h = await withSam();
  await h.store.addSchedule({ id: "s1", conversationId: h.conversationId, channel: "sms", instruction: "tell them if a slot opens on Friday", fixedText: false, mode: "check", rule: { repeat: "daily", time: "12:00" }, timeZone: "America/New_York", nextRunAt: NOON_NY, maxRuns: null, endsOn: null, origin: "person" });
  assert.equal(await h.agent.runDue(), 1);
  const turn = await h.nextCall(1);
  assert.match(last(turn.request.messages).content, /^\[Scheduled check, not from the person/);
  turn.answer(respond());
  await h.conversation.whenIdle();
  assert.equal(h.calls.length, 2, "no reminder to reply after a quiet check");
  assert.deepEqual(h.texts("sms"), ["Hi!"]);
  assert.deepEqual(await runRows(h.db), [{ outcome: "quiet", reason: null }]);
});

test("saying nothing after a tool's result is left alone: silence may be the answer", async () => {
  const h = await withSam();
  await h.store.addSchedule({ id: "s1", conversationId: h.conversationId, channel: "sms", instruction: "tell them if a slot opens on Friday", fixedText: false, mode: "check", rule: { repeat: "daily", time: "12:00" }, timeZone: "America/New_York", nextRunAt: NOON_NY, maxRuns: null, endsOn: null, origin: "person" });
  const before = h.followUps.length;
  assert.equal(await h.agent.runDue(), 1);
  (await h.nextCall(1)).answer(respond(call("list_scheduled")));
  (await h.nextCall(2)).answer(respond());
  await h.conversation.whenIdle();
  assert.equal(h.followUps.length, before, "no reminder after the result");
  assert.deepEqual(await runRows(h.db), [{ outcome: "quiet", reason: null }]);
});

test("the scheduling tool refuses what would go wrong, with a reason the agent can act on", async () => {
  const store = new Store(sqlite(), "default");
  await store.migrate();
  let zone: string | null = null;
  const scope = { store, conversationId: "c1", channel: () => "sms", now: () => NOON_NY, personZone: () => zone, setPersonZone: async (z: string) => void (zone = z) };
  const [schedule] = scheduleTools(scope);
  const run = (input: Record<string, unknown>) => Promise.resolve(schedule.run(schedule.input.parse(input), { conversationId: "c1", person: "p", channel: "sms" })) as Promise<Record<string, any>>;
  const daily = { message: "check in", repeat: "daily", time: "09:00" };

  assert.match((await run(daily)).error, /^timezone_needed/, "no zone known: ask their city");
  assert.match((await run({ ...daily, timezone: "UTC" })).error, /^timezone_needed/, "a bare UTC says nothing about where they are");
  assert.match((await run({ ...daily, timezone: "Mars/Olympus" })).error, /not a time zone/);
  zone = "America/New_York";
  assert.match((await run({ message: "x", repeat: "once", time: "11:00", date: "2026-10-12" })).error, /already past/);
  assert.match((await run({ ...daily, until: "2026-10-01" })).error, /until is before the first run/);
  assert.ok((await run(daily)).scheduled);
  assert.match((await run({ ...daily, message: "Check  IN" })).error, /^already_scheduled/, "the same message at about the same time");
  for (let i = 0; i < 9; i++) await run({ ...daily, message: `reminder ${i}` });
  assert.match((await run({ ...daily, message: "one too many" })).error, /already have 10/);
});

test("a repeat ends after its number of runs, or at its until date", async () => {
  const store = new Store(sqlite(), "default");
  await store.migrate();
  const base = { conversationId: "c1", channel: "sms", instruction: "check in", fixedText: false, mode: "message" as const, rule: { repeat: "daily", time: "09:00" }, timeZone: "America/New_York", endsOn: null, origin: "person" as const };
  const nineNY = Date.UTC(2026, 9, 13, 13);
  await store.addSchedule({ ...base, id: "twice", nextRunAt: nineNY, maxRuns: 2 });
  await store.addSchedule({ ...base, id: "until", nextRunAt: nineNY, maxRuns: null, endsOn: "2026-10-14" });
  for (const day of [0, 1, 2]) await claimDue(store, nineNY + day * 86_400_000, async () => null);
  const left = await store.db.query("SELECT id, status, run_count FROM schedules ORDER BY id");
  assert.deepEqual(left.map((r) => ({ ...r })), [
    { id: "twice", status: "done", run_count: 2 },
    { id: "until", status: "done", run_count: 2 },
  ]);
});
