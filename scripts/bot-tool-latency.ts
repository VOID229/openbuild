// What the detach thresholds and the result cap in server/bots/jobs.ts were decided from: how long
// bots' real tool calls take, how big their results are, and where the user's messages land.
// Read-only, and it prints numbers only: never a prompt, a tool argument, a name or an id.
//
//   bun scripts/bot-tool-latency.ts [bots data directory, default <data dir>/bots]
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../server/paths";

const root = process.argv[2] || join(dataDir(), "bots");
const sessions = join(root, "sessions");
if (!existsSync(sessions)) throw new Error(`No bot sessions under ${root}`);

/** The tools a call can detach from (jobs.ts DETACHABLE). Kept here by name so the script reads old sessions too. */
const DETACHABLE = new Set(["bash", "read", "write", "edit", "browser", "process", "openbuild", "use_app", "bot_web_search"]);

interface Call { tool: string; ms: number; chars: number; start: number; end: number }
interface Span { start: number; end: number; kind: "model" | "tool"; detachable?: boolean }

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : name.endsWith(".jsonl") ? [path] : [];
  });
}

/** One session file's tool calls and model calls, as spans on the clock. */
function read(file: string): { calls: Call[]; spans: Span[]; model: number[] } {
  const calls: Call[] = [];
  const spans: Span[] = [];
  const model: number[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const m = entry?.type === "message" ? entry.message : undefined;
    if (!m || typeof m.timestamp !== "number") continue;
    if (m.role === "assistant" && typeof m.durationMs === "number") {
      model.push(m.durationMs);
      spans.push({ start: m.timestamp, end: m.timestamp + m.durationMs, kind: "model" });
    }
    if (m.role === "toolResult" && typeof m.durationMs === "number") {
      const chars = (m.content ?? []).reduce((n: number, part: any) => n + (part?.type === "text" ? String(part.text ?? "").length : 0), 0);
      const tool = String(m.toolName ?? "");
      calls.push({ tool, ms: m.durationMs, chars, start: m.timestamp - m.durationMs, end: m.timestamp });
      spans.push({ start: m.timestamp - m.durationMs, end: m.timestamp, kind: "tool", detachable: DETACHABLE.has(tool) });
    }
  }
  return { calls, spans, model };
}

const q = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0;
};
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const s = (ms: number) => (ms / 1000).toFixed(ms < 10_000 ? 2 : 1);
const pct = (part: number, whole: number) => `${whole ? ((100 * part) / whole).toFixed(1) : "0.0"}%`;
const row = (cells: (string | number)[], widths: number[]) => cells.map((c, i) => String(c).padStart(widths[i]!)).join(" ");

const all = files(sessions).map((file) => ({ file, ...read(file) }));
const calls = all.flatMap((f) => f.calls);
const model = all.flatMap((f) => f.model);
console.log(`${all.length} session files, ${calls.length} tool calls, ${model.length} model calls`);
console.log(`\nA model call, seconds: p25 ${s(q(model, 0.25))}  p50 ${s(q(model, 0.5))}  p75 ${s(q(model, 0.75))}  p90 ${s(q(model, 0.9))}  mean ${s(mean(model))}`);
const MODEL_P50 = q(model, 0.5);

// ------------------------------------------------------------------ 1. how long each tool takes
console.log("\n1. Tool latency, seconds, and result size, characters");
const W = [16, 6, 7, 7, 7, 7, 8, 7, 8, 8, 8];
console.log(row(["tool", "calls", "p50", "p90", "p95", "p99", "max", ">8s", "ch p50", "ch p90", "ch max"], W));
const byTool = new Map<string, Call[]>();
for (const c of calls) byTool.set(c.tool, [...(byTool.get(c.tool) ?? []), c]);
for (const [tool, list] of [...byTool].sort((a, b) => b[1].length - a[1].length)) {
  const ms = list.map((c) => c.ms);
  const ch = list.map((c) => c.chars);
  console.log(row([`${tool}${DETACHABLE.has(tool) ? " *" : ""}`, list.length, s(q(ms, 0.5)), s(q(ms, 0.9)), s(q(ms, 0.95)), s(q(ms, 0.99)), s(Math.max(...ms)), pct(ms.filter((d) => d > 8000).length, ms.length), q(ch, 0.5), q(ch, 0.9), Math.max(...ch)], W));
}
console.log("* can detach");

// ------------------------------------------------------------------ 2. the detach threshold
const work = calls.filter((c) => DETACHABLE.has(c.tool)).map((c) => c.ms);
const total = work.reduce((a, b) => a + b, 0);
console.log(`\n2. Detaching at T, over the ${work.length} calls that can detach (${s(total)} s of tool time)`);
console.log("   left = how much longer a call still running at T goes on; wasted = it ends within one median model call of T,");
console.log("   so the turn that was told “started” is still answering when the result is already there.");
const W2 = [5, 9, 8, 10, 10, 10, 9];
console.log(row(["T s", "detached", "of calls", "left p50", "left mean", "time freed", "wasted"], W2));
for (const T of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 30]) {
  const left = work.filter((d) => d > T * 1000).map((d) => d - T * 1000);
  if (!left.length) continue;
  console.log(row([T, left.length, pct(left.length, work.length), s(q(left, 0.5)), s(mean(left)), pct(left.reduce((a, b) => a + b, 0), total), pct(left.filter((d) => d <= MODEL_P50).length, left.length)], W2));
}

// ------------------------------------------------------------------ 3. the shape of a result
console.log("\n3. Results of calls that ran past 8 s: whole up to N characters, else a summary of S");
const slow = calls.filter((c) => DETACHABLE.has(c.tool) && c.ms > 8000).map((c) => c.chars);
console.log(`   ${slow.length} results: p50 ${q(slow, 0.5)}  p75 ${q(slow, 0.75)}  p90 ${q(slow, 0.9)}  p95 ${q(slow, 0.95)}  p99 ${q(slow, 0.99)}  max ${Math.max(0, ...slow)}  mean ${Math.round(mean(slow))}`);
const W3 = [7, 7, 11, 12, 11, 13];
console.log(row(["N", "S", "come whole", "mean chars", "max chars", "of all chars"], W3));
const everything = slow.reduce((a, b) => a + b, 0);
for (const [N, S] of [[1000, 1000], [2000, 2000], [4000, 2000], [6000, 2000], [8000, 2000], [12000, 2000], [6000, 6000], [100000, 0]] as const) {
  const sent = slow.map((n) => (n <= N ? n : S));
  console.log(row([N, S, pct(slow.filter((n) => n <= N).length, slow.length), Math.round(mean(sent)), Math.max(0, ...sent), pct(sent.reduce((a, b) => a + b, 0), everything)], W3));
}

// ------------------------------------------------------------------ 4. a message that lands mid-call
// A message arrives when it arrives, whatever the bot is doing, so the calls it lands in are sampled by
// how long they run: every moment of tool time is as likely as any other.
console.log("\n4. A message landing at a random moment inside a call that can detach, when a waited-on call detaches at W");
console.log("   wait = until the bot can read it; wasted = the call would have returned within one median model call anyway");
const W4 = [5, 10, 10, 10, 10, 10, 9];
console.log(row(["W s", "wait mean", "wait p50", "wait p90", "wait max", "detaches", "wasted"], W4));
for (const W of [0, 1, 2, 3, 4, 5, 8, Infinity]) {
  const points: { wait: number; weight: number }[] = [];
  let detaches = 0, wasted = 0, weightAll = 0;
  for (const d of work) {
    const steps = 50;
    for (let k = 0; k < steps; k++) {
      const e = ((k + 0.5) / steps) * d;
      const weight = d / steps;
      const at = Math.max(e, W * 1000);
      const detached = d > at;
      points.push({ wait: (detached ? at : d) - e, weight });
      weightAll += weight;
      if (detached) { detaches += weight; if (d - at <= MODEL_P50) wasted += weight; }
    }
  }
  points.sort((a, b) => a.wait - b.wait);
  const at = (p: number) => { let seen = 0; for (const x of points) { seen += x.weight; if (seen >= p * weightAll) return x.wait; } return 0; };
  const avg = points.reduce((n, x) => n + x.wait * x.weight, 0) / weightAll;
  console.log(row([Number.isFinite(W) ? W : "never", s(avg), s(at(0.5)), s(at(0.9)), s(points.at(-1)!.wait), pct(detaches, weightAll), pct(wasted, detaches || 1)], W4));
}

// ------------------------------------------------------------------ 5. where the user's messages did land
const dbFile = join(root, "bots.sqlite");
if (existsSync(dbFile)) {
  const db = new Database(dbFile, { readonly: true });
  const lane = (bot: string, conversation: string) => createHash("sha256").update(JSON.stringify([bot, conversation, "main"])).digest("hex");
  const conversations = (db.query("select id, data from conversations").all() as { id: string; data: string }[]).map((r) => ({ id: r.id, ...(JSON.parse(r.data) as { kind?: string; botIds?: string[] }) }));
  const spansOf = new Map<string, Span[]>();
  for (const c of conversations) {
    for (const bot of c.botIds ?? []) {
      const dir = lane(bot, c.id);
      const mine = all.filter((f) => f.file.includes(`/${dir}/`) || f.file.endsWith(`_${bot}.jsonl`)).flatMap((f) => f.spans);
      spansOf.set(bot, [...(spansOf.get(bot) ?? []), ...mine]);
    }
  }
  for (const [bot, spans] of spansOf) spansOf.set(bot, [...new Map(spans.map((x) => [`${x.start}:${x.end}:${x.kind}`, x])).values()].sort((a, b) => a.start - b.start));
  const first = Math.min(...[...spansOf.values()].flat().map((x) => x.start));
  console.log("\n5. The user's own messages, by what each bot they reached was doing when one arrived (a turn = calls less than 2 s apart)");
  for (const kind of ["direct", "group"]) {
    let pairs = 0, idle = 0, between = 0, inModel = 0, inTool = 0, inDetachable = 0;
    const waits: number[] = [];
    for (const c of conversations.filter((x) => x.kind === kind)) {
      const sent = db.query("select at from messages where conversation_id = ? and author = 'me' and at >= ?").all(c.id, first) as { at: number }[];
      for (const bot of c.botIds ?? []) {
        const spans = spansOf.get(bot) ?? [];
        for (const m of sent) {
          pairs++;
          const hit = spans.find((x) => x.start <= m.at && m.at < x.end);
          if (!hit) {
            const before = spans.findLast((x) => x.end <= m.at);
            const after = spans.find((x) => x.start > m.at);
            if (before && after && after.start - before.end < 2000) between++;
            else idle++;
            continue;
          }
          if (hit.kind === "model") { inModel++; continue; }
          inTool++;
          if (!hit.detachable) continue;
          inDetachable++;
          waits.push(hit.end - m.at);
        }
      }
    }
    console.log(`   ${kind}: ${pairs} deliveries. idle ${pct(idle, pairs)}   between two calls ${pct(between, pairs)}   in a model call ${pct(inModel, pairs)}   inside a tool call ${pct(inTool, pairs)}, ${pct(inDetachable, pairs)} in one that can detach (${inDetachable})`);
    if (waits.length) console.log(`     seconds until that call returned: p50 ${s(q(waits, 0.5))}  p90 ${s(q(waits, 0.9))}  max ${s(Math.max(...waits))}`);
  }
  db.close();
}
