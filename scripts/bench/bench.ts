// Times OpenBuild the way it's used, in a real Chrome against a disposable server (sandbox.ts)
// seeded by seed.ts: cold and warm page loads, switching threads, going between OpenBuild and
// OpenBots, switching OpenBots chats, and getting back after the server restarts.
//
//   bun scripts/bench/bench.ts --golden /tmp/ob-bench/golden [--chrome <path>] [--runs 5]
//     [--cpu 1] [--latency 0] [--kbps 0] [--only cold,warm] [--out result.json] [--repo <checkout>]
//
// --cpu slows the page's CPU (4 ≈ a mid-range laptop on battery), --latency/--kbps the network
// (e.g. 40 ms and 20000 for a phone on Tailscale). Every run starts from a fresh copy of the golden
// data, so earlier runs can't warm anything.
import { Database } from "bun:sqlite";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browser } from "./cdp";
import { sandbox } from "./sandbox";

const flag = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const golden = flag("golden") ?? "";
if (!golden) throw new Error("--golden <seeded sandbox folder> is required (see seed.ts)");
const chrome = flag("chrome", process.env.OPENBUILD_BENCH_CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`)!;
const RUNS = Number(flag("runs", "5"));
const CPU = Number(flag("cpu", "1"));
const LATENCY = Number(flag("latency", "0"));
const KBPS = Number(flag("kbps", "0"));
const PORT = Number(flag("port", "3987"));
const only = flag("only")?.split(",");
// Another checkout's server, e.g. an export of the base commit (`git archive`), for before/after.
if (flag("repo")) process.env.OPENBUILD_BENCH_REPO = flag("repo");
const want = (name: string) => !only || only.includes(name);

const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN;
};
const summary = (xs: number[]) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs), runs: xs });

// What to open, from the golden data: threads at several sizes, and the OpenBots chats.
type Target = { id: string; bytes: number; messages: number; last: string };
const db = new Database(join(golden, "data/openchat.db"), { readonly: true });
// Threads the sidebar lists in the open (pinned or done), not under the collapsed "Closed".
const open = db.query<{ id: string; b: number; data: string }, []>("SELECT id, length(data) b, data FROM chats WHERE deleted_at IS NULL AND (json_extract(data, '$.pinned') = 1 OR json_extract(data, '$.done') = 1) ORDER BY b").all();
const toTarget = (r: { id: string; b: number; data: string }): Target => {
  const c = JSON.parse(r.data);
  return { id: r.id, bytes: r.b, messages: c.messages.length, last: c.messages.at(-1).id };
};
const at = (q: number) => toTarget(open[Math.min(open.length - 1, Math.floor(q * (open.length - 1)))]!);
const LANDING = at(0.5);
const SWITCHES = [at(0.3), at(0.6), at(0.9), at(0.97), at(1), at(0.45)];
db.close();
const bots = new Database(join(golden, "data/bots/bots.sqlite"), { readonly: true });
const botNames = new Map(bots.query<{ id: string; data: string }, []>("SELECT id, data FROM bots").all().map((b) => [b.id, JSON.parse(b.data).name as string]));
const BOT_CHATS = bots.query<{ id: string; data: string; last: string; n: number }, []>(
  "SELECT c.id, c.data, (SELECT m.id FROM messages m WHERE m.conversation_id = c.id ORDER BY seq DESC LIMIT 1) last, (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) n FROM conversations c WHERE json_extract(c.data, '$.kind') != 'side' ORDER BY n DESC",
).all().slice(0, 4).map((c) => {
  const data = JSON.parse(c.data);
  return { id: c.id, last: c.last, n: c.n, title: (data.name ?? botNames.get(data.botIds[0])) as string };
});
bots.close();

const threadShown = (t: Target) => `!!document.querySelector('.messages-inner [data-message-id="${t.last}"]')?.checkVisibility()`;
// Both sidebars stay mounted, each with its own switch: the one on screen.
const VISIBLE_TOGGLE = "[...document.querySelectorAll('.bots-toggle')].find((b) => b.checkVisibility())";
const rowFor = (id: string) => `.history-row[data-thread="${id}"] .history-title`;

let runIndex = 0;
async function withServer<T>(work: (box: ReturnType<typeof sandbox>) => Promise<T>): Promise<T> {
  const root = join(golden, "..", `run-${process.pid}-${runIndex++}`);
  rmSync(root, { recursive: true, force: true });
  cpSync(golden, root, { recursive: true });
  const box = sandbox(root, PORT);
  try {
    await box.start();
    return await work(box);
  } finally {
    await box.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}

async function tab(browser: Browser) {
  const t = await browser.page();
  if (CPU > 1) await t.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  if (LATENCY || KBPS) {
    const bytes = KBPS ? (KBPS * 1024) / 8 : -1;
    await t.send("Network.emulateNetworkConditions", { offline: false, latency: LATENCY, downloadThroughput: bytes, uploadThroughput: bytes });
  }
  // When each API call last answered, to tell when the app is talking to a restarted server again.
  await t.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { const f = window.fetch; window.__apiOk = []; window.fetch = async function (...a) { const r = await f.apply(this, a); try { const u = new URL(a[0] instanceof Request ? a[0].url : String(a[0]), location.href); if (r.ok && u.pathname.startsWith('/api/')) window.__apiOk.push([performance.now(), u.pathname + u.search]); } catch {} return r; }; })()`,
  });
  return t;
}

const LOAD_CHECKS = {
  shell: "!!document.querySelector('.history-row')",
  thread: threadShown(LANDING),
};

const results: Record<string, unknown> = {
  when: new Date().toISOString(),
  conditions: { cpu: CPU, latency: LATENCY, kbps: KBPS, runs: RUNS, viewport: "1440x900", chrome, repo: process.env.OPENBUILD_BENCH_REPO ?? "this checkout" },
  landing: LANDING,
};

const browser = await Browser.launch(chrome);
try {
  // ------------------------------------------------------------------ cold and warm loads
  if (want("cold") || want("warm")) {
    await withServer(async (box) => {
      // Let the server's start-up warm-up finish first: these are loads against a running server.
      await Bun.sleep(4000);
      const url = `${box.url}/thread-${LANDING.id}`;
      if (want("cold")) {
        const runs: Record<string, number>[] = [];
        let network;
        for (let i = 0; i < RUNS; i++) {
          const t = await tab(browser);
          runs.push(await t.load(url, LOAD_CHECKS));
          network ??= t.network();
          await t.close();
        }
        results.cold = { fcp: summary(runs.map((r) => r.fcp!)), shell: summary(runs.map((r) => r.shell!)), thread: summary(runs.map((r) => r.thread!)), network };
        console.log("cold", JSON.stringify(results.cold));
      }
      if (want("warm")) {
        const t = await tab(browser);
        await t.load(url, LOAD_CHECKS);
        await Bun.sleep(1500);
        const runs: Record<string, number>[] = [];
        let network;
        for (let i = 0; i < RUNS; i++) {
          runs.push(await t.load("reload", LOAD_CHECKS));
          network = t.network();
          await Bun.sleep(1000);
        }
        results.warm = { fcp: summary(runs.map((r) => r.fcp!)), shell: summary(runs.map((r) => r.shell!)), thread: summary(runs.map((r) => r.thread!)), network };
        console.log("warm", JSON.stringify(results.warm));
        if (t.console.length) console.log("console:", t.console.slice(0, 10));
        await t.close();
      }
    });
  }

  // ------------------------------------------------------------------ interactions
  if (want("switch") || want("bots")) {
    await withServer(async (box) => {
      await Bun.sleep(4000);
      const t = await tab(browser);
      await t.load(`${box.url}/thread-${LANDING.id}`, LOAD_CHECKS);
      await Bun.sleep(3000);
      if (want("switch")) {
        const passes: { first: Record<string, number>[]; again: Record<string, number>[] } = { first: [], again: [] };
        for (const pass of ["first", "again"] as const) {
          for (const target of SWITCHES) {
            const r = await t.interact(() => t.click(rowFor(target.id)), threadShown(target));
            passes[pass].push({ ...r, kb: Math.round(target.bytes / 1024), messages: target.messages });
            await Bun.sleep(400);
          }
        }
        results.switch = {
          first: summary(passes.first.map((r) => r.ms!)), again: summary(passes.again.map((r) => r.ms!)),
          blockedFirst: summary(passes.first.map((r) => r.blocked!)), blockedAgain: summary(passes.again.map((r) => r.blocked!)),
          detail: passes,
        };
        console.log("switch", JSON.stringify(results.switch));
      }
      if (want("bots")) {
        const into: number[] = [], back: number[] = [], blocked: number[] = [];
        const botsShown = "!!document.querySelector('.bots-messages .bm-row')?.checkVisibility()";
        const threadsShown = "!!document.querySelector('.messages-inner [data-message-id]')?.checkVisibility() && !document.querySelector('.bots-messages')?.checkVisibility()";
        for (let i = 0; i < RUNS; i++) {
          const a = await t.interact(() => t.clickWhere(VISIBLE_TOGGLE), botsShown);
          into.push(a.ms); blocked.push(a.blocked);
          await Bun.sleep(600);
          const b = await t.interact(() => t.clickWhere(VISIBLE_TOGGLE), threadsShown);
          back.push(b.ms); blocked.push(b.blocked);
          await Bun.sleep(600);
        }
        // Between OpenBots chats, by clicking their rows.
        await t.interact(() => t.clickWhere(VISIBLE_TOGGLE), botsShown);
        await Bun.sleep(600);
        const chats: number[] = [];
        for (let pass = 0; pass < 2; pass++) {
          for (const c of BOT_CHATS) {
            const shown = `!!document.querySelector('.bots-messages [data-id="${c.last}"]')?.checkVisibility()`;
            const already = await t.eval<boolean>(shown);
            if (already) continue;
            // Rows carry no id: the one showing this chat's title.
            const r = await t.interact(() => t.clickWhere(`[...document.querySelectorAll('.bots-row-main')].find((r) => r.checkVisibility() && r.querySelector('.bots-row-title')?.textContent === ${JSON.stringify(c.title)})`), shown);
            chats.push(r.ms);
            await Bun.sleep(400);
          }
        }
        results.bots = { into: summary(into), back: summary(back), blocked: summary(blocked), chats: summary(chats), chatIds: BOT_CHATS.map((c) => `${c.title} (${c.n})`) };
        console.log("bots", JSON.stringify(results.bots));
      }
      if (t.console.length) console.log("console:", t.console.slice(0, 10));
      await t.close();
    });
  }

  // ------------------------------------------------------------------ server restarts
  if (want("restart")) {
    await withServer(async (box) => {
      await Bun.sleep(4000);
      const t = await tab(browser);
      await t.load(`${box.url}/thread-${LANDING.id}`, LOAD_CHECKS);
      await Bun.sleep(3000);
      const live: number[] = [], fresh: number[] = [], listen: number[] = [];
      for (let i = 0; i < Math.min(RUNS, 3); i++) {
        await box.stop();
        await Bun.sleep(1500);
        listen.push(await box.start());
        const t0 = await t.eval<number>("performance.now()");
        // Talking to the server again: any API call answering after it came back.
        await t.until(`window.__apiOk.some(([at]) => at > ${t0})`, 60_000);
        live.push(Math.round((await t.eval<number>(`window.__apiOk.find(([at]) => at > ${t0})[0]`)) - t0));
        // The thread list read again from the restarted server.
        await t.until(`window.__apiOk.some(([at, p]) => at > ${t0} && p.startsWith('/api/chats?summaries'))`, 60_000);
        fresh.push(Math.round((await t.eval<number>(`window.__apiOk.find(([at, p]) => at > ${t0} && p.startsWith('/api/chats?summaries'))[0]`)) - t0));
        await Bun.sleep(2000);
      }
      // A reload straight after a restart: the server's caches are cold and its warm-up is running.
      const reload: Record<string, number>[] = [];
      for (let i = 0; i < Math.min(RUNS, 3); i++) {
        await box.stop();
        await box.start();
        reload.push(await t.load("reload", LOAD_CHECKS));
        await Bun.sleep(1000);
      }
      results.restart = {
        serverListening: summary(listen.map(Math.round)), backOnline: summary(live), threadListFresh: summary(fresh),
        reloadAfterRestart: { shell: summary(reload.map((r) => r.shell!)), thread: summary(reload.map((r) => r.thread!)) },
      };
      console.log("restart", JSON.stringify(results.restart));
      await t.close();
    });
  }
} finally {
  await browser.close();
}

const out = flag("out");
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
