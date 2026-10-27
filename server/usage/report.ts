// Usage over a range, added up from the scanned records (scan.ts). Cost is what a transcript
// reports, or else the tokens at the model's price per token (Pi's catalog, server/pi/pricing.ts):
// for plans and subscriptions it's what the same use would cost through the API.
import { USAGE_PROVIDERS, type UsageModelRow, type UsageProvider, type UsageRange, type UsageReport } from "../../shared/usage";
import type { Price } from "../../shared/types";
import { modelKey, priceBook, referencePrice, type PriceBook } from "../pi/pricing";
import { cursorPriceModel, type Rec } from "./formats";
import { generation, scan, scanProblems } from "./scan";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DAYS: Record<UsageRange, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };

// ------------------------------------------------------------------ time zones

/** The time zone's offset from UTC at `t`, in ms. */
function offsetAt(t: number, tz: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(t)
      .map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(t / 1000) * 1000;
}

/** Local midnight `days` days before the day `t` falls on. */
function midnight(t: number, tz: string, days = 0) {
  const local = new Date(t + offsetAt(t, tz));
  const utc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - days);
  // Twice: the offset at the guess can differ across a DST change.
  let guess = utc - offsetAt(utc, tz);
  guess = utc - offsetAt(guess, tz);
  return guess;
}

/** Bucket starts, oldest first. */
function buckets(range: UsageRange, now: number, tz: string): number[] {
  if (range === "24h") {
    const hour = now - ((now + offsetAt(now, tz)) % HOUR + HOUR) % HOUR;
    return Array.from({ length: 24 }, (_, i) => hour - (23 - i) * HOUR);
  }
  return Array.from({ length: DAYS[range] }, (_, i) => midnight(now, tz, DAYS[range] - 1 - i));
}

const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// ------------------------------------------------------------------ prices

/** A price for a record's model: Pi's own listing when it has a price, else the same model sold by the token. */
function pricer(book: PriceBook | undefined) {
  const memo = new Map<string, Price | undefined>();
  return (provider: UsageProvider, model: string): Price | undefined => {
    if (!book) return;
    const k = `${provider}\0${model}`;
    if (memo.has(k)) return memo.get(k);
    let price: Price | undefined;
    if (provider === "pi" && model.includes("/")) {
      const slash = model.indexOf("/");
      const [p, id] = [model.slice(0, slash), model.slice(slash + 1)];
      const own = book.listings.find((l) => l.provider === p && l.id === id);
      price = own && (own.cost.input > 0 || own.cost.output > 0) ? own.cost : referencePrice(id, book, p)?.cost;
    } else {
      const id = provider === "cursor" ? cursorPriceModel(model) : model;
      price = modelKey(id) ? referencePrice(id, book)?.cost : undefined;
    }
    memo.set(k, price);
    return price;
  };
}

// ------------------------------------------------------------------ the report

const reports = new Map<string, { version: number; book: PriceBook | undefined; at: number; value: UsageReport }>();

export async function report(range: UsageRange, tz: string, force = false): Promise<UsageReport> {
  const zone = validZone(tz) ? tz : "UTC";
  const [entries, book] = await Promise.all([scan(force), priceBook().catch((err) => void console.warn("[usage] model prices unavailable:", (err as Error).message))]);
  const version = generation();
  const key = `${range}|${zone}`;
  const hit = reports.get(key);
  // Unchanged records, prices and hour: the same report.
  if (hit && hit.version === version && hit.book === (book ?? undefined) && Date.now() - hit.at < 60_000) return hit.value;
  const value = build(range, zone, entries, book ?? undefined);
  reports.set(key, { version, book: book ?? undefined, at: Date.now(), value });
  return value;
}

function build(range: UsageRange, tz: string, entries: Map<string, { provider: UsageProvider; recs: Rec[] }>, book: PriceBook | undefined): UsageReport {
  const now = Date.now();
  const starts = buckets(range, now, tz);
  const start = starts[0]!;
  const priceOf = pricer(book);
  const seen = new Set<string>();
  const ids = USAGE_PROVIDERS;
  const per = new Map<UsageProvider, { sessions: Set<string>; requests: number; cost: number; tokens: number }>();
  const series = starts.map((t) => ({ t, cost: ids.map(() => 0), tokens: ids.map(() => 0) }));
  const daySessions = starts.map(() => new Set<string>());
  const models = new Map<string, UsageModelRow>();
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, sessions: 0, requests: 0, cacheSavings: 0 };
  const costByType = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, other: 0 };
  const unpriced = new Set<string>();

  for (const { provider, recs } of entries.values()) {
    const pi = ids.indexOf(provider);
    for (const r of recs) {
      if (r.t < start || r.t > now || seen.has(r.key)) continue;
      seen.add(r.key);
      const tokens = r.input + r.cacheRead + r.cacheWrite + r.output;
      const price = priceOf(provider, r.model);
      let cost: number;
      if (r.cost !== null) {
        cost = r.cost;
        costByType.other += cost;
      } else if (price) {
        const parts = { input: r.input * price.input, cacheRead: r.cacheRead * price.cacheRead, cacheWrite: r.cacheWrite * price.cacheWrite, output: r.output * price.output };
        cost = (parts.input + parts.cacheRead + parts.cacheWrite + parts.output) / 1e6;
        for (const k of ["input", "cacheRead", "cacheWrite", "output"] as const) costByType[k] += parts[k] / 1e6;
      } else {
        cost = 0;
        unpriced.add(r.model);
      }
      if (price && r.cacheRead) totals.cacheSavings += (r.cacheRead * Math.max(0, price.input - price.cacheRead)) / 1e6;
      totals.input += r.input;
      totals.cacheRead += r.cacheRead;
      totals.cacheWrite += r.cacheWrite;
      totals.output += r.output;
      totals.cost += cost;
      totals.requests++;

      const p = per.get(provider) ?? per.set(provider, { sessions: new Set(), requests: 0, cost: 0, tokens: 0 }).get(provider)!;
      p.sessions.add(r.session);
      p.requests++;
      p.cost += cost;
      p.tokens += tokens;

      // The last bucket starting at or before the record.
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid]! <= r.t) lo = mid;
        else hi = mid - 1;
      }
      series[lo]!.cost[pi] += cost;
      series[lo]!.tokens[pi] += tokens;
      daySessions[lo]!.add(`${provider}:${r.session}`);

      const mk = `${provider}\0${r.model}`;
      const m = models.get(mk) ?? models.set(mk, { provider, model: r.model, cost: 0, tokens: 0, requests: 0 }).get(mk)!;
      m.cost += cost;
      m.tokens += tokens;
      m.requests++;
    }
  }

  const providers = [...per].map(([id, p]) => ({ id, sessions: p.sessions.size, requests: p.requests, cost: p.cost, tokens: p.tokens })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  totals.sessions = providers.reduce((s, p) => s + p.sessions, 0);
  const order = providers.map((p) => ids.indexOf(p.id));
  const problems = [...scanProblems()];
  if (!book) problems.push({ provider: "pi", message: "Model prices are unavailable (Pi didn't answer), so costs that aren't reported are missing." });
  return {
    range,
    bucket: range === "24h" ? "hour" : "day",
    start,
    end: now,
    providers,
    series: series.map((b) => ({ t: b.t, cost: order.map((i) => b.cost[i]!), tokens: order.map((i) => b.tokens[i]!) })),
    totals,
    costByType,
    models: [...models.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    days: series.map((b, i) => ({ t: b.t, cost: b.cost.reduce((s, v) => s + v, 0), tokens: b.tokens.reduce((s, v) => s + v, 0), sessions: daySessions[i]!.size })).reverse(),
    unpriced: [...unpriced].sort(),
    problems,
    generatedAt: now,
  };
}
