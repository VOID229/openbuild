// OpenBots' storage: one SQLite database in the data folder (bots/bots.sqlite), apart from
// threads. Bots, conversations, messages, memory and routines; what each bot has read of each
// conversation (cursors); and full-text indexes over memory and messages, which is how bots
// search everything they've ever been told.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Bot, BotMessage, Conversation, MemoryItem, Routine } from "../../shared/bots";
import { dataDir } from "../paths";

export const botsDir = () => join(dataDir(), "bots");

function open(): Database {
  mkdirSync(botsDir(), { recursive: true, mode: 0o700 });
  const db = new Database(join(botsDir(), "bots.sqlite"), { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, by TEXT);
    CREATE INDEX IF NOT EXISTS memories_bot ON memories(bot_id, at);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, bot_id UNINDEXED, text);
    CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, data TEXT NOT NULL, next_run_at INTEGER);
    CREATE INDEX IF NOT EXISTS routines_due ON routines(next_run_at);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL, author TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, seq);
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, conversation_id UNINDEXED, content='', contentless_delete=1);
    CREATE TABLE IF NOT EXISTS cursors (bot_id TEXT NOT NULL, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (bot_id, conversation_id));
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

const hot = globalThis as { openbotsDb?: Database };
export const db = (hot.openbotsDb ??= open());

const parse = <T>(s: string): T => JSON.parse(s) as T;

/** Words for an FTS query: any of them, prefixes allowed, best matches first. */
export function ftsQuery(text: string): string | undefined {
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 12);
  return words.length ? words.map((w) => `"${w}"*`).join(" OR ") : undefined;
}

// ------------------------------------------------------------------ kv

export function getValue<T>(key: string): T | undefined {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(key);
  return row ? parse<T>(row.value) : undefined;
}
export function setValue(key: string, value: unknown) {
  db.query("INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2").run(key, JSON.stringify(value));
}

// ------------------------------------------------------------------ bots

/** A bot as stored: without memory and routines, which have tables of their own. */
export type StoredBot = Omit<Bot, "memory" | "routines">;

export function listBots(): StoredBot[] {
  return db.query<{ data: string }, []>("SELECT data FROM bots ORDER BY created_at").all().map((r) => parse<StoredBot>(r.data));
}
export function getBot(id: string): StoredBot | undefined {
  const row = db.query<{ data: string }, [string]>("SELECT data FROM bots WHERE id = ?").get(id);
  return row ? parse<StoredBot>(row.data) : undefined;
}
export function putBot(bot: StoredBot) {
  const { memory: _m, routines: _r, ...stored } = bot as Bot;
  db.query("INSERT INTO bots (id, data, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = ?2").run(stored.id, JSON.stringify(stored), stored.createdAt);
}
export function deleteBot(id: string) {
  db.transaction(() => {
    db.query("DELETE FROM bots WHERE id = ?").run(id);
    db.query("DELETE FROM memories WHERE bot_id = ?").run(id);
    db.query("DELETE FROM memories_fts WHERE bot_id = ?").run(id);
    db.query("DELETE FROM routines WHERE bot_id = ?").run(id);
    db.query("DELETE FROM cursors WHERE bot_id = ?").run(id);
  })();
}

// ------------------------------------------------------------------ memory

export function memories(botId: string): MemoryItem[] {
  return db
    .query<{ id: string; text: string; at: number; by: string | null }, [string]>("SELECT id, text, at, by FROM memories WHERE bot_id = ? ORDER BY at DESC")
    .all(botId)
    .map((r) => ({ id: r.id, text: r.text, at: r.at, by: r.by ?? undefined }));
}
export function addMemory(botId: string, item: MemoryItem) {
  db.transaction(() => {
    db.query("INSERT INTO memories (id, bot_id, text, at, by) VALUES (?1, ?2, ?3, ?4, ?5)").run(item.id, botId, item.text, item.at, item.by ?? null);
    db.query("INSERT INTO memories_fts (id, bot_id, text) VALUES (?1, ?2, ?3)").run(item.id, botId, item.text);
  })();
}
export function removeMemory(botId: string, id: string): boolean {
  let removed = false;
  db.transaction(() => {
    removed = db.query("DELETE FROM memories WHERE id = ?1 AND bot_id = ?2").run(id, botId).changes > 0;
    db.query("DELETE FROM memories_fts WHERE id = ?1 AND bot_id = ?2").run(id, botId);
  })();
  return removed;
}
export function searchMemory(botId: string, query: string, limit = 12): MemoryItem[] {
  const q = ftsQuery(query);
  if (!q) return [];
  return db
    .query<{ id: string }, [string, string, number]>("SELECT id FROM memories_fts WHERE bot_id = ?1 AND memories_fts MATCH ?2 ORDER BY rank LIMIT ?3")
    .all(botId, q, limit)
    .map((r) => db.query<{ id: string; text: string; at: number; by: string | null }, [string]>("SELECT id, text, at, by FROM memories WHERE id = ?").get(r.id))
    .filter((r): r is NonNullable<typeof r> => !!r)
    .map((r) => ({ id: r.id, text: r.text, at: r.at, by: r.by ?? undefined }));
}

// ------------------------------------------------------------------ routines

export function routines(botId: string): Routine[] {
  return db.query<{ data: string }, [string]>("SELECT data FROM routines WHERE bot_id = ? ORDER BY rowid").all(botId).map((r) => parse<Routine>(r.data));
}
export function routineOwner(id: string): string | undefined {
  return db.query<{ bot_id: string }, [string]>("SELECT bot_id FROM routines WHERE id = ?").get(id)?.bot_id;
}
export function putRoutine(botId: string, r: Routine) {
  db.query("INSERT INTO routines (id, bot_id, data, next_run_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET data = ?3, next_run_at = ?4").run(
    r.id,
    botId,
    JSON.stringify(r),
    r.enabled && r.nextRunAt ? r.nextRunAt : null,
  );
}
export function removeRoutine(id: string) {
  return db.query("DELETE FROM routines WHERE id = ?").run(id).changes > 0;
}
export function dueRoutines(now: number): { botId: string; routine: Routine }[] {
  return db
    .query<{ bot_id: string; data: string }, [number]>("SELECT bot_id, data FROM routines WHERE next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at")
    .all(now)
    .map((r) => ({ botId: r.bot_id, routine: parse<Routine>(r.data) }));
}

// ------------------------------------------------------------------ conversations and messages

export type StoredConversation = Omit<Conversation, "messages" | "more">;

export function listConversations(): StoredConversation[] {
  return db.query<{ data: string }, []>("SELECT data FROM conversations ORDER BY updated_at DESC").all().map((r) => parse<StoredConversation>(r.data));
}
export function getConversation(id: string): StoredConversation | undefined {
  const row = db.query<{ data: string }, [string]>("SELECT data FROM conversations WHERE id = ?").get(id);
  return row ? parse<StoredConversation>(row.data) : undefined;
}
export function putConversation(c: StoredConversation) {
  const { messages: _m, more: _more, ...stored } = c as Conversation;
  db.query("INSERT INTO conversations (id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = ?2, updated_at = ?3").run(stored.id, JSON.stringify(stored), stored.updatedAt);
}
export function deleteConversation(id: string) {
  db.transaction(() => {
    for (const { seq } of db.query<{ seq: number }, [string]>("SELECT seq FROM messages WHERE conversation_id = ?").all(id)) db.query("DELETE FROM messages_fts WHERE rowid = ?").run(seq);
    db.query("DELETE FROM messages WHERE conversation_id = ?").run(id);
    db.query("DELETE FROM cursors WHERE conversation_id = ?").run(id);
    db.query("DELETE FROM conversations WHERE id = ?").run(id);
  })();
}

export interface StoredMessage {
  seq: number;
  message: BotMessage;
}

const searchable = (m: BotMessage) => [m.text, m.question?.title, ...(m.question?.options.map((o) => o.label) ?? []), ...(m.poll?.options.map((o) => o.label) ?? []), m.plan?.title, ...(m.plan?.steps.map((s) => s.text) ?? [])].filter(Boolean).join("\n");

export function addMessage(conversationId: string, m: BotMessage): number {
  let seq = 0;
  db.transaction(() => {
    seq = Number(db.query("INSERT INTO messages (id, conversation_id, author, at, data) VALUES (?1, ?2, ?3, ?4, ?5)").run(m.id, conversationId, m.author, m.at, JSON.stringify(m)).lastInsertRowid);
    const text = searchable(m);
    if (text && !m.event) db.query("INSERT INTO messages_fts (rowid, text, conversation_id) VALUES (?1, ?2, ?3)").run(seq, text, conversationId);
  })();
  return seq;
}
export function getMessage(id: string): (StoredMessage & { conversationId: string }) | undefined {
  const row = db.query<{ seq: number; conversation_id: string; data: string }, [string]>("SELECT seq, conversation_id, data FROM messages WHERE id = ?").get(id);
  return row ? { seq: row.seq, conversationId: row.conversation_id, message: parse<BotMessage>(row.data) } : undefined;
}
/** Messages whose id starts with `prefix` (bots see short ids), in the given conversations. */
export function findMessages(prefix: string, conversationIds: string[]): (StoredMessage & { conversationId: string })[] {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(prefix) || !conversationIds.length) return [];
  const rows = db.query<{ seq: number; conversation_id: string; data: string }, [string]>("SELECT seq, conversation_id, data FROM messages WHERE id LIKE ? || '%' LIMIT 20").all(prefix);
  return rows.filter((r) => conversationIds.includes(r.conversation_id)).map((r) => ({ seq: r.seq, conversationId: r.conversation_id, message: parse<BotMessage>(r.data) }));
}
export function updateMessage(m: BotMessage) {
  const row = db.query<{ seq: number; conversation_id: string }, [string]>("SELECT seq, conversation_id FROM messages WHERE id = ?").get(m.id);
  if (!row) return;
  db.transaction(() => {
    db.query("UPDATE messages SET data = ?2 WHERE id = ?1").run(m.id, JSON.stringify(m));
    db.query("DELETE FROM messages_fts WHERE rowid = ?").run(row.seq);
    const text = searchable(m);
    if (text && !m.event) db.query("INSERT INTO messages_fts (rowid, text, conversation_id) VALUES (?1, ?2, ?3)").run(row.seq, text, row.conversation_id);
  })();
}
export function deleteMessage(id: string) {
  const row = db.query<{ seq: number }, [string]>("SELECT seq FROM messages WHERE id = ?").get(id);
  if (!row) return;
  db.transaction(() => {
    db.query("DELETE FROM messages_fts WHERE rowid = ?").run(row.seq);
    db.query("DELETE FROM messages WHERE id = ?").run(id);
  })();
}
/** The latest `limit` messages (before `beforeSeq` when given), oldest first. */
export function messages(conversationId: string, limit = 200, beforeSeq?: number): StoredMessage[] {
  const rows = beforeSeq
    ? db.query<{ seq: number; data: string }, [string, number, number]>("SELECT seq, data FROM messages WHERE conversation_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3").all(conversationId, beforeSeq, limit)
    : db.query<{ seq: number; data: string }, [string, number]>("SELECT seq, data FROM messages WHERE conversation_id = ?1 ORDER BY seq DESC LIMIT ?2").all(conversationId, limit);
  return rows.reverse().map((r) => ({ seq: r.seq, message: parse<BotMessage>(r.data) }));
}
/** Messages after `afterSeq`, oldest first. */
export function messagesAfter(conversationId: string, afterSeq: number, limit = 500): StoredMessage[] {
  return db
    .query<{ seq: number; data: string }, [string, number, number]>("SELECT seq, data FROM messages WHERE conversation_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3")
    .all(conversationId, afterSeq, limit)
    .map((r) => ({ seq: r.seq, message: parse<BotMessage>(r.data) }));
}
export function countBefore(conversationId: string, seq: number): number {
  return db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1 AND seq < ?2").get(conversationId, seq)?.n ?? 0;
}
export function latestSeq(conversationId: string): number {
  return db.query<{ seq: number | null }, [string]>("SELECT MAX(seq) AS seq FROM messages WHERE conversation_id = ?").get(conversationId)?.seq ?? 0;
}
export function searchMessages(query: string, conversationIds: string[], limit = 15): (StoredMessage & { conversationId: string })[] {
  const q = ftsQuery(query);
  if (!q || !conversationIds.length) return [];
  const rows = db.query<{ rowid: number }, [string, number]>("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?").all(q, limit * 4);
  const out: (StoredMessage & { conversationId: string })[] = [];
  for (const { rowid } of rows) {
    const r = db.query<{ seq: number; conversation_id: string; data: string }, [number]>("SELECT seq, conversation_id, data FROM messages WHERE seq = ?").get(rowid);
    if (r && conversationIds.includes(r.conversation_id)) out.push({ seq: r.seq, conversationId: r.conversation_id, message: parse<BotMessage>(r.data) });
    if (out.length >= limit) break;
  }
  return out;
}

// ------------------------------------------------------------------ cursors

export function cursor(botId: string, conversationId: string): number {
  return db.query<{ seq: number }, [string, string]>("SELECT seq FROM cursors WHERE bot_id = ?1 AND conversation_id = ?2").get(botId, conversationId)?.seq ?? 0;
}
export function setCursor(botId: string, conversationId: string, seq: number) {
  db.query("INSERT INTO cursors (bot_id, conversation_id, seq) VALUES (?1, ?2, ?3) ON CONFLICT(bot_id, conversation_id) DO UPDATE SET seq = MAX(seq, ?3)").run(botId, conversationId, seq);
}

/** Everything, gone: for Reset. */
export function wipe() {
  db.exec("DELETE FROM bots; DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM routines; DELETE FROM conversations; DELETE FROM messages; DELETE FROM messages_fts; DELETE FROM cursors; DELETE FROM kv;");
}
