// Offline only. Point at an isolated copy of bot session files, never a live session directory.
// Prints numeric aggregates only: no prompt text, names, ids, tool arguments or credentials.
//
// For every assistant call it splits the provider-reported input into uncached input, cache reads
// and cache writes, and estimates how much of that context was mid-conversation system patches
// (Pi re-sends a whole system prompt section whenever its text changes). Patches that differ from
// the section before them only by OpenBots' clock line are counted as avoidable; for the others, the
// unchanged paragraphs of a re-sent section are counted apart, as what splitting the context into
// sections of its own saves. Compaction usage is reported on its own: bots/usage.jsonl excludes it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("Usage: bun scripts/bot-context-audit.ts <copied-session-directory> [--since ISO]");
const since = process.argv.includes("--since") ? Date.parse(process.argv[process.argv.indexOf("--since") + 1]!) : 0;
/** Measured on production Codex turns: a 28,590-byte system patch plus prompt cost 6,676 uncached tokens. */
const BYTES_PER_TOKEN = 4.28;
const CLOCK = /The time is [^\n]*?\./g;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".jsonl") ? [path] : [];
  });

const total = { files: 0, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, systemPatches: 0, clockOnlyPatches: 0,
  avoidableUncachedOrWrite: 0, avoidableCacheRead: 0, sectionedUncachedOrWrite: 0, sectionedCacheRead: 0, compactions: 0, compactionInput: 0, compactionCacheRead: 0, compactionCacheWrite: 0, compactionOutput: 0,
  errorCalls: 0, providerSwitches: 0 };

for (const file of walk(root)) {
  const sections: Record<string, string> = {};
  // Avoidable system bytes in context since the last compaction, and the ones not yet sent to a model.
  let liveAvoidable = 0, freshAvoidable = 0, liveSectioned = 0, freshSectioned = 0, provider: string | undefined, counted = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const at = Date.parse(entry.timestamp ?? "") || 0;
    const inWindow = at >= since;
    if (entry.type === "compaction") {
      liveAvoidable = freshAvoidable = liveSectioned = freshSectioned = 0;
      if (!inWindow) continue;
      const u = entry.usage ?? {};
      total.compactions++;
      total.compactionInput += u.input ?? 0;
      total.compactionCacheRead += u.cacheRead ?? 0;
      total.compactionCacheWrite += u.cacheWrite ?? 0;
      total.compactionOutput += u.output ?? 0;
      continue;
    }
    const m = entry.message;
    if (m?.role === "system" && m.sections) {
      let bytes = 0, unchanged = 0, clockOnly = true, any = false;
      for (const [name, text] of Object.entries(m.sections as Record<string, string | null>)) {
        if (text === null) { delete sections[name]; continue; }
        const before = sections[name];
        sections[name] = text;
        if (before === undefined) { clockOnly = false; continue; } // The first full prompt is never avoidable.
        any = true;
        bytes += Buffer.byteLength(text);
        if (before.replace(CLOCK, "") === text.replace(CLOCK, "")) continue;
        clockOnly = false;
        const kept = new Set(before.replace(CLOCK, "").split("\n\n"));
        for (const paragraph of text.replace(CLOCK, "").split("\n\n")) if (kept.has(paragraph)) unchanged += Buffer.byteLength(paragraph);
      }
      if (!any || !inWindow) continue;
      total.systemPatches++;
      if (clockOnly) {
        total.clockOnlyPatches++;
        liveAvoidable += bytes;
        freshAvoidable += bytes;
      } else {
        liveSectioned += unchanged;
        freshSectioned += unchanged;
      }
      continue;
    }
    if (m?.role !== "assistant" || !inWindow) continue;
    counted = true;
    total.calls++;
    if (m.stopReason === "error") total.errorCalls++;
    if (provider && m.provider !== provider) total.providerSwitches++;
    provider = m.provider;
    const u = m.usage ?? {};
    total.input += u.input ?? 0;
    total.cacheRead += u.cacheRead ?? 0;
    total.cacheWrite += u.cacheWrite ?? 0;
    total.output += u.output ?? 0;
    if (!u.input && !u.cacheRead && !u.cacheWrite) continue; // A failed call read nothing.
    // Fresh patches are paid uncached (or as a cache write) by the first call that sees them; later calls read them from cache.
    total.avoidableUncachedOrWrite += freshAvoidable / BYTES_PER_TOKEN;
    total.avoidableCacheRead += (liveAvoidable - freshAvoidable) / BYTES_PER_TOKEN;
    total.sectionedUncachedOrWrite += freshSectioned / BYTES_PER_TOKEN;
    total.sectionedCacheRead += (liveSectioned - freshSectioned) / BYTES_PER_TOKEN;
    freshAvoidable = freshSectioned = 0;
  }
  if (counted) total.files++;
}

const rounded = Object.fromEntries(Object.entries(total).map(([k, v]) => [k, Math.round(v)]));
const contextInput = total.input + total.cacheRead + total.cacheWrite;
console.log(JSON.stringify({
  ...rounded,
  contextInput,
  avoidableShareOfContextInput: +((total.avoidableUncachedOrWrite + total.avoidableCacheRead) / Math.max(1, contextInput)).toFixed(3),
  avoidableShareOfUncachedAndWrites: +(total.avoidableUncachedOrWrite / Math.max(1, total.input + total.cacheWrite)).toFixed(3),
  sectionedShareOfContextInput: +((total.sectionedUncachedOrWrite + total.sectionedCacheRead) / Math.max(1, contextInput)).toFixed(3),
  estimate: `system bytes / ${BYTES_PER_TOKEN}; provider usage fields are reported, not tokenized`,
}, null, 1));
