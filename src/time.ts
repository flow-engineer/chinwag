// Local time for scheduled messages, with the platform's own time zone data (Intl), no library.
// A person is only ever told local time, with the zone named ("07:00 (Kolkata time)"), never UTC.
// Times are wall-clock times in the zone, so 07:00 stays 07:00 across daylight saving; a time the
// clocks skip runs the same distance after the jump (02:30 becomes 03:30), and a time that happens
// twice runs the first time.

export type Rule =
  | { repeat: "once"; at: number }
  | { repeat: "daily"; time: string }
  /** days: 0 is Sunday. */
  | { repeat: "weekly"; time: string; days: number[] }
  | { repeat: "monthly"; time: string; day: number | "last" }
  /** Every `every` hours from `from` to `to` (local, inclusive), on `days` if given. */
  | { repeat: "hourly"; every: number; from?: string; to?: string; days?: number[] };

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 is Sunday. */
  weekday: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

export function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** UTC given as a zone says nothing about where the person is, so it is never taken as theirs. */
export function isBareUtc(zone: string): boolean {
  return /^(etc\/)?(utc|gmt|uct|zulu|universal|greenwich)([+-]?0)?$/i.test(zone.trim());
}

export function parts(zone: string, ms: number): LocalParts {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    formats.set(zone, format);
  }
  const p = Object.fromEntries(format.formatToParts(ms).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: WEEKDAYS.indexOf(p.weekday) };
}

/** The UTC instant of a local wall-clock time in `zone`. */
export function localToUtc(zone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (ms: number) => {
    const p = parts(zone, ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60_000) * 60_000;
  };
  const candidates = [...new Set([guess - offset(guess - DAY_MS), guess - offset(guess + DAY_MS)])];
  const matching = candidates.filter((c) => {
    const p = parts(zone, c);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  });
  return matching.length ? Math.min(...matching) : Math.max(...candidates);
}

/** "HH:MM" as hours and minutes, or null when it is not a time. */
export function clock(time: string): { hour: number; minute: number } | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  return m ? { hour: +m[1], minute: +m[2] } : null;
}

/** "YYYY-MM-DD" as numbers, or null. */
export function date(text: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 ? { year: +m[1], month: +m[2], day: +m[3] } : null;
}

export function localDate(zone: string, ms: number): string {
  const p = parts(zone, ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The first instant after the local day `text` ends. */
export function endOfLocalDay(zone: string, text: string): number | null {
  const d = date(text);
  if (!d) return null;
  const next = new Date(Date.UTC(d.year, d.month - 1, d.day + 1));
  return localToUtc(zone, next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
}

/** The next time `rule` comes due strictly after `after`, or null when it never does again. */
export function nextRun(rule: Rule, zone: string, after: number): number | null {
  if (rule.repeat === "once") return rule.at > after ? rule.at : null;
  const start = parts(zone, after);
  for (let k = 0; k <= 400; k++) {
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + k));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const weekday = d.getUTCDay();
    for (const t of timesOn(rule, year, month, day, weekday)) {
      const at = localToUtc(zone, year, month, day, t.hour, t.minute);
      if (at > after) return at;
    }
  }
  return null;
}

/** The local times `rule` runs at on one day, earliest first. */
function timesOn(rule: Exclude<Rule, { repeat: "once" }>, year: number, month: number, day: number, weekday: number): Array<{ hour: number; minute: number }> {
  if (rule.repeat === "hourly") {
    if (rule.days?.length && !rule.days.includes(weekday)) return [];
    const from = clock(rule.from ?? "00:00")!;
    const to = clock(rule.to ?? "23:59")!;
    const out: Array<{ hour: number; minute: number }> = [];
    for (let minutes = from.hour * 60 + from.minute; minutes <= to.hour * 60 + to.minute; minutes += rule.every * 60) {
      out.push({ hour: Math.floor(minutes / 60), minute: minutes % 60 });
    }
    return out;
  }
  const t = clock(rule.time)!;
  if (rule.repeat === "weekly" && !rule.days.includes(weekday)) return [];
  if (rule.repeat === "monthly") {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const target = rule.day === "last" ? last : Math.min(rule.day, last);
    if (day !== target) return [];
  }
  return [t];
}

/** "Kolkata time", "New York time"; "UTC" for UTC itself. */
export function zoneLabel(zone: string): string {
  if (isBareUtc(zone)) return "UTC";
  const city = zone.split("/").at(-1)!.replaceAll("_", " ");
  return `${city} time`;
}

/** "Mon 12 Oct 2026 19:00 (New York time)". */
export function formatLocal(zone: string, ms: number): string {
  const p = parts(zone, ms);
  const hhmm = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]} ${p.year} ${hhmm} (${zoneLabel(zone)})`;
}

/** What a rule does, in words, with its zone named. */
export function describe(rule: Rule, zone: string): string {
  const label = zoneLabel(zone);
  if (rule.repeat === "once") return `once, ${formatLocal(zone, rule.at)}`;
  if (rule.repeat === "daily") return `every day at ${rule.time} (${label})`;
  if (rule.repeat === "weekly") {
    const days = rule.days.length === 5 && [1, 2, 3, 4, 5].every((d) => rule.days.includes(d)) ? "weekday" : list(rule.days.map((d) => DAY_NAMES[d]));
    return `every ${days} at ${rule.time} (${label})`;
  }
  if (rule.repeat === "monthly") return `${rule.day === "last" ? "on the last day" : `on day ${rule.day}`} of every month at ${rule.time} (${label})`;
  const window = rule.from || rule.to ? ` from ${rule.from ?? "00:00"} to ${rule.to ?? "23:59"}` : "";
  const days = rule.days?.length ? ` on ${list(rule.days.map((d) => DAY_NAMES[d]))}` : "";
  return `every ${rule.every === 1 ? "hour" : `${rule.every} hours`}${window}${days} (${label})`;
}

function list(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export const DAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * When quiet hours `from`–`to` ("22:00"–"07:00", in `zone`, may wrap midnight) end, if `now` is
 * inside them; null when it is not, or when from equals to.
 */
export function quietUntil(now: number, zone: string, hours: { from: string; to: string }): number | null {
  const from = clock(hours.from);
  const to = clock(hours.to);
  if (!from || !to) return null;
  const p = parts(zone, now);
  const minute = p.hour * 60 + p.minute;
  const start = from.hour * 60 + from.minute;
  const end = to.hour * 60 + to.minute;
  if (start === end) return null;
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return null;
  // The end is today, or tomorrow when it wraps past midnight and we are before it.
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day + (start > end && minute >= start ? 1 : 0)));
  return localToUtc(zone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), to.hour, to.minute);
}
