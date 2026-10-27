// Durable storage for chats and app state, in a SQLite database on disk owned by the server.
//
// Browser storage (IndexedDB, localStorage) belongs to one origin, so the same app on
// localhost:3000 and localhost:3001 saw two different sets of chats and settings. Keeping them here
// makes them independent of the port, the browser and its "clear site data".
//
// - WAL journal with synchronous=FULL: a write is on disk before the request returns, and a crash or
//   power loss can't corrupt the database.
// - A deleted chat leaves a tombstone (id + time, no content), so a stale tab or an old browser
//   import can't bring it back. Tombstones are also what a future cloud sync needs.
// - Snapshots are taken into backups/ at startup and every few hours, newest BACKUP_KEEP kept.
//
// The location is OPENCHAT_DATA_DIR, or the platform's per-user data directory (see dataDir()).
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths";

export { dataDir };

const BACKUP_EVERY = 6 * 60 * 60 * 1000;
const BACKUP_KEEP = 20;

export interface StoredChat {
  id: string;
  updatedAt: number;
  [key: string]: unknown;
}

/** A chat's version: changes whenever its stored content does, so browsers can cache chats by it. */
export const versionOf = (data: string) => Bun.hash(data).toString(36);

function open(): Database {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new Database(join(dir, "openchat.db"), { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(`CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    data TEXT,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`);
  // Versions are computed once on write, so the 5 s index poll never has to read chat bodies.
  if (!db.query<{ name: string }, []>("PRAGMA table_info(chats)").all().some((column) => column.name === "version")) {
    db.run("ALTER TABLE chats ADD COLUMN version TEXT");
  }
  const unversioned = db.query<{ id: string; data: string }, []>("SELECT id, data FROM chats WHERE version IS NULL AND data IS NOT NULL").all();
  if (unversioned.length) {
    const setVersion = db.query("UPDATE chats SET version = ?2 WHERE id = ?1");
    db.transaction(() => { for (const row of unversioned) setVersion.run(row.id, versionOf(row.data)); })();
  }
  db.run(`CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  return db;
}

// Under `bun --hot` this module re-runs on every edit: keep one connection and one backup timer.
const hot = globalThis as { openchatDb?: Database; openchatBackupTimer?: ReturnType<typeof setInterval> };
const db = (hot.openchatDb ??= open());

export function location() {
  return join(dataDir(), "openchat.db");
}

/** Every chat that hasn't been deleted, newest first. */
export function listChats(): StoredChat[] {
  const rows = db.query<{ data: string }, []>("SELECT data FROM chats WHERE deleted_at IS NULL ORDER BY updated_at DESC").all();
  const out: StoredChat[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.data));
    } catch {}
  }
  return out;
}

/** Every current chat's id and version, newest first. Reads only the index columns, never chat bodies. */
export function chatIndex(): { id: string; v: string }[] {
  return db.query<{ id: string; version: string }, []>("SELECT id, version FROM chats WHERE deleted_at IS NULL ORDER BY updated_at DESC").all()
    .map((r) => ({ id: r.id, v: r.version }));
}

/** Every current Durable thread's id and version (for usage, which reads only those). */
export function durableChatIndex(): { id: string; v: string }[] {
  return db.query<{ id: string; version: string }, []>("SELECT id, version FROM chats WHERE deleted_at IS NULL AND json_extract(data, '$.runtime') = 'durable'").all()
    .map((r) => ({ id: r.id, v: r.version }));
}

/** The stored JSON of the given current chats, with their versions. */
export function chatsById(ids: string[]): { id: string; v: string; data: string }[] {
  const find = db.query<{ data: string; version: string | null }, [string]>("SELECT data, version FROM chats WHERE id = ? AND deleted_at IS NULL");
  const out: { id: string; v: string; data: string }[] = [];
  for (const id of ids) {
    const row = find.get(id);
    if (row) out.push({ id, v: row.version ?? versionOf(row.data), data: row.data });
  }
  return out;
}

/** Read one current chat, excluding deletion tombstones. */
export function getChat(id: string): StoredChat | undefined {
  const row = db.query<{ data: string }, [string]>("SELECT data FROM chats WHERE id = ? AND deleted_at IS NULL").get(id);
  try { return row ? JSON.parse(row.data) : undefined; } catch { return undefined; }
}

/** Save a chat. Returns its new version, or false when it was deleted (it stays deleted). */
export function putChat(chat: StoredChat): string | false {
  const row = db.query<{ deleted_at: number | null }, [string]>("SELECT deleted_at FROM chats WHERE id = ?").get(chat.id);
  if (row?.deleted_at) return false;
  const data = JSON.stringify(chat);
  const version = versionOf(data);
  db.query("INSERT INTO chats (id, data, updated_at, version) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET data = ?2, updated_at = ?3, version = ?4").run(
    chat.id,
    data,
    chat.updatedAt,
    version,
  );
  return version;
}

/**
 * Bring in chats from browser storage. A chat is added when it's unknown here, or replaces the
 * stored one when it's newer; deleted chats are never revived. Returns how many were written.
 */
export function importChats(chats: StoredChat[]): number {
  const find = db.query<{ updated_at: number; deleted_at: number | null }, [string]>("SELECT updated_at, deleted_at FROM chats WHERE id = ?");
  let written = 0;
  db.transaction(() => {
    for (const chat of chats) {
      const row = find.get(chat.id);
      if (row && (row.deleted_at || row.updated_at >= chat.updatedAt)) continue;
      putChat(chat);
      written++;
    }
  })();
  return written;
}

/** Delete a chat's content, keeping a tombstone. */
export function deleteChat(id: string) {
  db.query("INSERT INTO chats (id, data, updated_at, version, deleted_at) VALUES (?1, NULL, ?2, NULL, ?2) ON CONFLICT(id) DO UPDATE SET data = NULL, version = NULL, deleted_at = ?2").run(id, Date.now());
}

export function deleteAllChats() {
  db.query("UPDATE chats SET data = NULL, version = NULL, deleted_at = ?1 WHERE deleted_at IS NULL").run(Date.now());
}

export function getValue(key: string): string | undefined {
  return db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(key)?.value;
}

/** Server-owned metadata with a literal key prefix. */
export function listValues(prefix: string): [string, string][] {
  return db.query<{ key: string; value: string }, [string]>("SELECT key, value FROM kv WHERE substr(key, 1, length(?1)) = ?1").all(prefix).map((r) => [r.key, r.value]);
}

export function setValue(key: string, value: string) {
  db.query("INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3").run(key, value, Date.now());
}

/** Snapshot the database into backups/ unless a recent snapshot exists; prune old ones. */
export function backup() {
  const dir = join(dataDir(), "backups");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files = readdirSync(dir).filter((f) => /^openchat-.*\.db$/.test(f)).sort();
    const newest = files.at(-1);
    if (newest && Date.now() - statSync(join(dir, newest)).mtimeMs < BACKUP_EVERY - 60_000) return;
    const name = `openchat-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
    db.run(`VACUUM INTO '${join(dir, name).replace(/'/g, "''")}'`);
    files.push(name);
    for (const old of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) rmSync(join(dir, old), { force: true });
  } catch (err) {
    console.error(`[storage] Backup failed: ${(err as Error).message}`);
  }
}

if (hot.openchatBackupTimer) clearInterval(hot.openchatBackupTimer);
backup();
// Importing storage in a one-off diagnostic must not keep that process alive forever.
hot.openchatBackupTimer = setInterval(backup, BACKUP_EVERY);
hot.openchatBackupTimer.unref();
