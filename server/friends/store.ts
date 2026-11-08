// What this server keeps about its friends. Only the server process writes any of it (the CLI asks
// the server over its control socket), so nothing here races another writer.
//
//   friends/identity.json   this server's Ed25519 key pair (owner-only). The private key never leaves it.
//   friends/friends.json    each friend's public key, name, who connects to whom, and where (owner-only)
//   bots.sqlite             per friend: the sequence numbers both ways and the outbox of frames not yet
//                           acknowledged, next to the chats they belong to
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { FriendMode } from "../../shared/friends";
import { db } from "../bots/db";
import { dataDir } from "../paths";
import { loadKeyPair, newKeyPair, type KeyPair } from "./protocol";

export const friendsDir = () => join(dataDir(), "friends");

export interface StoredFriend {
  id: string;
  name: string;
  publicKey: string;
  /** "host": they host and this server dials `urls`. "guest": they dial this server's friend listener. */
  role: "host" | "guest";
  mode: FriendMode;
  urls?: string[];
  /** For a guest: the address this server's listener binds for them. */
  listen?: string;
  addedAt: number;
  lastSeenAt?: number;
  /** The owner lets bots use their usual tools in chats with this friend. Off unless they turn it on. */
  allowTools?: boolean;
}

interface FriendsFile {
  /** The friend listener's port, fixed the first time it's chosen so a friend's saved address keeps working. */
  port?: number;
  friends: StoredFriend[];
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write owner-only, atomically. */
function writeJson(file: string, value: unknown): void {
  mkdirSync(friendsDir(), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}

const hot = globalThis as { openbuildFriendKey?: KeyPair };

/** This server's friend identity, made the first time it's needed. */
export function identity(): KeyPair {
  if (hot.openbuildFriendKey) return hot.openbuildFriendKey;
  const file = join(friendsDir(), "identity.json");
  let stored = readJson<{ publicKey: string; secret: string } | undefined>(file, undefined);
  if (!stored) {
    stored = newKeyPair();
    writeJson(file, stored);
  }
  return (hot.openbuildFriendKey = loadKeyPair(stored));
}

const friendsFile = () => join(friendsDir(), "friends.json");
const readFile = (): FriendsFile => {
  const file = readJson<FriendsFile>(friendsFile(), { friends: [] });
  return { ...file, friends: Array.isArray(file.friends) ? file.friends : [] };
};

export function friends(): StoredFriend[] {
  return readFile().friends;
}
export function friend(id: string): StoredFriend | undefined {
  return friends().find((f) => f.id === id);
}

export function putFriend(next: StoredFriend) {
  const file = readFile();
  writeJson(friendsFile(), { ...file, friends: [...file.friends.filter((f) => f.id !== next.id), next] });
}

export function updateFriend(id: string, patch: Partial<StoredFriend>): StoredFriend | undefined {
  const file = readFile();
  const found = file.friends.find((f) => f.id === id);
  if (!found) return undefined;
  Object.assign(found, patch);
  writeJson(friendsFile(), file);
  return found;
}

export function deleteFriend(id: string): boolean {
  const file = readFile();
  const next = file.friends.filter((f) => f.id !== id);
  if (next.length === file.friends.length) return false;
  writeJson(friendsFile(), { ...file, friends: next });
  db.transaction(() => {
    db.query("DELETE FROM friend_outbox WHERE friend_id = ?").run(id);
    db.query("DELETE FROM friend_links WHERE friend_id = ?").run(id);
  })();
  return true;
}

/** Whether the owner lets bots use more than chat with this friend. Read on every call, so a change applies at once. */
export const allowsTools = (id: string) => friend(id)?.allowTools === true;

/** The friend listener's port: as saved, else OPENBUILD_FRIEND_PORT, else 100 above the app's. */
export function listenPort(): number {
  const env = Number(process.env.OPENBUILD_FRIEND_PORT);
  if (Number.isInteger(env) && env > 0) return env;
  const saved = readFile().port;
  if (saved) return saved;
  return Number(process.env.PORT ?? 3100) + 100;
}
export function keepPort(port: number) {
  const file = readFile();
  if (file.port !== port && !process.env.OPENBUILD_FRIEND_PORT) writeJson(friendsFile(), { ...file, port });
}

// ------------------------------------------------------------------ sequence numbers and the outbox

db.exec(`
  CREATE TABLE IF NOT EXISTS friend_links (friend_id TEXT PRIMARY KEY, out_seq INTEGER NOT NULL DEFAULT 0, in_seq INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS friend_outbox (friend_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (friend_id, seq));
`);

/** Frames kept for a friend who's away. Past this the oldest go, so a friend gone for good can't fill the disk. */
const OUTBOX_LIMIT = 5000;

export interface Outgoing {
  seq: number;
  kind: string;
  body: unknown;
}

/** Keep a frame for a friend until they acknowledge it. Its sequence number is fixed now, so a resend is the same frame. */
export function enqueue(friendId: string, kind: string, body: unknown): Outgoing {
  let seq = 0;
  db.transaction(() => {
    db.query("INSERT INTO friend_links (friend_id) VALUES (?) ON CONFLICT(friend_id) DO NOTHING").run(friendId);
    seq = db.query<{ out_seq: number }, [string]>("UPDATE friend_links SET out_seq = out_seq + 1 WHERE friend_id = ? RETURNING out_seq").get(friendId)!.out_seq;
    db.query("INSERT INTO friend_outbox (friend_id, seq, body, at) VALUES (?1, ?2, ?3, ?4)").run(friendId, seq, JSON.stringify({ kind, body }), Date.now());
    db.query("DELETE FROM friend_outbox WHERE friend_id = ?1 AND seq <= ?2").run(friendId, seq - OUTBOX_LIMIT);
  })();
  return { seq, kind, body };
}

export function pending(friendId: string): Outgoing[] {
  return db
    .query<{ seq: number; body: string }, [string]>("SELECT seq, body FROM friend_outbox WHERE friend_id = ? ORDER BY seq")
    .all(friendId)
    .map((r) => ({ seq: r.seq, ...(JSON.parse(r.body) as { kind: string; body: unknown }) }));
}

/** They have everything up to `seq`. */
export function acknowledged(friendId: string, seq: number) {
  db.query("DELETE FROM friend_outbox WHERE friend_id = ?1 AND seq <= ?2").run(friendId, seq);
}

/** The last frame applied from this friend: anything at or below it again is a replay or a resend. */
export function lastIn(friendId: string): number {
  return db.query<{ in_seq: number }, [string]>("SELECT in_seq FROM friend_links WHERE friend_id = ?").get(friendId)?.in_seq ?? 0;
}
export function setLastIn(friendId: string, seq: number) {
  db.query("INSERT INTO friend_links (friend_id, in_seq) VALUES (?1, ?2) ON CONFLICT(friend_id) DO UPDATE SET in_seq = MAX(in_seq, ?2)").run(friendId, seq);
}
