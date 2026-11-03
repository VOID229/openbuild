// When OpenBots' routines run: a schedule as people write it ("Weekdays at 8:00", "every other day
// at 20:00", "1st of each month at 9", "every 30 minutes", "in 2 hours", "tomorrow at 9am", or
// "cron 0 9 * * 1-5"), parsed into something the server can compute the next run from. Times are
// the server's local time. The app uses the same parser to check a schedule as it's typed.

type HM = [number, number];

export type Schedule =
  | { kind: "once"; at: number }
  | { kind: "interval"; every: number; anchor: number }
  | { kind: "days"; days: number[]; times: HM[] }
  | { kind: "everyNDays"; n: number; times: HM[]; anchor: number }
  | { kind: "monthly"; day: number; times: HM[] }
  | { kind: "cron"; minutes: number[]; hours: number[]; dom: number[] | null; months: number[]; dow: number[] | null };

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function dayIndex(word: string): number | undefined {
  const w = word.toLowerCase().replace(/s$/, "");
  const i = DAY_NAMES.findIndex((d) => d === w || d.slice(0, 3) === w || (w.length >= 3 && d.startsWith(w)));
  return i >= 0 ? i : undefined;
}

function monthIndex(word: string): number | undefined {
  const w = word.toLowerCase().replace(/\.$/, "");
  const i = MONTHS.findIndex((m) => m === w || (w.length >= 3 && m.startsWith(w)));
  return i >= 0 ? i : undefined;
}

/** "9", "9:30", "09:30", "9am", "9:30 pm", "21h", "noon", "midnight". */
const TIME = /\b(noon|midday|midnight|(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|h)?)\b/i;

function parseTime(text: string): HM | undefined {
  const m = TIME.exec(text);
  if (!m) return undefined;
  const word = m[1]!.toLowerCase();
  if (word === "noon" || word === "midday") return [12, 0];
  if (word === "midnight") return [0, 0];
  let h = Number(m[2]);
  const min = m[3] ? Number(m[3]) : 0;
  const suffix = (m[4] ?? "").toLowerCase().replace(/\./g, "");
  if (suffix === "pm" && h < 12) h += 12;
  if (suffix === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return [h, min];
}

/** Every time in the text ("at 9:00 and 17:30"); only words after "at" count when there's an "at". */
function parseTimes(text: string): HM[] {
  const at = text.search(/\b(at|@)\b/);
  const scope = at >= 0 ? text.slice(at) : text;
  const out: HM[] = [];
  for (const part of scope.split(/,|\band\b|&/)) {
    // Ordinals ("the 1st") aren't times.
    if (/\d(st|nd|rd|th)\b/i.test(part) && !/[:.]\d{2}|am|pm/i.test(part)) continue;
    const t = parseTime(part);
    if (t && !out.some((o) => o[0] === t[0] && o[1] === t[1])) out.push(t);
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

const at = (date: Date, [h, m]: HM) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, 0, 0).getTime();
const startOfDay = (t: number) => new Date(new Date(t).setHours(0, 0, 0, 0));
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const daysBetween = (a: Date, b: Date) => Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY);

function unitMs(unit: string): number | undefined {
  const u = unit.toLowerCase();
  if (/^(s|secs?|seconds?)$/.test(u)) return 1000;
  if (/^(m|mins?|minutes?)$/.test(u)) return MIN;
  if (/^(h|hrs?|hours?)$/.test(u)) return HOUR;
  if (/^(d|days?)$/.test(u)) return DAY;
  if (/^(w|wks?|weeks?)$/.test(u)) return 7 * DAY;
  return undefined;
}

// ------------------------------------------------------------------ cron

function cronField(field: string, min: number, max: number): number[] | undefined {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return undefined;
    const step = m[4] ? Number(m[4]) : 1;
    const lo = m[1] === "*" ? min : Number(m[2]);
    const hi = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    if (lo < min || hi > max || lo > hi || step < 1) return undefined;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

function parseCron(expr: string): Schedule | undefined {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return undefined;
  const minutes = cronField(f[0]!, 0, 59);
  const hours = cronField(f[1]!, 0, 23);
  const dom = f[2] === "*" ? null : cronField(f[2]!, 1, 31);
  const months = cronField(f[3]!, 1, 12);
  // Sunday is 0 or 7.
  const dowRaw = f[4] === "*" ? null : cronField(f[4]!, 0, 7);
  if (!minutes || !hours || dom === undefined || !months || dowRaw === undefined) return undefined;
  const dow = dowRaw ? [...new Set(dowRaw.map((d) => d % 7))].sort((a, b) => a - b) : null;
  return { kind: "cron", minutes, hours, dom, months, dow };
}

// ------------------------------------------------------------------ parsing

export interface ParseOptions {
  /** Now, for "in 2 hours" and "tomorrow". */
  now?: number;
  /** Where "every other day" and "every 3 hours" count from (when the routine was made). */
  anchor?: number;
  /** Read a bare time or date as one run ("at 18:00" = today or tomorrow at six), not daily. */
  once?: boolean;
}

/** A schedule from how it's written, or why it can't be read. */
export function parseSchedule(input: string, opts: ParseOptions = {}): Schedule | { error: string } {
  const now = opts.now ?? Date.now();
  const anchor = opts.anchor ?? now;
  const text = input.trim().toLowerCase().replace(/\s+/g, " ").replace(/^(run |do it |remind me )/, "");
  if (!text) return { error: "Say when, e.g. “Weekdays at 8:00” or “in 2 hours”." };

  const cron = /^cron:?\s+(.+)$/.exec(text)?.[1] ?? (/^[\d*,/-]+( [\d*,/-]+){4}$/.test(text) ? text : undefined);
  if (cron) return parseCron(cron) ?? { error: "That cron expression isn't valid (minute hour day month weekday)." };

  // "in 20 minutes", "in an hour", "in 2h"
  const rel = /^in (an?|\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(text);
  if (rel) {
    const n = rel[1]!.startsWith("a") ? 1 : Number(rel[1]);
    const unit = unitMs(rel[2]!);
    if (!unit || !(n > 0)) return { error: "Couldn't read that delay, e.g. “in 20 minutes”." };
    return { kind: "once", at: now + Math.round(n * unit) };
  }

  // "every 30 minutes", "every hour", "hourly", "every 2 hours"
  if (/^(hourly|every hour)$/.test(text)) return { kind: "interval", every: HOUR, anchor };
  const interval = /^every (\d+(?:\.\d+)?)?\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)$/.exec(text);
  if (interval) {
    const every = Math.round(Number(interval[1] ?? 1) * unitMs(interval[2]!)!);
    if (every < 5 * MIN) return { error: "Routines can run at most every 5 minutes." };
    return { kind: "interval", every, anchor };
  }

  const times = parseTimes(text);
  const timesOr = (fallback: HM[]) => (times.length ? times : fallback);
  const nine: HM[] = [[9, 0]];

  // A specific date: "2026-11-05 14:00", "on nov 5 at 9", "tomorrow at 9am", "today at 18:00", "tonight at 8".
  const iso = /\b(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{1,2}):(\d{2}))?\b/.exec(text);
  const named = /\b(?:on )?([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?\b/.exec(text);
  const namedMonth = named ? monthIndex(named[1]!) : undefined;
  if (iso || /\b(today|tonight|tomorrow)\b/.test(text) || namedMonth !== undefined) {
    let date: Date;
    let time: HM | undefined = times[0];
    if (iso) {
      date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      if (iso[4]) time = [Number(iso[4]), Number(iso[5])];
    } else if (namedMonth !== undefined) {
      const day = Number(named![2]);
      date = new Date(new Date(now).getFullYear(), namedMonth, day);
      if (at(date, time ?? nine[0]!) < now) date = new Date(date.getFullYear() + 1, namedMonth, day);
    } else {
      date = /\btomorrow\b/.test(text) ? addDays(startOfDay(now), 1) : startOfDay(now);
      if (/\btonight\b/.test(text) && time && time[0] < 12) time = [time[0] + 12, time[1]];
    }
    const t = at(date, time ?? (/\btonight\b/.test(text) ? [20, 0] : nine[0]!));
    if (t <= now) return { error: "That time has already passed." };
    return { kind: "once", at: t };
  }

  // "every other day at 20:00", "every 3 days"
  const nDays = /\bevery (other|second|\d+) days?\b/.exec(text);
  if (nDays) {
    const n = nDays[1] === "other" || nDays[1] === "second" ? 2 : Number(nDays[1]);
    if (!(n >= 1 && n <= 365)) return { error: "Couldn't read how many days apart." };
    return n === 1 ? { kind: "days", days: [0, 1, 2, 3, 4, 5, 6], times: timesOr(nine) } : { kind: "everyNDays", n, times: timesOr(nine), anchor };
  }

  // "1st of each month at 09:00", "monthly on the 15th", "every month on the 3rd at noon"
  const monthly = /\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(text);
  if (/\b(month|monthly)\b/.test(text)) {
    const day = monthly ? Number(monthly[1]) : 1;
    if (day < 1 || day > 31) return { error: "That day of the month doesn't exist." };
    return { kind: "monthly", day, times: timesOr(nine) };
  }

  // "weekdays at 8", "weekends", "mondays and thursdays at 18:30", "mon, wed, fri at 7", "every day", "daily"
  let days: number[] | undefined;
  if (/\b(every ?day|daily|each day|every morning|every evening|every night|nightly)\b/.test(text)) days = [0, 1, 2, 3, 4, 5, 6];
  else if (/\bweekdays?\b/.test(text)) days = [1, 2, 3, 4, 5];
  else if (/\bweekends?\b/.test(text)) days = [0, 6];
  else {
    const named = text
      .split(/[\s,/&]+/)
      .map((w) => dayIndex(w))
      .filter((d): d is number => d !== undefined);
    if (named.length) days = [...new Set(named)].sort();
  }
  if (days) {
    let fallback = nine;
    if (/\bevening\b/.test(text)) fallback = [[18, 0]];
    if (/\bnight(ly)?\b/.test(text)) fallback = [[21, 0]];
    return { kind: "days", days, times: timesOr(fallback) };
  }

  // "weekly" alone: the weekday it was made on.
  if (/\b(weekly|every week)\b/.test(text)) return { kind: "days", days: [new Date(anchor).getDay()], times: timesOr(nine) };

  // A bare time: daily for routines, the next one for follow-ups.
  if (times.length) {
    if (!opts.once) return { kind: "days", days: [0, 1, 2, 3, 4, 5, 6], times };
    const today = startOfDay(now);
    const t = at(today, times[0]!);
    return { kind: "once", at: t > now ? t : at(addDays(today, 1), times[0]!) };
  }

  return { error: "Couldn't read that schedule. Try “Weekdays at 8:00”, “every 2 hours”, “Sundays at 10:00” or “in 30 minutes”." };
}

export const isSchedule = (s: Schedule | { error: string }): s is Schedule => !("error" in s);

/** When it next runs after `after`, or undefined when it never will again. */
export function nextRun(s: Schedule, after: number): number | undefined {
  switch (s.kind) {
    case "once":
      return s.at > after ? s.at : undefined;
    case "interval": {
      const k = Math.max(0, Math.floor((after - s.anchor) / s.every) + 1);
      return s.anchor + k * s.every;
    }
    case "days": {
      const day0 = startOfDay(after);
      for (let d = 0; d <= 8; d++) {
        const day = addDays(day0, d);
        if (!s.days.includes(day.getDay())) continue;
        for (const t of s.times) if (at(day, t) > after) return at(day, t);
      }
      return undefined;
    }
    case "everyNDays": {
      const day0 = startOfDay(after);
      const first = startOfDay(s.anchor);
      for (let d = 0; d <= s.n + 1; d++) {
        const day = addDays(day0, d);
        const diff = daysBetween(first, day);
        if (diff < 0 || diff % s.n) continue;
        for (const t of s.times) if (at(day, t) > after) return at(day, t);
      }
      return undefined;
    }
    case "monthly": {
      const base = new Date(after);
      for (let m = 0; m <= 13; m++) {
        const month = new Date(base.getFullYear(), base.getMonth() + m, 1);
        const last = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        const day = new Date(month.getFullYear(), month.getMonth(), Math.min(s.day, last));
        for (const t of s.times) if (at(day, t) > after) return at(day, t);
      }
      return undefined;
    }
    case "cron": {
      const day0 = startOfDay(after);
      for (let d = 0; d <= 400; d++) {
        const day = addDays(day0, d);
        if (!s.months.includes(day.getMonth() + 1)) continue;
        const domOk = !s.dom || s.dom.includes(day.getDate());
        const dowOk = !s.dow || s.dow.includes(day.getDay());
        // Cron: when both are restricted, either one matching is enough.
        if (s.dom && s.dow ? !(domOk || dowOk) : !(domOk && dowOk)) continue;
        for (const h of s.hours) for (const m of s.minutes) if (at(day, [h, m]) > after) return at(day, [h, m]);
      }
      return undefined;
    }
  }
}

/** A run time as briefly as it reads: "Today 18:00", "Tomorrow 8:00", "Mon 9:00", "Nov 5 9:00". */
export function formatRun(t: number, now = Date.now()): string {
  const days = daysBetween(startOfDay(now), startOfDay(t));
  const time = new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${new Date(t).toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${new Date(t).toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
