// bench.ts results side by side, as a Markdown table of medians (ms).
//
//   bun scripts/bench/compare.ts before.json after.json [label]
//   bun scripts/bench/compare.ts before-1.json,before-2.json after-1.json,after-2.json [label]
//
// Comma-separated results are rounds run interleaved (before, after, before, after): each cell lists
// every round's median, and the change compares each round's before with its own after.
import { readFileSync } from "node:fs";

const [beforePaths, afterPaths, label = ""] = process.argv.slice(2);
if (!beforePaths || !afterPaths) throw new Error("usage: compare.ts before.json[,…] after.json[,…] [label]");
const read = (paths: string) => paths.split(",").map((p) => JSON.parse(readFileSync(p, "utf8")));
const before = read(beforePaths);
const after = read(afterPaths);
if (before.length !== after.length) throw new Error("as many before rounds as after rounds");

const ROWS: [string, string][] = [
  ["cold load: thread on screen", "cold.thread"],
  ["warm reload: thread on screen", "warm.thread"],
  ["thread switch, first visit", "switch.first"],
  ["thread switch, first visit pointed at 250 ms first", "switch.firstAfterHover"],
  ["thread switch, again", "switch.again"],
  ["OpenBuild → OpenBots", "bots.into"],
  ["OpenBots → OpenBuild", "bots.back"],
  ["OpenBots chat switch", "bots.chats"],
  ["server answering after a start", "restart.serverListening"],
  ["after a restart: thread list fresh", "restart.threadListFresh"],
  ["after a restart: OpenBots stream back", "restart.botsStream"],
  ["reload right after a restart", "restart.reloadAfterRestart.thread"],
];
const at = (r: unknown, path: string) => path.split(".").reduce<any>((o, k) => o?.[k], r)?.median as number | undefined;
const kb = (r: any, kind: "cold" | "warm") => r?.[kind]?.network ? `${r[kind].network.kb} KB` : undefined;
const cell = (xs: (string | number | undefined)[]) => xs.every((x) => x === undefined) ? "–" : xs.map((x) => x ?? "–").join(", ");

const change = (r: number) => r >= 1.05 ? `${r.toFixed(1)}× faster` : 1 / r >= 1.05 ? `${(1 / r).toFixed(1)}× slower` : "same";
function changes(ratios: number[]) {
  if (!ratios.length) return "";
  const lo = Math.min(...ratios), hi = Math.max(...ratios);
  if (change(lo) === change(hi)) return change(lo);
  if (lo >= 1.05) return `${lo.toFixed(1)}–${hi.toFixed(1)}× faster`;
  if (1 / hi >= 1.05) return `${(1 / hi).toFixed(1)}–${(1 / lo).toFixed(1)}× slower`;
  return `${change(lo)} to ${change(hi)}`;
}

const lines = [`| ${label} | before | after | |`, "|---|---:|---:|---:|"];
for (const [name, path] of ROWS) {
  const a = before.map((r) => at(r, path));
  const b = after.map((r) => at(r, path));
  if ([...a, ...b].every((x) => x === undefined)) continue;
  const ratios = a.flatMap((x, i) => x && b[i] ? [x / b[i]!] : []);
  lines.push(`| ${name} | ${cell(a)} | ${cell(b)} | ${changes(ratios)} |`);
}
for (const kind of ["cold", "warm"] as const) {
  const a = before.map((r) => kb(r, kind));
  const b = after.map((r) => kb(r, kind));
  if ([...a, ...b].some(Boolean)) lines.push(`| ${kind} load: transferred | ${cell(a)} | ${cell(b)} | |`);
}
console.log(lines.join("\n"));
