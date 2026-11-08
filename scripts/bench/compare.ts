// Two bench.ts results side by side, as a Markdown table of medians (ms).
//
//   bun scripts/bench/compare.ts before.json after.json [label]
import { readFileSync } from "node:fs";

const [beforePath, afterPath, label = ""] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error("usage: compare.ts before.json after.json [label]");
const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const before = read(beforePath);
const after = read(afterPath);

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

const lines = [`| ${label} | before | after | |`, "|---|---:|---:|---:|"];
for (const [name, path] of ROWS) {
  const a = at(before, path);
  const b = at(after, path);
  if (a === undefined && b === undefined) continue;
  const ratio = a && b ? (a / b >= 1.05 ? `${(a / b).toFixed(1)}× faster` : b / a >= 1.05 ? `${(b / a).toFixed(1)}× slower` : "same") : "";
  lines.push(`| ${name} | ${a ?? "–"} | ${b ?? "–"} | ${ratio} |`);
}
for (const kind of ["cold", "warm"] as const) {
  if (kb(before, kind) || kb(after, kind)) lines.push(`| ${kind} load: transferred | ${kb(before, kind) ?? "–"} | ${kb(after, kind) ?? "–"} | |`);
}
console.log(lines.join("\n"));
