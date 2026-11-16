// How long a bot's Pi takes to summarize a long session (compaction), and what the summary costs:
// seconds, the summary's size, and the summarizing request's tokens. It starts a Pi exactly as the
// runner starts a bot's (same flags, settings and extension) on a throwaway data directory and a Pi
// set up like nobody's, hands it a long session, and asks it to compact.
//
//   bun scripts/bot-compaction-bench.ts --model default                      a made-up session of about 100k tokens
//   bun scripts/bot-compaction-bench.ts --model default --chars 250000       a smaller one
//   bun scripts/bot-compaction-bench.ts --model default --session copy.jsonl a copy of a real session file (never a live one)
//   bun scripts/bot-compaction-bench.ts --model default --runs 3 --json out.json
//   OPENBOTS_SUMMARY=pi bun scripts/bot-compaction-bench.ts --model default        Pi's own summary, as before the bots extension wrote it
//   OPENBOTS_SUMMARY_MODEL=claude-code/claude-sonnet-5 bun scripts/…               the extension's summary on a model you name
//
// It runs one real summarizing request per run on the model you name, with this user's own sign-in
// (see scripts/bot-turn-timeline.ts). The made-up session plants a handful of facts a bot would need
// later (a pull request, a deadline, a decision) and the result says how many the summary kept. It
// prints numbers only, and with --show the summary of the made-up session; never a real one's text.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { throwawayEnv } from "./bot-turn-timeline";

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const flag = (name: string) => args.includes(name);

export interface CompactionRun {
  /** From asking Pi to compact to its answer. */
  ms: number;
  summaryChars: number;
  /** The context Pi counted before compacting. */
  tokensBefore?: number;
  /** The summarizing request's tokens, as the provider reported them. */
  input: number;
  cacheWrite: number;
  output: number;
  /** The summary came from the bots extension (its own, faster request) and not from Pi's default. */
  fromExtension: boolean;
  /** The model the extension's summary was written on. */
  by?: string;
  /** Of the facts planted in a made-up session, how many the summary still has. */
  kept?: number;
  planted?: number;
  error?: string;
}

// ------------------------------------------------------------------ a made-up session

/** Facts a bot needs after a compaction, each said once somewhere in the session. `needle` is what the summary must still contain. */
const FACTS: { say: string; needle: RegExp }[] = [
  { say: "The landing page fix is in pull request #412 on the web repo; it waits on Carla's review.", needle: /#?412/ },
  { say: "Northwind's invoice INV-2291 is due on the 28th.", needle: /INV-2291/ },
  { say: "I decided we go with the darker palette, option B, for the rebrand.", needle: /option B|darker palette/i },
  { say: "The staging server is at staging.northwind.example and deploys from the release branch.", needle: /staging\.northwind\.example/ },
  { say: "Don't book anything for the Porto offsite before Noa confirms her dates, she said by Friday.", needle: /Noa/ },
  { say: "The coding thread for the checkout bug is 7f3a9c1e; tell me when it has a pull request.", needle: /7f3a9c1e/ },
  { say: "Use the Studio calendar for work things, never Home.", needle: /Studio calendar|calendar.{0,20}Studio/i },
  { say: "The type licence audit found two fonts unlicensed: Halyard and Canela.", needle: /Halyard|Canela/ },
];

const SUBJECTS = ["the Northwind rebrand", "the studio's lease renewal", "the Porto offsite", "Q3 invoices", "the new portfolio site", "hiring a junior designer", "the accountant's questions", "the checkout bug", "the type licence audit"];
const ASKS = ["can you check where we are on", "what's left to do for", "pull together the open points on", "any news on", "remind me what we decided about"];
const OUTPUT_LINES = ["PASS  src/checkout/cart.test.ts (12 tests)", "warning: 3 files changed since the last deploy", "drwxr-xr-x  4 bot bot  4096 notes/", "2026-11-12 09:14:03 GET /api/orders 200 41ms", "found 14 matches in 6 files", "invoice_2291.pdf  182 KB  modified yesterday", "branch release is 2 commits ahead of main", "calendar: 3 events this week, 1 clash on Thursday"];

/** A session file as Pi writes one for a bot, about `chars` long: weeks of chat, shell calls and their output. */
export function madeUpSession(chars: number, model: { provider: string; id: string }): string {
  const lines: string[] = [];
  let parent: string | null = null;
  let n = 0;
  let at = Date.parse("2026-11-01T08:00:00Z");
  const id = () => (++n).toString(16).padStart(8, "0");
  const add = (entry: Record<string, unknown>) => {
    const own = id();
    at += 20_000;
    lines.push(JSON.stringify({ ...entry, id: own, parentId: parent, timestamp: new Date(at).toISOString() }));
    parent = own;
  };
  lines.push(JSON.stringify({ type: "session", version: 3, id: crypto.randomUUID(), timestamp: new Date(at).toISOString(), cwd: "/tmp" }));
  add({ type: "model_change", provider: model.provider, modelId: model.id });
  const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const assistant = (content: unknown[], stopReason: string, size: number) => add({ type: "message", message: { role: "assistant", content, api: "bench", provider: model.provider, model: model.id, usage: usage(Math.round(size / 4), 60), stopReason, timestamp: at } });
  let size = 0;
  let turn = 0;
  const due = FACTS.map((_, i) => Math.floor(((i + 0.5) / FACTS.length) * 0.8 * chars));
  while (size < chars) {
    const subject = SUBJECTS[turn % SUBJECTS.length]!;
    const fact = due.length && size >= due[0]! ? (due.shift(), FACTS[FACTS.length - due.length - 1]!.say) : "";
    const said = `${fact ? `${fact} ` : ""}${ASKS[turn % ASKS.length]} ${subject}?`;
    const prompt = `Conversation 3fa91c22 (direct, “Boss”):\n[${id()}] Gal: ${said}\n\nThe time is ${new Date(at).toString()}.\n\nUse send_message to reply (one call per bubble, in this conversation unless you name another; done true on the last one ends the turn). If there's nothing to say, send nothing and end with the plain reply [silent].`;
    add({ type: "message", message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: at } });
    // A turn: look something up in the shell (sometimes a long output), then answer.
    const rows = 20 + ((turn * 37) % 140);
    const output = Array.from({ length: rows }, (_, i) => `${OUTPUT_LINES[(turn + i) % OUTPUT_LINES.length]} [${turn}.${i}]`).join("\n");
    const callId = `call_${id()}`;
    assistant([{ type: "toolCall", id: callId, name: "bash", arguments: { status: `Checking ${subject}`, command: `grep -rn "${subject.split(" ").pop()}" notes/ | head -${rows}` } }], "toolUse", size);
    add({ type: "message", message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: JSON.stringify({ exitCode: 0, output, truncated: false }, null, 2) }], isError: false, timestamp: at } });
    const answer = `On ${subject}: ${rows} lines in the notes mention it. The open points are the review on Thursday and the budget, which is ${100 + turn * 13} over. I'll bring it up again once the review is done.`;
    const sendId = `call_${id()}`;
    assistant([{ type: "toolCall", id: sendId, name: "send_message", arguments: { text: answer, done: true } }], "toolUse", size);
    add({ type: "message", message: { role: "toolResult", toolCallId: sendId, toolName: "send_message", content: [{ type: "text", text: `Sent as [${id()}] in conversation 3fa91c22.` }], isError: false, timestamp: at } });
    size = lines.reduce((sum, line) => sum + line.length, 0);
    turn++;
  }
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------ the child: one Pi, one compaction

async function child() {
  const model = option("--model")!;
  const out = option("--out")!;
  const given = option("--session");
  const base = option("--dir")!;
  const { PiProcess } = await import("../server/pi/rpc");
  const { piFlags } = await import("../server/bots/extensions");
  const { compactionPolicy } = await import("../server/bots/sessionPolicy");
  const sessions = join(base, "session");
  const work = join(base, "work");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(work, ".pi"), { recursive: true });
  writeFileSync(join(work, ".pi", "settings.json"), JSON.stringify({ compaction: compactionPolicy([]), steeringMode: "all" }));
  const slash = model.indexOf("/");
  const wanted = model === "default" ? { provider: "claude-code", id: "default" } : { provider: model.slice(0, slash), id: model.slice(slash + 1) };
  // Pi resumes a session by id only from the folder it was written in, which its first line names.
  const source = given ? readFileSync(given, "utf8") : madeUpSession(Number(option("--chars") ?? 420_000), wanted);
  const [first, ...rest] = source.split("\n");
  const header = JSON.parse(first!) as { id: string; cwd: string };
  const id = header.id;
  const path = join(sessions, `2026-11-01T08-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, [JSON.stringify({ ...header, cwd: work }), ...rest].join("\n"));

  const proc = new PiProcess(["--approve", "--session-dir", sessions, "--session-id", id, ...piFlags()], work, { OPENBOTS_SOCKET: join(base, "no.sock"), OPENBOTS_TOKEN: "none", OPENBOTS_BOT: "bench", OPENBOTS_PRELOAD: "bash" });
  const run: CompactionRun = { ms: 0, summaryChars: 0, input: 0, cacheWrite: 0, output: 0, fromExtension: false };
  try {
    await proc.send({ type: "get_state" }, 60_000);
    // A Pi that's just started lists a provider's models only once its sign-in check is back.
    for (let tries = 0; ; tries++) {
      try {
        await proc.send({ type: "set_model", provider: wanted.provider, modelId: wanted.id }, 20_000);
        break;
      } catch (err) {
        if (tries > 40) throw err;
        await Bun.sleep(500);
      }
    }
    const started = Date.now();
    const result = await proc.send<{ tokensBefore?: number }>({ type: "compact" }, 15 * 60_000);
    run.ms = Date.now() - started;
    run.tokensBefore = result?.tokensBefore;
    const entries = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; summary?: string; fromHook?: boolean; usage?: Record<string, number>; details?: { model?: string } });
    const compaction = entries.findLast((entry) => entry.type === "compaction");
    if (!compaction) throw new Error("Pi answered, but the session has no compaction entry.");
    const summary = compaction.summary ?? "";
    run.summaryChars = summary.length;
    run.fromExtension = !!compaction.fromHook;
    run.by = compaction.fromHook ? compaction.details?.model : undefined;
    // What the request read, from the cache or not: the same text summarized twice in a row is read from it.
    run.input = (compaction.usage?.input ?? 0) + (compaction.usage?.cacheRead ?? 0);
    run.cacheWrite = compaction.usage?.cacheWrite ?? 0;
    run.output = compaction.usage?.output ?? 0;
    // --save keeps the summary in a file of yours, to compare two of them: it's never printed.
    if (option("--save")) writeFileSync(option("--save")!, summary);
    if (!given) {
      run.planted = FACTS.length;
      run.kept = FACTS.filter((fact) => fact.needle.test(summary)).length;
      if (flag("--show")) console.log(`\n----- summary (${summary.length} characters) -----\n${summary}\n-----`);
    }
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err);
  } finally {
    proc.close();
  }
  writeFileSync(out, JSON.stringify(run));
  await Bun.sleep(200);
  process.exit(0);
}

// ------------------------------------------------------------------ the driver

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function driver() {
  const model = option("--model");
  if (!model || flag("--help") || flag("-h")) {
    console.log("Usage: bun scripts/bot-compaction-bench.ts --model provider/id|default [--session copy.jsonl] [--chars n] [--runs n] [--show] [--save summary.txt] [--json out.json] [--keep]");
    process.exit(model ? 0 : 1);
  }
  const given = option("--session");
  if (given && !existsSync(given)) throw new Error(`No session file at ${given}.`);
  const runs = Number(option("--runs") ?? 1);
  const root = mkdtempSync(join(process.env.TIMELINE_TMP || tmpdir(), "openbuild-compaction-bench-"));
  const results: CompactionRun[] = [];
  try {
    for (let i = 0; i < runs; i++) {
      const dir = join(root, `run-${i + 1}`);
      mkdirSync(dir, { recursive: true });
      const out = join(dir, "result.json");
      const passed = ["--model", model, "--out", out, "--dir", dir, ...(given ? ["--session", resolve(given)] : []), ...(option("--chars") ? ["--chars", option("--chars")!] : []), ...(flag("--show") ? ["--show"] : []), ...(option("--save") ? ["--save", resolve(option("--save")!)] : [])];
      const proc = spawn(process.execPath, [import.meta.path, "--child", ...passed], { cwd: resolve(import.meta.dir, ".."), env: { ...throwawayEnv(dir, model), ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => /^OPENBOTS_SUMMARY/.test(e[0]) && e[1] !== undefined)) }, stdio: ["ignore", "inherit", "inherit"] });
      await new Promise<void>((done) => proc.on("close", () => done()));
      if (!existsSync(out)) {
        console.error(`Run ${i + 1} left no result.`);
        continue;
      }
      const run = JSON.parse(readFileSync(out, "utf8")) as CompactionRun;
      results.push(run);
      console.log(run.error ? `run ${i + 1}: failed: ${run.error}` : `run ${i + 1}: ${seconds(run.ms)}, summary ${run.summaryChars} characters, request ${run.input + run.cacheWrite} tokens in and ${run.output} out, context before ${run.tokensBefore ?? "?"} tokens, ${run.fromExtension ? `the bots extension's summary${run.by ? ` on ${run.by}` : ""}` : "Pi's default summary"}${run.planted ? `, kept ${run.kept} of ${run.planted} planted facts` : ""}`);
    }
    if (option("--json")) writeFileSync(option("--json")!, JSON.stringify({ model, at: new Date().toISOString(), session: given ? "copy" : "made up", runs: results }, null, 1));
  } finally {
    if (flag("--keep")) console.log(`Kept: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await (flag("--child") ? child() : driver());
