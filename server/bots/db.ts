// OpenBots' storage: one SQLite database in the data folder (bots/bots.sqlite), apart from
// threads. Bots, conversations, messages, memory and routines; each conversation's to-do list; what
// each bot has read of each conversation (cursors); and full-text indexes over memory and messages, which is how bots
// search everything they've ever been told.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_TEXT_MAX, PROFILE_MAX_BYTES, type Bot, type BotMessage, type Conversation, type MemoryItem, type MemoryKind, type Routine, type TodoItem } from "../../shared/bots";
import { dataDir } from "../paths";
import { memoryKey, profileBytes } from "./sessionPolicy";

export const botsDir = () => join(dataDir(), "bots");

function open(): Database {
  mkdirSync(botsDir(), { recursive: true, mode: 0o700 });
  const db = new Database(join(botsDir(), "bots.sqlite"), { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, by TEXT, kind TEXT NOT NULL DEFAULT 'journal');
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
    CREATE TABLE IF NOT EXISTS group_follows (conversation_id TEXT PRIMARY KEY, bot_ids TEXT NOT NULL, at INTEGER NOT NULL);
  `);
  return db;
}

/**
 * Tables and fields added since: run on every load too, so a hot reload that keeps the open database
 * gets them. Each step does nothing the second time.
 */
function migrate(db: Database): Database {
  db.exec("CREATE TABLE IF NOT EXISTS todos (conversation_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);");
  // Bots from before roles have none: an empty one, so the first sentence of their instructions stands in.
  db.exec("UPDATE bots SET data = json_set(data, '$.role', '') WHERE json_valid(data) AND json_type(data, '$.role') IS NULL;");
  migrateMemories(db);
  return db;
}

/** A bot owed its one look through the memory it had before the split (kv key prefix). */
const MEMORY_REVIEW = "memory-review:";
/** Per bot: when its recent turns used each catalog tool (toolPreload.ts). */
const TOOL_USAGE = "tool-usage:";
/** When each bot last called each app's tools, by app id then bot id (apps.ts). */
export const APP_USERS = "app-users";

/**
 * Memory from before the profile/journal split has no kind. It was all in the prompt then, standing
 * rules included, so each bot's newest facts go into its profile, as many as its cap holds; only what
 * doesn't fit (and any fact too long to be one) becomes a journal entry, still searchable, and still
 * there for the bot to promote. This happens once, when the kind column is added, and a bot left with
 * such journal entries is owed one look through them on its next turn (takeMemoryReview), armed only
 * then, so a database already split never arms it again. Then the search index is put back in step
 * with the rows, both ways. Running it again finds nothing to do.
 *
 * Memory is each bot's own (bot_id). If some of it is ever shared between bots, that's a scope beside
 * kind, with `by` already saying which bot learned a fact.
 */
export function migrateMemories(db: Database) {
  db.transaction(() => {
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(memories)").all();
    if (!columns.some((c) => c.name === "kind")) {
      db.exec("ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'journal'");
      promoteLegacyMemories(db);
      // Each bot left with old facts in its journal, marked with its newest date then: anything written after is dated later.
      db.exec(`INSERT OR IGNORE INTO kv (key, value) SELECT '${MEMORY_REVIEW}' || bot_id, MAX(at) FROM memories WHERE bot_id IN (SELECT id FROM bots) GROUP BY bot_id HAVING SUM(kind = 'journal') > 0`);
    }
    db.exec("UPDATE memories SET kind = 'journal' WHERE kind NOT IN ('profile', 'journal')");
    db.exec("CREATE INDEX IF NOT EXISTS memories_kind ON memories(bot_id, kind, at)");
    db.exec("DELETE FROM memories_fts WHERE id NOT IN (SELECT id FROM memories)");
    db.exec("DELETE FROM memories_fts WHERE rowid NOT IN (SELECT MIN(rowid) FROM memories_fts GROUP BY id)");
    db.exec("DELETE FROM memories_fts WHERE rowid IN (SELECT f.rowid FROM memories_fts f JOIN memories m ON m.id = f.id WHERE f.text <> m.text OR f.bot_id <> m.bot_id)");
    db.exec("INSERT INTO memories_fts (id, bot_id, text) SELECT id, bot_id, text FROM memories WHERE id NOT IN (SELECT id FROM memories_fts)");
  })();
}

/** Fills each bot's profile from its newest legacy facts down, skipping any that would overrun the cap. */
function promoteLegacyMemories(db: Database) {
  const rows = db.query<{ id: string; bot_id: string; text: string; at: number }, []>("SELECT id, bot_id, text, at FROM memories ORDER BY bot_id, at DESC, rowid DESC").all();
  const profiles = new Map<string, { items: { id: string; text: string; at: number }[]; keys: Set<string> }>();
  const promote = db.query("UPDATE memories SET kind = 'profile' WHERE id = ?1");
  for (const row of rows) {
    if (row.text.trim().length > MEMORY_TEXT_MAX) continue;
    const profile = profiles.get(row.bot_id) ?? { items: [], keys: new Set<string>() };
    profiles.set(row.bot_id, profile);
    const key = memoryKey(row.text);
    // The same fact twice: the newer copy is in the profile already, the older stays in the journal.
    if (profile.keys.has(key)) continue;
    if (profileBytes([...profile.items, row]) > PROFILE_MAX_BYTES) continue;
    profile.items.push(row);
    profile.keys.add(key);
    promote.run(row.id);
  }
}

const hot = globalThis as { openbotsDb?: Database };
export const db = migrate((hot.openbotsDb ??= open()));

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
    db.query("DELETE FROM kv WHERE key = ?").run(MEMORY_REVIEW + id);
    db.query("DELETE FROM kv WHERE key = ?").run(TOOL_USAGE + id);
    const users = getValue<Record<string, Record<string, number>>>(APP_USERS);
    if (users && Object.values(users).some((byBot) => id in byBot)) {
      const kept = Object.entries(users).flatMap(([app, byBot]) => {
        const { [id]: _gone, ...rest } = byBot;
        return Object.keys(rest).length ? [[app, rest] as const] : [];
      });
      setValue(APP_USERS, Object.fromEntries(kept));
    }
  })();
}

/** When the bot's recent turns used each catalog tool: what its Pi's starting tools are picked from. */
export function toolUsage(botId: string): Record<string, number[]> | undefined {
  return getValue<Record<string, number[]>>(TOOL_USAGE + botId);
}
export function setToolUsage(botId: string, usage: Record<string, number[]>) {
  setValue(TOOL_USAGE + botId, usage);
}

// ------------------------------------------------------------------ memory

type MemoryRow = { id: string; kind: string; text: string; at: number; by: string | null };
const MEMORY_COLUMNS = "m.id, m.kind, m.text, m.at, m.by";
const memoryItem = (r: MemoryRow): MemoryItem => ({ id: r.id, kind: r.kind === "profile" ? "profile" : "journal", text: r.text, at: r.at, by: r.by ?? undefined });

/** All of a bot's memory, newest first. */
export function memories(botId: string): MemoryItem[] {
  return db.query<MemoryRow, [string]>(`SELECT ${MEMORY_COLUMNS} FROM memories m WHERE m.bot_id = ? ORDER BY m.at DESC, m.rowid DESC`).all(botId).map(memoryItem);
}
export function addMemory(botId: string, item: MemoryItem) {
  db.transaction(() => {
    db.query("INSERT INTO memories (id, bot_id, text, at, by, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(item.id, botId, item.text, item.at, item.by ?? null, item.kind);
    db.query("INSERT INTO memories_fts (id, bot_id, text) VALUES (?1, ?2, ?3)").run(item.id, botId, item.text);
  })();
}
/** Writing a fact that's already there: its date moves up and it takes the kind it's given. The text, and so the index, stays. */
export function touchMemory(botId: string, id: string, kind: MemoryKind, at: number) {
  db.query("UPDATE memories SET kind = ?3, at = ?4 WHERE id = ?1 AND bot_id = ?2").run(id, botId, kind, at);
}
export function removeMemory(botId: string, id: string): boolean {
  let removed = false;
  db.transaction(() => {
    removed = db.query("DELETE FROM memories WHERE id = ?1 AND bot_id = ?2").run(id, botId).changes > 0;
    db.query("DELETE FROM memories_fts WHERE id = ?1 AND bot_id = ?2").run(id, botId);
  })();
  return removed;
}
/**
 * The look through its memory from before the split that a bot is owed: the date of its newest entry
 * from then, or nothing. Taking it ends it, at once and for good, so no later turn sees it again.
 */
export function takeMemoryReview(botId: string): number | undefined {
  const row = db.query<{ value: string }, [string]>("DELETE FROM kv WHERE key = ? RETURNING value").get(MEMORY_REVIEW + botId);
  return row ? Number(parse<number>(row.value)) : undefined;
}
/**
 * Recall: a bot's memory of either kind, best matches first (full-text rank, newer first on a tie).
 * Then what the index can't find, newest first: text that only contains the query (part of a word or
 * a number, as in "230" for "#1230"), and entries whose id starts with it. No query: the newest.
 */
export function searchMemory(botId: string, query: string, limit = 12): MemoryItem[] {
  const text = query.trim();
  if (!text) return memories(botId).slice(0, limit);
  const out = new Map<string, MemoryItem>();
  // Each word both whole and as a prefix, so an entry with the word itself outranks one that only starts with it.
  const q = ftsQuery(text)?.replace(/("[^"]+")\*/g, "$1 OR $1*");
  if (q) {
    const ranked = db
      .query<MemoryRow, [string, string, number]>(`SELECT ${MEMORY_COLUMNS} FROM memories_fts JOIN memories m ON m.id = memories_fts.id WHERE memories_fts.bot_id = ?1 AND memories_fts MATCH ?2 ORDER BY memories_fts.rank, m.at DESC LIMIT ?3`)
      .all(botId, q, limit);
    for (const r of ranked) out.set(r.id, memoryItem(r));
  }
  if (out.size < limit && text.length >= 2 && text.length <= 64) {
    const part = db
      .query<MemoryRow, [string, string, number]>(`SELECT ${MEMORY_COLUMNS} FROM memories m WHERE m.bot_id = ?1 AND (instr(lower(m.text), lower(?2)) > 0 OR instr(m.id, lower(?2)) = 1) ORDER BY m.at DESC, m.rowid DESC LIMIT ?3`)
      .all(botId, text, limit);
    for (const r of part) if (out.size < limit && !out.has(r.id)) out.set(r.id, memoryItem(r));
  }
  return [...out.values()];
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

export type StoredConversation = Omit<Conversation, "messages" | "more" | "todos">;

export function listConversations(): StoredConversation[] {
  return db.query<{ data: string }, []>("SELECT data FROM conversations ORDER BY updated_at DESC").all().map((r) => parse<StoredConversation>(r.data));
}
export function getConversation(id: string): StoredConversation | undefined {
  const row = db.query<{ data: string }, [string]>("SELECT data FROM conversations WHERE id = ?").get(id);
  return row ? parse<StoredConversation>(row.data) : undefined;
}
export function putConversation(c: StoredConversation) {
  // The to-do list has a table of its own: a record read before a change to it can't put it back.
  const { messages: _m, more: _more, todos: _t, ...stored } = c as Conversation;
  db.query("INSERT INTO conversations (id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = ?2, updated_at = ?3").run(stored.id, JSON.stringify(stored), stored.updatedAt);
}
export function deleteConversation(id: string) {
  db.transaction(() => {
    for (const { seq } of db.query<{ seq: number }, [string]>("SELECT seq FROM messages WHERE conversation_id = ?").all(id)) db.query("DELETE FROM messages_fts WHERE rowid = ?").run(seq);
    db.query("DELETE FROM messages WHERE conversation_id = ?").run(id);
    db.query("DELETE FROM cursors WHERE conversation_id = ?").run(id);
    db.query("DELETE FROM group_follows WHERE conversation_id = ?").run(id);
    db.query("DELETE FROM todos WHERE conversation_id = ?").run(id);
    db.query("DELETE FROM conversations WHERE id = ?").run(id);
  })();
}

export interface StoredMessage {
  seq: number;
  message: BotMessage;
}

const searchable = (m: BotMessage) => [m.text, m.html?.title, ...(m.question?.steps ?? (m.question ? [m.question] : [])).flatMap((q) => [q.title, ...q.options.map((o) => o.label)]), ...(m.poll?.options.map((o) => o.label) ?? []), m.plan?.title, ...(m.plan?.steps.map((s) => s.text) ?? [])].filter(Boolean).join("\n");

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

// ------------------------------------------------------------------ to-do lists

/** A conversation's to-do list, in order; a row that doesn't read as one is empty. */
export function todos(conversationId: string): TodoItem[] {
  const row = db.query<{ data: string }, [string]>("SELECT data FROM todos WHERE conversation_id = ?").get(conversationId);
  if (!row) return [];
  try {
    const list = parse<unknown>(row.data);
    return Array.isArray(list) ? (list as TodoItem[]) : [];
  } catch {
    return [];
  }
}
/** Every conversation's to-do list, with when it last changed. */
export function allTodos(): { conversationId: string; list: TodoItem[]; updatedAt: number }[] {
  return db
    .query<{ conversation_id: string; updated_at: number }, []>("SELECT conversation_id, updated_at FROM todos")
    .all()
    .map((r) => ({ conversationId: r.conversation_id, list: todos(r.conversation_id), updatedAt: r.updated_at }));
}
export function setTodos(conversationId: string, list: TodoItem[]) {
  if (!list.length) return void db.query("DELETE FROM todos WHERE conversation_id = ?").run(conversationId);
  db.query("INSERT INTO todos (conversation_id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(conversation_id) DO UPDATE SET data = ?2, updated_at = ?3").run(conversationId, JSON.stringify(list), Date.now());
}

// ------------------------------------------------------------------ cursors

export function cursor(botId: string, conversationId: string): number {
  return db.query<{ seq: number }, [string, string]>("SELECT seq FROM cursors WHERE bot_id = ?1 AND conversation_id = ?2").get(botId, conversationId)?.seq ?? 0;
}
export function setCursor(botId: string, conversationId: string, seq: number) {
  db.query("INSERT INTO cursors (bot_id, conversation_id, seq) VALUES (?1, ?2, ?3) ON CONFLICT(bot_id, conversation_id) DO UPDATE SET seq = MAX(seq, ?3)").run(botId, conversationId, seq);
}

// ------------------------------------------------------------------ group follows

/** Who the user's last request in a group went to, and when. */
export interface GroupFollow {
  ids: string[];
  at: number;
}

/** A group's follow; a row that doesn't read as one is dropped. */
export function groupFollow(conversationId: string): GroupFollow | undefined {
  const row = db.query<{ bot_ids: string; at: number }, [string]>("SELECT bot_ids, at FROM group_follows WHERE conversation_id = ?").get(conversationId);
  if (!row) return undefined;
  let ids: unknown;
  try {
    ids = JSON.parse(row.bot_ids);
  } catch {}
  if (Array.isArray(ids) && ids.length && ids.every((id) => typeof id === "string") && Number.isFinite(row.at)) return { ids, at: row.at };
  deleteGroupFollow(conversationId);
  return undefined;
}
export function setGroupFollow(conversationId: string, follow: GroupFollow) {
  if (!follow.ids.length) return deleteGroupFollow(conversationId);
  db.query("INSERT INTO group_follows (conversation_id, bot_ids, at) VALUES (?1, ?2, ?3) ON CONFLICT(conversation_id) DO UPDATE SET bot_ids = ?2, at = ?3").run(conversationId, JSON.stringify(follow.ids), follow.at);
}
export function deleteGroupFollow(conversationId: string) {
  db.query("DELETE FROM group_follows WHERE conversation_id = ?").run(conversationId);
}
/** Drop follows that can't apply now: `ttl` old, or stamped more than `skew` ahead (the clock stepped back). */
export function sweepGroupFollows(now: number, ttl: number, skew: number): number {
  return db.query("DELETE FROM group_follows WHERE at <= ?1 OR at > ?2").run(now - ttl, now + skew).changes;
}

/** Everything, gone: for Reset. */
export function wipe() {
  db.exec("DELETE FROM bots; DELETE FROM memories; DELETE FROM memories_fts; DELETE FROM routines; DELETE FROM conversations; DELETE FROM messages; DELETE FROM messages_fts; DELETE FROM cursors; DELETE FROM group_follows; DELETE FROM todos; DELETE FROM kv;");
}
