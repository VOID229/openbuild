import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { JOURNAL_RECENT, PROFILE_MAX_BYTES, type MemoryItem } from "../../shared/bots";

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
type MemoryLine = { id: string; text: string; at?: number };
const pad = (n: number) => String(n).padStart(2, "0");
/** The day something was written, on this machine's clock, like the time each prompt carries. */
export function memoryDate(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** One memory as a bot reads it: its short id, the day it was written, and the fact. */
export function memoryLine(item: MemoryLine, max = Infinity): string {
  const text = item.text.length > max ? `${item.text.slice(0, max - 1).trimEnd()}…` : item.text;
  return `- [${item.id.slice(0, 8)}] ${item.at === undefined ? "" : `${memoryDate(item.at)} `}${text}`;
}
/** Conservative UTF-8 byte budget: no claim of provider tokenizer precision. Lines that don't fit are left out, never cut. */
export function memoryContext(items: MemoryLine[], budget = 6000, max = Infinity): string {
  const lines: string[] = [];
  for (const item of items) {
    const line = memoryLine(item, max);
    const bytes = Buffer.byteLength(line + "\n");
    if (bytes > budget) continue;
    lines.push(line); budget -= bytes;
  }
  return lines.join("\n");
}
/** What a profile costs in the prompt: what PROFILE_MAX_BYTES caps. */
export function profileBytes(items: MemoryLine[]): number {
  return items.reduce((n, item) => n + Buffer.byteLength(memoryLine(item) + "\n"), 0);
}
/** Longest a journal entry runs in the prompt; search returns it whole. */
export const JOURNAL_LINE_MAX = 300;
/**
 * The always-on slice of a bot's memory (newest first): its whole profile, which is capped where it's
 * written, and its latest few journal entries. Everything else is reached with search, so this
 * doesn't grow with how much the bot has remembered.
 */
export function memorySection(items: MemoryItem[]): string {
  if (!items.length) return "You haven't written any memories yet.";
  const profile = items.filter((m) => m.kind === "profile");
  const journal = items.filter((m) => m.kind !== "profile");
  const recent = journal.slice(0, JOURNAL_RECENT);
  const older = journal.length - recent.length;
  return [
    profile.length ? `Your profile:\n${memoryContext(profile, PROFILE_MAX_BYTES)}` : "Your profile is empty: move the lasting facts into it.",
    recent.length ? `Your journal, newest first${older ? ` (${older} older ${older === 1 ? "entry" : "entries"}: search finds them)` : ""}:\n${memoryContext(recent, Infinity, JOURNAL_LINE_MAX)}` : "",
  ].filter(Boolean).join("\n");
}

/** Two facts with the same key are the same fact: case, spacing and punctuation don't count. */
export function memoryKey(text: string): string {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}
const FILLER = new Set(["user", "that", "this", "with", "from", "have", "they", "them", "their", "about", "when", "what", "will", "your", "does", "were", "been", "than", "then", "into", "also", "more", "most", "some", "only", "very", "just"]);
const subject = (text: string) => new Set(memoryKey(text).split(" ").filter((w) => w.length >= 4 && !FILLER.has(w)));
/**
 * Earlier facts about the same thing as `text`: at least two telling words in common, and half of the
 * shorter one's. Whether one contradicts the other is the bot's call; this only keeps a new fact from
 * landing beside an old one unseen.
 */
export function similarMemories<T extends { id: string; text: string; at: number }>(text: string, items: T[], limit = 3): T[] {
  const words = subject(text);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const theirs = subject(item.text);
    let shared = 0;
    for (const w of theirs) if (words.has(w)) shared++;
    const score = shared / Math.max(1, Math.min(words.size, theirs.size));
    if (shared >= 2 && score >= 0.5) scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.item.at - a.item.at).slice(0, limit).map((s) => s.item);
}
/** The memory a bot means: by its whole id, by its exact text, or by the short id its prompt shows. */
export function findMemory<T extends { id: string; text: string }>(items: T[], which: string): T | undefined {
  const given = which.trim();
  if (!given) return undefined;
  const key = memoryKey(given);
  const byText = items.find((m) => m.id === given) ?? items.find((m) => m.text === given) ?? (key ? items.find((m) => memoryKey(m.text) === key) : undefined);
  if (byText) return byText;
  const id = given.replace(/^\[|\]$/g, "").toLowerCase();
  const byId = /^[0-9a-f-]{4,36}$/.test(id) ? items.filter((m) => m.id.startsWith(id)) : [];
  return byId.length === 1 ? byId[0] : undefined;
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
