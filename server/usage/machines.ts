// Usage on paired devices, merged with this machine's. Each device answers /api/usage for itself
// (scope=local); its last answer is kept (in memory and on disk) and shown at once, and refreshed
// in the background, so a slow or sleeping machine never holds the page up.
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { UsageLimits, UsageLimitsReport, UsageMachine, UsageRange, UsageReport } from "../../shared/usage";
import * as devices from "../devices";
import { dataDir } from "../paths";
import { RETRY_MS, shouldRefresh } from "./cache";
import { requestUsage } from "./remoteRequest";
/** How long a first answer is waited for before the page shows without it. */
const WAIT_MS = 3500;

interface Cached<T> {
  at: number;
  value?: T;
  error?: string;
  retryAt?: number;
  running?: Promise<void>;
}

const hot = globalThis as { usageRemote?: Map<string, Cached<unknown>> };
let loaded: Promise<Map<string, Cached<unknown>>> | undefined;
const file = () => join(dataDir(), "usage-remote.json");

function store() {
  if (hot.usageRemote) return Promise.resolve(hot.usageRemote);
  return (loaded ??= readFile(file(), "utf8")
    .then((t) => new Map<string, Cached<unknown>>(Object.entries(JSON.parse(t)).map(([k, v]: [string, any]) => [k, { at: v.at, value: v.value }])))
    .catch(() => new Map<string, Cached<unknown>>())
    .then((m) => (hot.usageRemote = m)));
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save(m: Map<string, Cached<unknown>>) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const out: Record<string, { at: number; value: unknown }> = {};
    for (const [k, v] of m) if (v.value !== undefined) out[k] = { at: v.at, value: v.value };
    try {
      await Bun.write(`${file()}.tmp`, JSON.stringify(out));
      await rename(`${file()}.tmp`, file());
    } catch {}
  }, 1000);
}

/** GET a paired device's API, trying each of its addresses. */
async function ask<T>(device: devices.StoredDevice, path: string): Promise<T> {
  const value = await requestUsage<T>(device.urls, path, device.token);
  devices.touchDevice(device.id, true);
  return value;
}

/** A device's answer: cached, refreshed in the background when stale. */
async function remote<T>(device: devices.StoredDevice, key: string, path: string, force: boolean): Promise<{ value?: T; at: number; error?: string; pending: boolean }> {
  const m = await store();
  const k = `${device.id}|${key}`;
  const c = (m.get(k) ?? m.set(k, { at: 0 }).get(k)!) as Cached<T>;
  const incomplete = !!(c.value as UsageReport | undefined)?.pending?.length
    || !!(c.value as UsageLimitsReport | undefined)?.machines?.some((m) => m.status === "pending");
  if (!c.running && shouldRefresh(c, incomplete, force)) {
    const url = force ? `${path}${path.includes("?") ? "&" : "?"}fresh=1` : path;
    c.running = ask<T>(device, url).then(
      (value) => {
        c.value = value;
        c.at = Date.now();
        c.error = undefined;
        c.retryAt = undefined;
        save(m);
      },
      (err: Error) => {
        c.error = err.message;
        // Back off even with no answer (or a stale one); leave its real timestamp intact.
        c.retryAt = Date.now() + RETRY_MS;
      },
    ).finally(() => (c.running = undefined));
  }
  // The first answer is worth a short wait; after that the cached one is shown straight away.
  if (c.running && c.value === undefined) await Promise.race([c.running, Bun.sleep(WAIT_MS)]);
  return { value: c.value, at: c.at, error: c.error, pending: !!c.running };
}

export const remoteDevices = () => devices.readDevices();

// ------------------------------------------------------------------ reports

/** One report per machine; `machine` picks one (this one is "local") or "all". */
export async function machineReports(range: UsageRange, tz: string, force: boolean, local: () => Promise<UsageReport>) {
  const list = remoteDevices();
  const path = `/api/usage?scope=local&range=${range}&tz=${encodeURIComponent(tz)}`;
  const [mine, ...theirs] = await Promise.all([local(), ...list.map((d) => remote<UsageReport>(d, `report:${range}:${tz}`, path, force))]);
  const machines: UsageMachine[] = [{ id: "local", name: devices.deviceName(), local: true, status: mine.pending?.length ? "pending" : "ok", at: mine.generatedAt }];
  const reports: { machine: UsageMachine; report: UsageReport }[] = [{ machine: machines[0]!, report: mine }];
  list.forEach((d, i) => {
    const r = theirs[i]!;
    const machine: UsageMachine = { id: d.id, name: d.name, status: r.pending ? "pending" : r.error ? "error" : "ok", at: r.at || undefined, error: r.error };
    // A remote whose own scan is still finishing (its Cursor history) is still coming in.
    if (!r.error && r.value?.pending?.length) machine.status = "pending";
    machines.push(machine);
    if (r.value) reports.push({ machine, report: r.error ? { ...r.value, pending: [] } : r.value });
  });
  return { machines, reports };
}

/** Add reports for the same range and time zone together. */
export function mergeReports(parts: { machine: UsageMachine; report: UsageReport }[]): UsageReport {
  if (parts.length === 1) return parts[0]!.report;
  const base = parts[0]!.report;
  const providers = new Map<string, UsageReport["providers"][number]>();
  const buckets = new Map<number, Map<string, { cost: number; tokens: number }>>();
  const models = new Map<string, UsageReport["models"][number]>();
  const days = new Map<number, UsageReport["days"][number]>();
  const totals = { ...base.totals };
  const costByType = { ...base.costByType };
  for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = 0;
  for (const k of Object.keys(costByType) as (keyof typeof costByType)[]) costByType[k] = 0;
  const unpriced = new Set<string>();
  const problems: UsageReport["problems"] = [];
  const pending = new Set<UsageReport["providers"][number]["id"]>();
  for (const { machine, report: r } of parts) {
    for (const p of r.providers) {
      const q = providers.get(p.id) ?? providers.set(p.id, { ...p, sessions: 0, requests: 0, cost: 0, tokens: 0 }).get(p.id)!;
      q.sessions += p.sessions;
      q.requests += p.requests;
      q.cost += p.cost;
      q.tokens += p.tokens;
    }
    for (const b of r.series) {
      const row = buckets.get(b.t) ?? buckets.set(b.t, new Map()).get(b.t)!;
      r.providers.forEach((p, i) => {
        const v = row.get(p.id) ?? row.set(p.id, { cost: 0, tokens: 0 }).get(p.id)!;
        v.cost += b.cost[i] ?? 0;
        v.tokens += b.tokens[i] ?? 0;
      });
    }
    for (const m of r.models) {
      const k = `${m.provider}\0${m.model}`;
      const q = models.get(k) ?? models.set(k, { ...m, cost: 0, tokens: 0, requests: 0 }).get(k)!;
      q.cost += m.cost;
      q.tokens += m.tokens;
      q.requests += m.requests;
    }
    for (const d of r.days) {
      const q = days.get(d.t) ?? days.set(d.t, { t: d.t, cost: 0, tokens: 0, sessions: 0 }).get(d.t)!;
      q.cost += d.cost;
      q.tokens += d.tokens;
      q.sessions += d.sessions;
    }
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r.totals[k];
    for (const k of Object.keys(costByType) as (keyof typeof costByType)[]) costByType[k] += r.costByType[k];
    r.unpriced.forEach((u) => unpriced.add(u));
    for (const p of r.problems) problems.push({ ...p, message: machine.local ? p.message : `${machine.name}: ${p.message}` });
    r.pending?.forEach((p) => pending.add(p));
  }
  const ps = [...providers.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  // This machine's buckets are the frame; a remote's answer from a little earlier lands in the nearest one.
  const frame = base.series.map((b) => b.t);
  // Buckets in the same time zone start at the same moments; the nearest start is the same bucket.
  const at = (t: number) => {
    let best = 0;
    for (let i = 1; i < frame.length; i++) if (Math.abs(frame[i]! - t) < Math.abs(frame[best]! - t)) best = i;
    return best;
  };
  const series = frame.map((t) => ({ t, cost: ps.map(() => 0), tokens: ps.map(() => 0) }));
  for (const [t, row] of buckets) {
    if (t < frame[0]! - (frame[1]! - frame[0]!)) continue;
    const s = series[at(t)]!;
    ps.forEach((p, i) => {
      const v = row.get(p.id);
      if (v) {
        s.cost[i]! += v.cost;
        s.tokens[i]! += v.tokens;
      }
    });
  }
  const dayRows = new Map<number, UsageReport["days"][number]>();
  for (const d of days.values()) {
    const t = frame[at(d.t)]!;
    const q = dayRows.get(t) ?? dayRows.set(t, { t, cost: 0, tokens: 0, sessions: 0 }).get(t)!;
    q.cost += d.cost;
    q.tokens += d.tokens;
    q.sessions += d.sessions;
  }
  return {
    ...base,
    providers: ps,
    series,
    totals,
    costByType,
    models: [...models.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
    days: [...dayRows.values()].sort((a, b) => b.t - a.t),
    unpriced: [...unpriced].sort(),
    problems,
    pending: [...pending],
  };
}

// ------------------------------------------------------------------ limits

/** Limits from every machine; an account signed in on several shows once, from its freshest reading. */
export async function machineLimits(force: boolean, local: () => Promise<UsageLimits[]>): Promise<UsageLimitsReport> {
  const list = remoteDevices();
  const [mine, ...theirs] = await Promise.all([local(), ...list.map((d) => remote<UsageLimitsReport>(d, "limits", "/api/usage/limits?scope=local", force))]);
  const byId = new Map<string, UsageLimits>();
  const add = (l: UsageLimits) => {
    const prev = byId.get(l.id);
    const ok = (x: UsageLimits) => x.windows.length > 0 && !x.stale;
    if (!prev || (ok(l) && !ok(prev)) || (ok(l) === ok(prev) && l.asOf > prev.asOf)) byId.set(l.id, l);
  };
  mine.forEach((l) => add({ ...l, machine: devices.deviceName() }));
  const machines: UsageMachine[] = [{ id: "local", name: devices.deviceName(), local: true, status: "ok", at: Date.now() }];
  list.forEach((d, i) => {
    const r = theirs[i]!;
    machines.push({ id: d.id, name: d.name, status: r.pending ? "pending" : r.error ? "error" : "ok", at: r.at || undefined, error: r.error });
    r.value?.providers.forEach((l) => add({ ...l, machine: d.name }));
  });
  // Number accounts within each provider again now that machines are combined.
  const all = [...byId.values()];
  const counts = new Map<string, number>();
  for (const l of all) counts.set(l.provider, (counts.get(l.provider) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const l of all) {
    if ((counts.get(l.provider) ?? 0) < 2) {
      delete l.account;
      continue;
    }
    const n = (seen.get(l.provider) ?? 0) + 1;
    seen.set(l.provider, n);
    l.account = l.account && !/^\d+$/.test(l.account) ? l.account : String(n);
  }
  return { providers: all, checkedAt: Date.now(), machines };
}
