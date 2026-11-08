// Offline only. Point at an isolated copy, never a live session directory.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[2];
if (!root) throw new Error("Usage: bun scripts/bot-session-baseline.ts <copied-session-directory>");
for (const file of readdirSync(root).filter(f => f.endsWith(".jsonl"))) {
  let compactions = 0, calls = 0, peakInput = 0, repeatedBytes = 0, promptBytes = 0;
  const seen = new Set<string>();
  for (const line of readFileSync(join(root, file), "utf8").split("\n")) {
    let entry: any; try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "compaction") compactions++;
    const m = entry.message;
    if (m?.role === "assistant" && m.usage) {
      calls++;
      peakInput = Math.max(peakInput, (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0));
    }
    if (m?.role !== "user") continue;
    for (const part of m.content ?? []) {
      if (part.type !== "text") continue;
      promptBytes += Buffer.byteLength(part.text);
      // Historical prompts used short IDs; diagnostic estimate only, never delivery identity.
      for (const row of part.text.split("\n").filter((s: string) => /^\[[\da-f]{8}\]/.test(s))) {
        const key = row.replace(/ \[already seen\]/g, "");
        if (seen.has(key)) repeatedBytes += Buffer.byteLength(row); else seen.add(key);
      }
    }
  }
  // Never print prompt content, names, session identifiers, tool arguments or credentials.
  console.log(JSON.stringify({ bytes: statSync(join(root, file)).size, compactions, calls, actualPeakInputIncludingCache: peakInput,
    promptBytes, estimatedRepeatedRowBytes: repeatedBytes, estimatedAvoidableTokensAt4Bytes: Math.round(repeatedBytes / 4) }));
}
