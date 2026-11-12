// Summarizes what bots' turns cost, from the one line per turn the runner appends to
// bots/usage.jsonl (server/bots/turnMetrics.ts): model requests per turn, how long the user waited
// for the first status, tool call and reply, prompt and cached tokens, and tool loads. Run it before
// a change and after, or with --split at the moment the change went live, to see what it did.
//
//   bun scripts/bot-turn-metrics.ts                              every turn on this machine
//   bun scripts/bot-turn-metrics.ts --since 2026-11-12           from then on (any Date.parse-able time)
//   bun scripts/bot-turn-metrics.ts --since 24h                  the last 24 hours (also 30m, 7d)
//   bun scripts/bot-turn-metrics.ts --split 2026-11-12T10:00Z    before and after that moment, side by side
//   bun scripts/bot-turn-metrics.ts copy/usage.jsonl --bot 9c59 --json
//
// Read-only, and it prints numbers and OpenBots' own tool names only: the file holds nothing else.
// Without a path it reads the live file (OPENCHAT_DATA_DIR, or this user's data directory).
// Lines from before the timing fields existed count toward requests and tokens, not the timings.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../server/paths";
import { filterTurns, formatTable, parseTurns, summarizeTurns, summaryRows } from "../server/bots/turnMetrics";

/** "24h", "30m", "7d" before now, or anything Date.parse reads. */
export function parseWhen(value: string, now = Date.now()): number {
  const ago = /^(\d+(?:\.\d+)?)([mhd])$/.exec(value.trim());
  if (ago) return now - Number(ago[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[ago[2] as "m" | "h" | "d"];
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`Can't read "${value}" as a time. Use an ISO date like 2026-11-12T10:00Z, or 24h, 30m, 7d.`);
  return at;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const VALUED = ["--since", "--until", "--split", "--bot"];
  const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const path = args.find((arg, i) => !arg.startsWith("--") && !VALUED.includes(args[i - 1] ?? "")) ?? join(dataDir(), "bots", "usage.jsonl");
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun scripts/bot-turn-metrics.ts [usage.jsonl] [--since when] [--until when] [--split when] [--bot id] [--json]");
    process.exit(0);
  }
  if (!existsSync(path)) {
    console.error(`No turn metrics at ${path}: bots haven't run a turn there yet.`);
    process.exit(1);
  }
  try {
    const since = option("--since"), until = option("--until"), split = option("--split");
    const turns = filterTurns(parseTurns(readFileSync(path, "utf8")), { since: since ? parseWhen(since) : undefined, until: until ? parseWhen(until) : undefined, bot: option("--bot") });
    const at = split ? parseWhen(split) : undefined;
    const groups = at === undefined ? [{ name: "Turns", turns }] : [{ name: "Before", turns: turns.filter((r) => r.at < at) }, { name: "After", turns: turns.filter((r) => r.at >= at) }];
    const summaries = groups.map((g) => summarizeTurns(g.turns));
    if (args.includes("--json")) console.log(JSON.stringify(at === undefined ? summaries[0] : { before: summaries[0], after: summaries[1] }, null, 1));
    else console.log(formatTable(["", ...groups.map((g) => g.name)], summaryRows(summaries)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
