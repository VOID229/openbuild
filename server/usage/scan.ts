// Reads the agents' transcripts into usage records, incrementally: each file is read on from where
// the last scan stopped, and an unchanged one costs a stat. What was read is kept on disk too, so
// a restarted server doesn't start over, and so usage outlives transcripts an agent cleans up
// (Claude Code deletes its sessions after 30 days by default).
import { Database } from "bun:sqlite";
import { readdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { UsageProvider } from "../../shared/usage";
import { dataDir } from "../paths";
import { agentDir } from "../pi/install";
import * as storage from "../storage";
import { claude, codex, grok, opencodeRecord, pi, type Format, type Rec } from "./formats";
import { claudeDirs, codexHomes, cursorToken } from "./limits";

interface Entry {
  provider: UsageProvider;
  size: number;
  mtime: number;
  /** Bytes read so far (complete lines). */
  offset: number;
  state: unknown;
  recs: Rec[];
  /** When the file was found missing; its records are kept for the longest range. */
  gone?: number;
}

/** Longer than the longest range, so a cleaned-up transcript still counts until it ages out. */
const KEEP_MS = 100 * 86_400_000;
const CACHE_VERSION = 1;
const cacheFile = () => join(dataDir(), "usage-cache.json");

const hot = globalThis as { usageEntries?: Map<string, Entry> };
let loaded: Promise<Map<string, Entry>> | undefined;

function load(): Promise<Map<string, Entry>> {
  if (hot.usageEntries) return Promise.resolve(hot.usageEntries);
  return (loaded ??= readFile(cacheFile(), "utf8").then(decode, () => new Map<string, Entry>()).then((m) => (hot.usageEntries = m)));
}

// ------------------------------------------------------------------ sources

const home = () => process.env.HOME || homedir();
const tilde = (p: string) => resolve(p.replace(/^~(?=\/|$)/, home()));

async function piRoots(): Promise<string[]> {
  const roots = new Set([join(agentDir(), "sessions")]);
  if (process.env.PI_CODING_AGENT_SESSION_DIR) roots.add(tilde(process.env.PI_CODING_AGENT_SESSION_DIR));
  try {
    const settings = JSON.parse(await readFile(join(agentDir(), "settings.json"), "utf8"));
    if (typeof settings.sessionDir === "string") roots.add(tilde(settings.sessionDir));
  } catch {}
  return [...roots];
}

interface Source {
  format: Format;
  roots: () => Promise<string[]> | string[];
  match: (name: string) => boolean;
}

const SOURCES: Source[] = [
  { format: pi, roots: piRoots, match: (n) => n.endsWith(".jsonl") },
  // Every account's config dir (~/.claude, ~/.claude-2, …).
  { format: claude, roots: async () => (await claudeDirs()).map((d) => join(d, "projects")), match: (n) => n.endsWith(".jsonl") },
  {
    format: codex,
    roots: async () => (await codexHomes()).flatMap((d) => [join(d, "sessions"), join(d, "archived_sessions")]),
    match: (n) => n.endsWith(".jsonl") || n.endsWith(".jsonl.zst"),
  },
  { format: grok, roots: () => [join(process.env.GROK_HOME ? tilde(process.env.GROK_HOME) : join(home(), ".grok"), "sessions")], match: (n) => n === "updates.jsonl" },
];

async function filesIn(root: string, match: (name: string) => boolean): Promise<string[]> {
  try {
    const names = await readdir(root, { recursive: true });
    return names.filter((n) => match(basename(n))).map((n) => join(root, n));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ reading

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

/**
 * Parse the lines that contain a marker, in order. Markers are searched for in the whole text rather
 * than line by line: most of a transcript is content, and this skips it without splitting it up.
 */
function parseText(text: string, format: Format, state: unknown, out: Rec[]) {
  const next = format.markers.map((m) => text.indexOf(m));
  let done = -1;
  for (;;) {
    let at = -1;
    for (const i of next) if (i >= 0 && (at < 0 || i < at)) at = i;
    if (at < 0) return;
    const start = text.lastIndexOf("\n", at) + 1;
    let end = text.indexOf("\n", at);
    if (end < 0) end = text.length;
    if (start > done) {
      let e: unknown;
      try {
        e = JSON.parse(text.slice(start, end));
      } catch {}
      if (e && typeof e === "object") format.parse(e, state, out);
    }
    done = end;
    for (let k = 0; k < next.length; k++) if (next[k]! >= 0 && next[k]! <= end) next[k] = text.indexOf(format.markers[k]!, end);
  }
}

/** Read what's new in a transcript into its entry. */
async function readFileInto(path: string, format: Format, info: { size: number; mtimeMs: number }, prev: Entry | undefined): Promise<Entry> {
  const compressed = path.endsWith(".zst");
  // A compressed file is rewritten whole; a shorter one was replaced.
  const fresh = !prev || compressed || info.size < prev.offset || prev.provider !== format.provider;
  const entry: Entry = fresh
    ? { provider: format.provider, size: 0, mtime: 0, offset: 0, state: format.initial(), recs: [] }
    : { ...prev, recs: [...prev.recs], gone: undefined };
  const file = Bun.file(path);
  let bytes: Uint8Array = await (fresh ? file : file.slice(entry.offset)).bytes();
  let consumed = bytes.length;
  if (compressed) {
    bytes = Bun.zstdDecompressSync(bytes);
    consumed = info.size;
  } else {
    // Leave a line that's still being written for next time, unless it's already whole.
    const end = bytes.lastIndexOf(NEWLINE) + 1;
    if (end < bytes.length) {
      try {
        JSON.parse(decoder.decode(bytes.subarray(end)));
      } catch {
        consumed = end;
      }
    }
  }
  parseText(decoder.decode(bytes.subarray(0, compressed ? bytes.length : consumed)), format, entry.state, entry.recs);
  entry.offset = (fresh ? 0 : entry.offset) + consumed;
  entry.size = info.size;
  entry.mtime = info.mtimeMs;
  return entry;
}

async function scanSource(source: Source, entries: Map<string, Entry>, seen: Set<string>) {
  const roots = await source.roots();
  const files = [...new Set((await Promise.all(roots.map((r) => filesIn(r, source.match)))).flat())];
  let changed = false;
  // Bounded, so a large archive doesn't open every file at once.
  for (let i = 0; i < files.length; i += 16) {
    await Promise.all(files.slice(i, i + 16).map(async (path) => {
      seen.add(path);
      try {
        const info = await stat(path);
        const prev = entries.get(path);
        if (prev && !prev.gone && prev.size === info.size && prev.mtime === info.mtimeMs) return;
        entries.set(path, await readFileInto(path, source.format, info, prev));
        changed = true;
      } catch (err) {
        console.warn(`[usage] couldn't read ${path}:`, (err as Error).message);
      }
    }));
  }
  return changed;
}

// ------------------------------------------------------------------ Durable threads and OpenCode

/** Durable threads keep their transcript in OpenBuild's own store, with usage on each reply. */
function scanDurable(entries: Map<string, Entry>, seen: Set<string>) {
  let changed = false;
  let rows: { id: string; v: string }[];
  try {
    rows = storage.durableChatIndex();
  } catch {
    return false;
  }
  const stale = rows.filter((r) => {
    seen.add(`durable:${r.id}`);
    return entries.get(`durable:${r.id}`)?.state !== r.v;
  });
  for (const { id, v, data } of storage.chatsById(stale.map((r) => r.id))) {
    const recs: Rec[] = [];
    try {
      const chat = JSON.parse(data);
      for (const m of chat.messages ?? []) {
        const u = m.role === "assistant" ? m.usage : undefined;
        if (!u || !m.model?.id) continue;
        const r = { input: u.input || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0, output: u.output || 0 };
        if (!(r.input + r.cacheRead + r.cacheWrite + r.output)) continue;
        recs.push({ t: m.createdAt, model: m.model.id, session: id, ...r, cost: u.cost > 0 ? u.cost : null, key: `durable:${id}:${m.id}` });
      }
    } catch {}
    entries.set(`durable:${id}`, { provider: "pi", size: 0, mtime: 0, offset: 0, state: v, recs });
    changed = true;
  }
  return changed;
}

/** OpenCode keeps sessions in SQLite. Re-read when the database (or its WAL) changes. */
async function scanOpenCode(entries: Map<string, Entry>, seen: Set<string>) {
  const dir = process.env.XDG_DATA_HOME ? join(tilde(process.env.XDG_DATA_HOME), "opencode") : join(home(), ".local", "share", "opencode");
  const path = join(dir, "opencode.db");
  let size = 0;
  let mtime = 0;
  for (const p of [path, `${path}-wal`]) {
    try {
      const s = await stat(p);
      size += s.size;
      mtime = Math.max(mtime, s.mtimeMs);
    } catch {
      if (p === path) return false;
    }
  }
  seen.add(path);
  const prev = entries.get(path);
  if (prev && !prev.gone && prev.size === size && prev.mtime === mtime) return false;
  const recs: Rec[] = [];
  const db = new Database(path, { readonly: true });
  try {
    const since = Date.now() - KEEP_MS;
    const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    if (tables.has("message"))
      for (const r of db.query<{ id: string; session_id: string; time_created: number; data: string }, [number]>("SELECT id, session_id, time_created, data FROM message WHERE time_created >= ?").all(since)) {
        const rec = opencodeRecord(r.data, r.id, r.session_id, r.time_created);
        if (rec) recs.push(rec);
      }
    if (tables.has("session_message"))
      for (const r of db.query<{ id: string; session_id: string; time_created: number; data: string }, [number]>("SELECT id, session_id, time_created, data FROM session_message WHERE type = 'assistant' AND time_created >= ?").all(since)) {
        const rec = opencodeRecord(r.data, r.id, r.session_id, r.time_created);
        if (rec) recs.push(rec);
      }
  } finally {
    db.close();
  }
  // Rows older than the window aren't queried again; keep what an earlier scan had of them.
  const since = Date.now() - KEEP_MS;
  const keys = new Set(recs.map((r) => r.key));
  for (const r of prev?.recs ?? []) if (r.t >= since && !keys.has(r.key)) recs.push(r);
  entries.set(path, { provider: "opencode", size, mtime, offset: 0, state: null, recs });
  return true;
}

// ------------------------------------------------------------------ Cursor

/**
 * Cursor keeps no token counts on disk; its account's usage events come from cursor.com with the
 * CLI's sign-in. Only what's new since the last read is fetched (with a day's overlap for late events).
 */
const CURSOR_EVENTS = "https://cursor.com/api/dashboard/get-filtered-usage-events";
const CURSOR_TTL_MS = 5 * 60_000;
const CURSOR_PAGE = 1000;
let cursorProblem: string | undefined;

async function scanCursor(entries: Map<string, Entry>, force: boolean) {
  let token: string;
  try {
    token = await cursorToken();
  } catch {
    cursorProblem = undefined;
    return false;
  }
  const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString() || "{}");
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  const userId = subject.split("|").at(-1);
  if (!userId) return false;
  const id = `cursor:${Bun.hash(subject).toString(36)}`;
  const prev = entries.get(id);
  const state = (prev?.state ?? {}) as { fetched?: number; through?: number };
  // Refresh asks again, but not more than once a minute: each read is several requests to cursor.com.
  if (state.fetched && Date.now() - state.fetched < (force ? 60_000 : CURSOR_TTL_MS)) return false;
  const end = Date.now();
  const start = Math.max(end - KEEP_MS, (state.through ?? 0) - 86_400_000);
  const page = async (n: number) => {
    const res = await fetch(CURSOR_EVENTS, {
      method: "POST",
      // The session cookie must never follow a redirect off cursor.com.
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { origin: "https://cursor.com", "content-type": "application/json", cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}` },
      body: JSON.stringify({ page: n, pageSize: CURSOR_PAGE, startDate: String(start), endDate: String(end) }),
    });
    if (res.status === 401 || res.status === 403) throw new Error("Cursor turned down the saved sign-in. Run cursor-agent to sign in again.");
    if (!res.ok) throw new Error(`Cursor answered HTTP ${res.status}.`);
    const body = await res.json();
    return { total: Number(body.totalUsageEventsCount) || 0, events: Array.isArray(body.usageEventsDisplay) ? body.usageEventsDisplay : [] };
  };
  try {
    const first = await page(1);
    const pages = Math.ceil(first.total / CURSOR_PAGE);
    const events = [...first.events];
    // Up to six pages at a time; Cursor takes about a second for each.
    for (let n = 2; n <= pages; n += 6) {
      const batch = await Promise.all(Array.from({ length: Math.min(6, pages - n + 1) }, (_, i) => page(n + i)));
      for (const b of batch) events.push(...b.events);
    }
    const recs: Rec[] = [];
    for (const ev of events) {
      const u = ev?.tokenUsage;
      const t = Number(ev?.timestamp);
      if (!u || !Number.isFinite(t) || typeof ev.model !== "string") continue;
      const r = { input: Math.max(0, u.inputTokens || 0), cacheRead: Math.max(0, u.cacheReadTokens || 0), cacheWrite: Math.max(0, u.cacheWriteTokens || 0), output: Math.max(0, u.outputTokens || 0) };
      if (!(r.input + r.cacheRead + r.cacheWrite + r.output)) continue;
      const key = `cursor:${ev.usageEventId ?? `${t}:${ev.model}:${ev.conversationId}:${r.input}:${r.output}`}`;
      recs.push({ t, model: ev.model, session: String(ev.conversationId ?? ""), ...r, cost: typeof u.totalCents === "number" ? u.totalCents / 100 : null, key });
    }
    // Keep what came before the overlap; the rest was just fetched again.
    const kept = (prev?.recs ?? []).filter((r) => r.t < start && r.t > end - KEEP_MS);
    entries.set(id, { provider: "cursor", size: 0, mtime: 0, offset: 0, state: { fetched: Date.now(), through: end }, recs: [...kept, ...recs] });
    cursorProblem = undefined;
    return true;
  } catch (err) {
    cursorProblem = (err as Error).name === "TimeoutError" ? "Cursor didn't answer in time." : (err as Error).message;
    return false;
  }
}

let cursorRun: Promise<void> | undefined;
/** Cursor's history takes a second a page, so it never holds up a report: it lands in a later one. */
function refreshCursor(entries: Map<string, Entry>, force: boolean) {
  cursorRun ??= scanCursor(entries, force)
    .then((changed) => {
      if (changed) {
        changes++;
        save(entries);
      }
    })
    .finally(() => (cursorRun = undefined));
}

/** Sources still being read in the background. */
export const pendingSources = () => (cursorRun ? (["cursor"] as const) : []);

/** Sources that couldn't be read in the last scan. */
export const scanProblems = () => (cursorProblem ? [{ provider: "cursor" as const, message: `Account history: ${cursorProblem}` }] : []);

// ------------------------------------------------------------------ scanning

let running: Promise<Map<string, Entry>> | undefined;
let lastScan = 0;
let changes = 0;
/** Goes up whenever a scan finds anything new, so reports can be reused until then. */
export const generation = () => changes;
/** Scans this close together share one; the report is about the last minute or more anyway. */
const FRESH_MS = 15_000;

/** Every record read so far, by file. Unchanged files cost a stat. */
export function scan(force = false): Promise<Map<string, Entry>> {
  if (running) return running;
  if (!force && Date.now() - lastScan < FRESH_MS && hot.usageEntries) return Promise.resolve(hot.usageEntries);
  return (running = (async () => {
    const entries = await load();
    const seen = new Set<string>();
    const results = await Promise.all([
      ...SOURCES.map((s) => scanSource(s, entries, seen)),
      Promise.resolve(scanDurable(entries, seen)),
      scanOpenCode(entries, seen).catch((err) => (console.warn("[usage] couldn't read OpenCode:", (err as Error).message), false)),
    ]);
    let changed = results.some(Boolean);
    const now = Date.now();
    refreshCursor(entries, force);
    for (const [path, e] of entries) {
      // Cursor's history (per account) isn't a file; it ages out with the rest below.
      if (seen.has(path) || e.provider === "cursor") {
        if (e.provider === "cursor" && !e.recs.some((r) => r.t > now - KEEP_MS)) entries.delete(path);
        continue;
      }
      // Missing: keep its records until the newest is older than any range shows.
      if (!e.gone) {
        e.gone = now;
        changed = true;
      }
      if (!e.recs.some((r) => r.t > now - KEEP_MS)) {
        entries.delete(path);
        changed = true;
      }
    }
    lastScan = Date.now();
    if (changed) {
      changes++;
      save(entries);
    }
    return entries;
  })().finally(() => (running = undefined)));
}

// ------------------------------------------------------------------ persistence

type Row = [t: number, model: number, session: number, input: number, cacheRead: number, cacheWrite: number, output: number, cost: number | null, key: string];

function encode(entries: Map<string, Entry>) {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const intern = (s: string) => index.get(s) ?? (index.set(s, strings.length), strings.push(s) - 1);
  const files: Record<string, unknown> = {};
  for (const [path, e] of entries) {
    files[path] = {
      p: e.provider, s: e.size, m: e.mtime, o: e.offset, st: e.state, g: e.gone,
      r: e.recs.map((r): Row => [r.t, intern(r.model), intern(r.session), r.input, r.cacheRead, r.cacheWrite, r.output, r.cost, r.key]),
    };
  }
  return JSON.stringify({ v: CACHE_VERSION, strings, files });
}

function decode(text: string): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const doc = JSON.parse(text);
  if (doc?.v !== CACHE_VERSION) return out;
  const s: string[] = doc.strings;
  for (const [path, f] of Object.entries<any>(doc.files)) {
    out.set(path, {
      provider: f.p, size: f.s, mtime: f.m, offset: f.o, state: f.st, gone: f.g,
      recs: (f.r as Row[]).map(([t, m, ses, input, cacheRead, cacheWrite, output, cost, key]) => ({ t, model: s[m]!, session: s[ses]!, input, cacheRead, cacheWrite, output, cost, key })),
    });
  }
  return out;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save(entries: Map<string, Entry>) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const tmp = `${cacheFile()}.tmp`;
    try {
      await Bun.write(tmp, encode(entries));
      await rename(tmp, cacheFile());
    } catch (err) {
      console.warn("[usage] couldn't save the usage cache:", (err as Error).message);
    }
  }, 2000);
}
