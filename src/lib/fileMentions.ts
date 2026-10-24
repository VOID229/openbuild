// The composer's "@" menu: a per-workspace index of files and folders fetched once and filtered
// locally, so typing feels instant (no request per keystroke). Content is read only when a file is
// picked; a folder is mentioned by path so the agent can explore what's inside.
import type { Attachment, FileRead, WorkspaceEntry } from "../../shared/types";

interface Cached {
  at: number;
  entries: WorkspaceEntry[];
}

const cache = new Map<string, Cached>();
const pending = new Map<string, Promise<WorkspaceEntry[]>>();
/** Client-side trust window; the server rebuilds its own index when it's older than a few seconds. */
const CLIENT_TTL = 10_000;
const keyOf = (cwd?: string) => cwd ?? "";

/** The index already loaded for this workspace, if any. */
export const cachedEntries = (cwd?: string): WorkspaceEntry[] | undefined => cache.get(keyOf(cwd))?.entries;

/** Fetch (or reuse) a workspace's files and folders. `cwd` undefined means the scratch area. */
export function loadEntries(cwd?: string, refresh = false): Promise<WorkspaceEntry[]> {
  const key = keyOf(cwd);
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CLIENT_TTL) return Promise.resolve(hit.entries);
  const waiting = pending.get(key);
  if (waiting) return waiting;
  const params = new URLSearchParams();
  if (cwd) params.set("cwd", cwd);
  if (refresh) params.set("refresh", "1");
  const req = fetch(`/api/workspaces/files?${params}`)
    .then(async (res) => {
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `Request failed (HTTP ${res.status})`);
      const entries: WorkspaceEntry[] = Array.isArray(body?.entries)
        ? body.entries.filter((e: unknown): e is WorkspaceEntry => !!e && typeof (e as WorkspaceEntry).path === "string" && typeof (e as WorkspaceEntry).dir === "boolean")
        : [];
      cache.set(key, { at: Date.now(), entries });
      return entries;
    })
    .finally(() => pending.delete(key));
  pending.set(key, req);
  return req;
}

/** Read one workspace file for an "@" mention. The attachment keeps the relative path as its name. */
export async function readMentionFile(cwd: string | undefined, path: string): Promise<Attachment> {
  const params = new URLSearchParams({ path });
  if (cwd) params.set("cwd", cwd);
  const res = await fetch(`/api/workspaces/file?${params}`);
  const body = (await res.json().catch(() => null)) as FileRead | { error?: string } | null;
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `Request failed (HTTP ${res.status})`);
  const file = body as FileRead;
  return { id: crypto.randomUUID(), name: file.path, mime: file.mime, dataUrl: "", text: file.text, size: file.size, mention: true };
}

// ------------------------------------------------------------------ local fuzzy matching

const lowers = new WeakMap<WorkspaceEntry[], { paths: string[]; lower: string[] }>();

function pathsOf(entries: WorkspaceEntry[]) {
  let entry = lowers.get(entries);
  if (!entry) {
    const paths = entries.map((e) => e.path);
    entry = { paths, lower: paths.map((p) => p.toLowerCase()) };
    lowers.set(entries, entry);
  }
  return entry;
}

/** Subsequence match ("stycs" → styles.css); -1 when it doesn't fit. Higher is better. */
function subsequence(hay: string, needle: string): number {
  let at = -1;
  let gaps = 0;
  let run = 0;
  for (let i = 0; i < needle.length; i++) {
    const found = hay.indexOf(needle[i]!, at + 1);
    if (found === -1) return -1;
    if (at >= 0) {
      const gap = found - at - 1;
      gaps += gap;
      run = gap === 0 ? run + 1 : 0;
    }
    at = found;
  }
  return 100 - gaps * 2 + run * 3 - at;
}

function score(path: string, lowerPath: string, q: string, dir: boolean): number {
  // A query with a slash is about the path ("src/lib/"): the folder at or above it comes first.
  if (q.includes("/")) {
    const bare = q.endsWith("/") ? q.slice(0, -1) : q;
    // Inside a folder ("src/"): don't offer the folder itself again.
    if (q.endsWith("/") && lowerPath === bare) return -1;
    if (lowerPath === bare) return dir ? 10_000 : 9_000;
    if (lowerPath.startsWith(q) || lowerPath.startsWith(bare + "/")) return 8_000 - path.length * 0.1;
    const inPath = lowerPath.indexOf(q);
    if (inPath !== -1) return 5_000 - inPath;
  }
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const lowerName = lowerPath.slice(slash + 1);
  if (lowerName === q) return 10_000 - name.length + (dir ? 40 : 0);
  if (lowerName.startsWith(q)) return 8_000 - name.length + (dir ? 40 : 0);
  const inName = lowerName.indexOf(q);
  if (inName !== -1) return 6_000 - inName - name.length * 0.1;
  if (lowerPath.startsWith(q)) return 5_000 - path.length * 0.1 + (dir ? 40 : 0);
  const inPath = lowerPath.indexOf(q);
  if (inPath !== -1) return 4_000 - inPath;
  const subName = subsequence(lowerName, q);
  if (subName >= 0) return 2_000 + subName - name.length;
  const subPath = subsequence(lowerPath, q);
  if (subPath >= 0) return 1_000 + subPath - path.length * 0.1;
  return -1;
}

/** The entries that best match `query`, best first. Empty query returns the first `limit`. */
export function matchEntries(entries: WorkspaceEntry[], query: string, limit = 50): WorkspaceEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries.slice(0, limit);
  const { lower } = pathsOf(entries);
  const scored: { entry: WorkspaceEntry; score: number }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const s = score(entry.path, lower[i]!, q, entry.dir);
    if (s >= 0) scored.push({ entry, score: s });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.entry.dir) - Number(a.entry.dir) ||
      a.entry.path.length - b.entry.path.length ||
      a.entry.path.localeCompare(b.entry.path),
  );
  return scored.slice(0, limit).map((s) => s.entry);
}
