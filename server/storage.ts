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

/** Save a chat. Returns false when it was deleted (it stays deleted). */
export function putChat(chat: StoredChat): boolean {
  const row = db.query<{ deleted_at: number | null }, [string]>("SELECT deleted_at FROM chats WHERE id = ?").get(chat.id);
  if (row?.deleted_at) return false;
  db.query("INSERT INTO chats (id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = ?2, updated_at = ?3").run(
    chat.id,
    JSON.stringify(chat),
    chat.updatedAt,
  );
  return true;
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
  db.query("INSERT INTO chats (id, data, updated_at, deleted_at) VALUES (?1, NULL, ?2, ?2) ON CONFLICT(id) DO UPDATE SET data = NULL, deleted_at = ?2").run(id, Date.now());
}

export function deleteAllChats() {
  db.query("UPDATE chats SET data = NULL, deleted_at = ?1 WHERE deleted_at IS NULL").run(Date.now());
}

export function getValue(key: string): string | undefined {
  return db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(key)?.value;
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
hot.openchatBackupTimer = setInterval(backup, BACKUP_EVERY);
