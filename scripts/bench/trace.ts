// Records a Chrome trace of a warm reload (and optionally a thread switch) against a sandbox server,
// saves it for DevTools/Perfetto, and prints where the main thread's time went and when each request
// ran, relative to the navigation.
//
//   bun scripts/bench/trace.ts --golden <seeded folder> --out <dir> [--repo <checkout>] [--cpu 1]
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, type Tab } from "./cdp";
import { sandbox } from "./sandbox";

const flag = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const golden = flag("golden")!;
const out = flag("out")!;
if (flag("repo")) process.env.OPENBUILD_BENCH_REPO = flag("repo");
const CPU = Number(flag("cpu", "1"));
const chrome = flag("chrome", `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`)!;
mkdirSync(out, { recursive: true });

const db = new Database(join(golden, "data/openchat.db"), { readonly: true });
const visible = db.query<{ id: string; data: string }, []>("SELECT id, data FROM chats WHERE deleted_at IS NULL AND (json_extract(data, '$.pinned') = 1 OR json_extract(data, '$.done') = 1) ORDER BY length(data)").all();
const pickAt = (q: number) => { const r = visible[Math.floor(q * (visible.length - 1))]!; return { id: r.id, last: JSON.parse(r.data).messages.at(-1).id as string }; };
const landing = pickAt(0.5);
const big = pickAt(1);
db.close();

const CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "v8.execute", "blink.user_timing", "loading", "latencyInfo", "disabled-by-default-devtools.timeline.frame"];

async function record(tab: Tab, work: () => Promise<unknown>): Promise<any[]> {
  const events: any[] = [];
  const off = tab.browser.on((msg) => {
    if (msg.method === "Tracing.dataCollected") events.push(...msg.params.value);
  });
  await tab.send("Tracing.start", { traceConfig: { includedCategories: CATEGORIES }, transferMode: "ReportEvents" });
  await work();
  const done = new Promise<void>((resolve) => {
    const stop = tab.browser.on((msg) => { if (msg.method === "Tracing.tracingComplete") { stop(); resolve(); } });
  });
  await tab.send("Tracing.end");
  await done;
  off();
  return events;
}

/** A sampled CPU profile of `work`: saved for DevTools, and its heaviest functions by self and total time. */
async function profile(tab: Tab, label: string, work: () => Promise<unknown>) {
  await tab.send("Profiler.enable");
  await tab.send("Profiler.setSamplingInterval", { interval: 100 });
  await tab.send("Profiler.start");
  await work();
  const { profile } = await tab.send("Profiler.stop");
  writeFileSync(join(out, `${label}.cpuprofile`), JSON.stringify(profile));
  const nodes = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map<number, number>();
  profile.samples.forEach((id: number, i: number) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const key = (n: any) => `${n.callFrame.functionName || "(anonymous)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`;
  const bySelf = new Map<string, number>(), byTotal = new Map<string, number>();
  for (const [id, us] of self) {
    bySelf.set(key(nodes.get(id)), (bySelf.get(key(nodes.get(id))) ?? 0) + us);
    // Total: once per function on the sample's stack.
    const seen = new Set<string>();
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const k = key(nodes.get(at));
      if (seen.has(k)) continue;
      seen.add(k);
      byTotal.set(k, (byTotal.get(k) ?? 0) + us);
    }
  }
  const top = (m: Map<string, number>) => [...m].filter(([k]) => !/^\((root|program|idle)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, us]) => `    ${(us / 1000).toFixed(1).padStart(7)} ms  ${k}`).join("\n");
  console.log(`\n== ${label} CPU profile, self:\n${top(bySelf)}\n  total:\n${top(byTotal)}`);
}

/** Main-thread time by top-level event name, and the requests, from `from` (µs) on. */
function summarize(events: any[], label: string) {
  const main = events.find((e) => e.name === "TracingStartedInBrowser")?.args?.data?.frames?.[0]?.processId;
  const renderer = events.filter((e) => e.name === "thread_name" && e.args?.name === "CrRendererMain" && (!main || e.pid === main));
  const mainTid = renderer[0]?.tid;
  const mainPid = renderer[0]?.pid;
  const nav = events.find((e) => e.name === "navigationStart" && e.pid === mainPid)?.ts ?? Math.min(...events.filter((e) => e.ts).map((e) => e.ts));
  const top = events.filter((e) => e.pid === mainPid && e.tid === mainTid && e.ph === "X" && e.dur && e.name === "RunTask");
  const busy = top.reduce((a, e) => a + e.dur, 0) / 1000;
  const byName = new Map<string, number>();
  for (const e of events.filter((e) => e.pid === mainPid && e.tid === mainTid && e.ph === "X" && e.dur)) {
    if (["RunTask", "ThreadControllerImpl::RunTask"].includes(e.name)) continue;
    byName.set(e.name, (byName.get(e.name) ?? 0) + e.dur / 1000);
  }
  const requests = new Map<string, { url: string; start: number; end?: number; size?: number }>();
  for (const e of events) {
    const d = e.args?.data;
    if (e.name === "ResourceSendRequest") requests.set(d.requestId, { url: d.url, start: (e.ts - nav) / 1000 });
    if (e.name === "ResourceFinish" && requests.has(d.requestId)) { const r = requests.get(d.requestId)!; r.end = (e.ts - nav) / 1000; r.size = d.encodedDataLength; }
  }
  const long = top.filter((e) => e.dur > 30_000).map((e) => `${Math.round((e.ts - nav) / 1000)}ms +${Math.round(e.dur / 1000)}`);
  console.log(`\n== ${label}: main thread busy ${Math.round(busy)} ms; long tasks: ${long.join(", ")}`);
  console.log([...byName].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([n, ms]) => `  ${n.padEnd(34)} ${ms.toFixed(1)} ms`).join("\n"));
  console.log("  requests (start → end ms, KB):");
  for (const r of [...requests.values()].sort((a, b) => a.start - b.start)) {
    const u = new URL(r.url);
    console.log(`    ${r.start.toFixed(0).padStart(5)} → ${(r.end ?? NaN).toFixed(0).padStart(5)}  ${String(Math.round((r.size ?? 0) / 1024)).padStart(6)}  ${(u.pathname + u.search).slice(0, 90)}`);
  }
}

const root = join(golden, "..", `trace-${process.pid}`);
rmSync(root, { recursive: true, force: true });
cpSync(golden, root, { recursive: true });
const box = sandbox(root, Number(flag("port", "3989")));
const browser = await Browser.launch(chrome);
try {
  await box.start();
  await Bun.sleep(4000);
  const tab = await browser.page();
  if (CPU > 1) await tab.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  const checks = { thread: `!!document.querySelector('.messages-inner [data-message-id="${landing.last}"]')?.checkVisibility()` };
  await tab.load(`${box.url}/thread-${landing.id}`, checks);
  await Bun.sleep(2000);
  let marks: Record<string, number> = {};
  const reload = await record(tab, async () => { marks = await tab.load("reload", checks); await Bun.sleep(1500); });
  writeFileSync(join(out, "warm-reload.trace.json"), JSON.stringify({ traceEvents: reload }));
  summarize(reload, `warm reload (thread visible at ${marks.thread} ms)`);
  await Bun.sleep(1500);
  const sw = await record(tab, async () => {
    const r = await tab.interact(() => tab.click(`.history-row[data-thread="${big.id}"] .history-title`), `!!document.querySelector('.messages-inner [data-message-id="${big.last}"]')?.checkVisibility()`);
    console.log("\nswitch to the largest open thread:", r);
    await Bun.sleep(500);
  });
  writeFileSync(join(out, "switch-big.trace.json"), JSON.stringify({ traceEvents: sw }));
  summarize(sw, "switch to the largest open thread");
  if (process.argv.includes("--profile")) {
    await tab.load(`${box.url}/thread-${landing.id}`, checks);
    await Bun.sleep(1500);
    await profile(tab, "reload", async () => { await tab.load("reload", checks); await Bun.sleep(1000); });
    await Bun.sleep(1000);
    const mid = pickAt(0.6);
    await profile(tab, "switch-first", () => tab.interact(() => tab.click(`.history-row[data-thread="${mid.id}"] .history-title`), `!!document.querySelector('.messages-inner [data-message-id="${mid.last}"]')?.checkVisibility()`));
    await Bun.sleep(800);
    await profile(tab, "switch-back", () => tab.interact(() => tab.click(`.history-row[data-thread="${landing.id}"] .history-title`), checks.thread));
    await Bun.sleep(800);
    await profile(tab, "switch-again", () => tab.interact(() => tab.click(`.history-row[data-thread="${mid.id}"] .history-title`), `!!document.querySelector('.messages-inner [data-message-id="${mid.last}"]')?.checkVisibility()`));
    await Bun.sleep(800);
    const toggle = "[...document.querySelectorAll('.bots-toggle')].find((b) => b.checkVisibility())";
    await profile(tab, "into-bots", () => tab.interact(() => tab.clickWhere(toggle), "!!document.querySelector('.bots-messages .bm-row')?.checkVisibility()"));
    await Bun.sleep(800);
    await profile(tab, "back-from-bots", () => tab.interact(() => tab.clickWhere(toggle), "!document.querySelector('.bots-messages')?.checkVisibility()"));
    await Bun.sleep(800);
  }
  const bots = await record(tab, async () => {
    const r = await tab.interact(() => tab.clickWhere("[...document.querySelectorAll('.bots-toggle')].find((b) => b.checkVisibility())"), "!!document.querySelector('.bots-messages .bm-row')?.checkVisibility()");
    console.log("\ninto OpenBots:", r);
    await Bun.sleep(500);
  });
  writeFileSync(join(out, "into-bots.trace.json"), JSON.stringify({ traceEvents: bots }));
  summarize(bots, "into OpenBots");
  await tab.close();
} finally {
  await browser.close();
  await box.destroy();
  rmSync(root, { recursive: true, force: true });
}
