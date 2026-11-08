import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

export const SESSION_MAX_BYTES = 8 * 1024 * 1024;
export const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
/** Separate directories also prevent Pi's prefix-based session lookup crossing lanes. */
export function laneDirectory(root: string, bot: string, conversation: string, lane = "main"): string {
  return join(root, createHash("sha256").update(JSON.stringify([bot, conversation, lane])).digest("hex"));
}
/** Called only after recovery, between turns. Old generations are retained verbatim. */
export function sessionGeneration(lane: string, now = Date.now()): string {
  mkdirSync(lane, { recursive: true, mode: 0o700 });
  const generations = readdirSync(lane).filter(n => /^generation-\d+$/.test(n)).sort((a,b) => Number(a.slice(11)) - Number(b.slice(11)));
  let generation = generations.at(-1) ?? `generation-${now}`;
  const dir = join(lane, generation);
  let bytes = 0;
  try { for (const name of readdirSync(dir)) if (name.endsWith(".jsonl")) bytes += statSync(join(dir, name)).size; } catch {}
  if (existsSync(join(dir, "settled")) && (bytes >= SESSION_MAX_BYTES || now - Number(generation.slice(11)) >= SESSION_MAX_AGE)) generation = `generation-${Math.max(now, Number(generation.slice(11)) + 1)}`;
  const result = join(lane, generation);
  if (result !== dir) {
    // A deterministic handoff never invokes a model. Durable assignments/notes remain in SQLite.
    let summary = "", recent = "";
    for (const name of readdirSync(dir).filter(n => n.endsWith(".jsonl"))) {
      for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
        let entry: any; try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type === "compaction" && typeof entry.summary === "string") summary = entry.summary;
        if (entry.message?.role === "assistant") {
          const text = (entry.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
          if (text) recent = (recent + "\n" + text).slice(-8000);
        }
      }
    }
    mkdirSync(result, { recursive: true, mode: 0o700 });
    writeFileSync(join(result, "handoff.txt"), `Previous session retained at ${dir}. Historical context only; do not repeat completed tools or messages. Pending assignments and settings notes are supplied separately. This bounded handoff may omit older details; use chat search for them.\n${summary.slice(-12000)}\nRecent assistant notes:\n${recent}`, { mode: 0o600 });
  }
  mkdirSync(result, { recursive: true, mode: 0o700 });
  return result;
}
/** Conservative UTF-8 byte budget: no claim of provider tokenizer precision. */
export function memoryContext(items: { id: string; text: string }[], budget = 6000): string {
  const lines: string[] = [];
  for (const item of items.slice(0, 40)) {
    const line = `- [${item.id.slice(0, 8)}] ${item.text}`;
    const bytes = Buffer.byteLength(line + "\n");
    if (bytes > budget) continue;
    lines.push(line); budget -= bytes;
  }
  return lines.join("\n");
}

export function deliveryIdentity(conversation: string, message: unknown): string {
  // Read receipts are delivery metadata, never part of the rendered transcript. markSeen()
  // updates them after rendering; hashing them would reinject an otherwise unchanged row.
  const content = message && typeof message === "object"
    ? Object.fromEntries(Object.entries(message).filter(([key]) => key !== "seenBy")) : message;
  return createHash("sha256").update(JSON.stringify([conversation, content])).digest("hex");
}
export function readDeliveries(path: string): Set<string> {
  try { return new Set(JSON.parse(readFileSync(join(path, "deliveries.json"), "utf8"))); } catch { return new Set(); }
}
export function saveDeliveries(path: string, delivered: Set<string>) {
  const file = join(path, "deliveries.json");
  writeFileSync(file + ".tmp", JSON.stringify([...delivered]), { mode: 0o600 });
  renameSync(file + ".tmp", file);
}

/** Compaction starts at 3/4 of the window, and never past COMPACT_AT, so a large-window model
 * doesn't carry (and re-bill) hundreds of thousands of cached tokens each call. Pi compacts when
 * context > window - reserveTokens, and reserveTokens is used for nothing else. */
export const COMPACT_AT = 128 * 1024;
export function compactionPolicy(models: { provider: string; id: string; contextWindow?: number }[]) {
  return {
    enabled: true, reserveTokens: 16384, keepRecentTokens: 8000,
    modelOverrides: Object.fromEntries(models.filter(m => m.contextWindow && m.contextWindow > 0).map(m => {
      const window = m.contextWindow!;
      return [`${m.provider}/${m.id}`, {
        reserveTokens: window - Math.min(COMPACT_AT, Math.floor(window * 3 / 4)),
        keepRecentTokens: Math.min(8000, Math.floor(window / 16)),
      }];
    })),
  };
}
