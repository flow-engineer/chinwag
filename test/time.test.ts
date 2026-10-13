// covers: src/time.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, formatLocal, localToUtc, nextRun, type Rule } from "../src/time.ts";

const runs = (rule: Rule, zone: string, from: number, count: number) => {
  const out: string[] = [];
  let at = from;
  for (let i = 0; i < count; i++) out.push(formatLocal(zone, (at = nextRun(rule, zone, at)!)));
  return out;
};

test("repeat rules come due at the right local times", () => {
  const kolkata = "Asia/Kolkata";
  const jan15 = Date.UTC(2027, 0, 15);
  assert.deepEqual(runs({ repeat: "monthly", time: "09:00", day: "last" }, kolkata, jan15, 3), [
    "Sun 31 Jan 2027 09:00 (Kolkata time)",
    "Sun 28 Feb 2027 09:00 (Kolkata time)",
    "Wed 31 Mar 2027 09:00 (Kolkata time)",
  ]);
  assert.deepEqual(runs({ repeat: "monthly", time: "09:00", day: 31 }, kolkata, Date.UTC(2027, 1, 1), 1), ["Sun 28 Feb 2027 09:00 (Kolkata time)"]);
  assert.deepEqual(runs({ repeat: "weekly", time: "08:00", days: [1, 4] }, kolkata, jan15, 3), [
    "Mon 18 Jan 2027 08:00 (Kolkata time)",
    "Thu 21 Jan 2027 08:00 (Kolkata time)",
    "Mon 25 Jan 2027 08:00 (Kolkata time)",
  ]);
  // 14:00 UTC is 19:30 in Kolkata: the window's last run today, then tomorrow's first.
  assert.deepEqual(runs({ repeat: "hourly", every: 3, from: "09:00", to: "21:00" }, kolkata, Date.UTC(2026, 9, 12, 14), 3), [
    "Mon 12 Oct 2026 21:00 (Kolkata time)",
    "Tue 13 Oct 2026 09:00 (Kolkata time)",
    "Tue 13 Oct 2026 12:00 (Kolkata time)",
  ]);
});

test("07:00 stays 07:00 across a daylight-saving change, and the zone is named, never UTC", () => {
  const ny = "America/New_York";
  const daily: Rule = { repeat: "daily", time: "07:00" };
  assert.deepEqual(runs(daily, ny, Date.UTC(2026, 9, 31, 12), 2), ["Sun 1 Nov 2026 07:00 (New York time)", "Mon 2 Nov 2026 07:00 (New York time)"]);
  // A time the clocks skip runs the same distance after the jump; one that happens twice, the first time.
  assert.equal(formatLocal(ny, localToUtc(ny, 2026, 3, 8, 2, 30)), "Sun 8 Mar 2026 03:30 (New York time)");
  assert.equal(new Date(localToUtc(ny, 2026, 11, 1, 1, 30)).toISOString(), "2026-11-01T05:30:00.000Z");
  assert.equal(describe(daily, ny), "every day at 07:00 (New York time)");
  assert.doesNotMatch(describe({ repeat: "weekly", time: "08:00", days: [1, 2, 3, 4, 5] }, ny), /UTC/);
});
