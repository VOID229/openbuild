// A workspace's files and folders for the composer's "@" menu and the file tree, a file's text for
// inlining into a prompt or editing, and saving it back.
//
// Listing is the hot path: the menu must feel instant. Repositories use `git ls-files` (tracked and
// untracked-non-ignored) so the index matches what the agent sees and skips build output and
// node_modules for free; their folders are derived from the file paths. Other folders get a bounded
// walk that records folders (empty ones too) as it goes. Results are cached in memory, shared by
// every request, and refreshed after a short TTL.
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { FileRead, TreeEntry, WorkspaceEntry } from "../shared/types";
import { scratchDir } from "./projects";

/** Cap the index so a giant checkout can't stall the menu or bloat the response. */
const MAX_ENTRIES = 20_000;
/** How long a list is trusted before it is rebuilt (the composer may be open for a while). */
const CACHE_TTL = 4_000;
const MAX_TEXT_BYTES = 1024 * 1024;

const IGNORED_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", "vendor",
  "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit", ".turbo",
  ".cache", ".parcel-cache", "__pycache__", ".venv", "venv", "target", "Pods",
]);

interface Index {
  at: number;
  entries: WorkspaceEntry[];
  building?: Promise<WorkspaceEntry[]>;
}

const cache = new Map<string, Index>();

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** `git ls-files`: tracked files plus untracked files that aren't ignored. Null outside a repo. */
async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const proc = Bun.spawn(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    return out.split("\0").filter(Boolean).slice(0, MAX_ENTRIES);
  } catch {
    return null;
  }
}

/** Files plus every folder on the way to them (git only lists files). */
function withFolders(files: string[]): WorkspaceEntry[] {
  const seen = new Set<string>();
  const entries: WorkspaceEntry[] = [];
  const add = (path: string, dir: boolean) => {
    if (seen.has(path)) return;
    seen.add(path);
    entries.push({ path, dir });
  };
  for (const file of files) {
    if (entries.length >= MAX_ENTRIES) break;
    let slash = file.indexOf("/");
    while (slash !== -1) {
      add(file.slice(0, slash), true);
      slash = file.indexOf("/", slash + 1);
    }
    add(file, false);
  }
  return entries;
}

/** A bounded walk for folders that aren't repositories. Records folders and files, skipping junk. */
function walkEntries(root: string): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];
  const walk = (dir: string, rel: string) => {
    if (entries.length >= MAX_ENTRIES) return;
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    children.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of children) {
      if (entries.length >= MAX_ENTRIES) return;
      if (e.name === ".DS_Store") continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // Hidden and junk folders are skipped entirely (empty normal folders are still listed).
        if (e.name.startsWith(".") || IGNORED_DIRS.has(e.name)) continue;
        entries.push({ path: next, dir: true });
        walk(join(dir, e.name), next);
      } else if (e.isFile()) {
        entries.push({ path: next, dir: false });
      }
    }
  };
  walk(root, "");
  return entries;
}

/** The folder the "@" menu scans: a thread's workspace, or the scratch area. */
export function scanRoot(cwd?: string): string {
  if (cwd) {
    if (!isDir(cwd)) throw new Error("That folder doesn't exist anymore");
    return realpathSync(cwd);
  }
  const root = scratchDir();
  mkdirSync(root, { recursive: true });
  return realpathSync(root);
}

/** A workspace's files and folders, relative to its root. Cached; `refresh` rebuilds now. */
export async function listEntries(cwd?: string, refresh = false): Promise<WorkspaceEntry[]> {
  const root = scanRoot(cwd);
  const hit = cache.get(root);
  if (!refresh && hit) {
    if (hit.building) return hit.building;
    if (Date.now() - hit.at < CACHE_TTL) return hit.entries;
  }
  // Collapse concurrent requests for the same folder into one scan.
  if (hit?.building) return hit.building;
  const entry: Index = { at: hit?.at ?? 0, entries: hit?.entries ?? [] };
  const building = (async () => {
    const files = await gitFiles(root);
    const entries = files ? withFolders(files) : walkEntries(root);
    cache.set(root, { at: Date.now(), entries });
    return entries;
  })();
  entry.building = building;
  cache.set(root, entry);
  try {
    return await building;
  } catch (err) {
    cache.delete(root);
    throw err;
  }
}

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".mdx": "text/markdown",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".less": "text/x-less",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "text/xml",
  ".svg": "image/svg+xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".py": "text/x-python",
  ".sh": "text/x-shellscript",
  ".sql": "text/x-sql",
};

/** A path inside a workspace, resolved (through symlinks) and checked not to point out of it. */
function inside(cwd: string | undefined, relPath: string, mustExist = true): { root: string; real: string } {
  if (!relPath || relPath.length > 1024 || relPath.startsWith("/") || relPath.includes("\0")) throw new Error("Bad file path");
  const root = scanRoot(cwd);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) throw new Error("That file isn't in this workspace");
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    if (mustExist) throw new Error("That file doesn't exist anymore");
    real = join(realpathSync(dirname(target)), basename(target));
  }
  // A symlink inside the workspace may not point out of it.
  if (real !== root && !real.startsWith(root + sep)) throw new Error("That file isn't in this workspace");
  return { root, real };
}

/** Read a text file inside a workspace, for inlining into a prompt or opening in the editor. */
export function readFile(cwd: string | undefined, relPath: string): FileRead {
  const { real } = inside(cwd, relPath);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error("That isn't a file");
  if (stat.size > MAX_TEXT_BYTES) throw new Error(`${basename(real)} is larger than 1 MB`);
  const buf = readFileSync(real);
  if (buf.includes(0)) throw new Error(`${basename(real)} isn't a text file`);
  const ext = extname(real).toLowerCase();
  return {
    path: relPath,
    name: basename(real),
    dir: dirname(relPath) === "." ? "" : dirname(relPath),
    mime: MIME[ext] ?? "text/plain",
    size: stat.size,
    text: buf.toString("utf8"),
    mtime: stat.mtimeMs,
  };
}

/** When a workspace file last changed. */
export const fileMtime = (cwd: string | undefined, relPath: string) => statSync(inside(cwd, relPath).real).mtimeMs;

/** A save that would overwrite a change made on disk since the editor read the file. */
export class ChangedOnDisk extends Error {
  status = 409;
  code = "changed";
}

/**
 * Save a file the editor opened. With `mtime` (what the editor read), a file changed on disk since
 * isn't overwritten unless the save is forced by leaving `mtime` out.
 */
export function writeFile(cwd: string | undefined, relPath: string, text: string, mtime?: number): { mtime: number; size: number } {
  const { real } = inside(cwd, relPath, false);
  let before;
  try {
    before = statSync(real);
  } catch {}
  if (before && !before.isFile()) throw new Error("That isn't a file");
  if (before && mtime !== undefined && Math.abs(before.mtimeMs - mtime) > 1) throw new ChangedOnDisk(`${basename(real)} changed on disk since it was opened`);
  writeFileSync(real, text);
  const after = statSync(real);
  return { mtime: after.mtimeMs, size: after.size };
}

const RAW_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

/** An image in a workspace, as it is, for the file viewer. */
export function rawFile(cwd: string | undefined, relPath: string): Response {
  const { real } = inside(cwd, relPath);
  const type = RAW_TYPES[extname(real).toLowerCase()];
  if (!type) throw new Error("Only images can be shown as they are");
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error("That isn't a file");
  if (stat.size > 25 * 1024 * 1024) throw new Error(`${basename(real)} is larger than 25 MB`);
  // An SVG is a document that could run script: shown as an image only, never as a page.
  return new Response(Bun.file(real), { headers: { "content-type": type, "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
}

async function gitText(cwd: string, args: string[], input?: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: input === undefined ? "ignore" : "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (input !== undefined && proc.stdin) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    // check-ignore exits 1 when nothing matched: still an answer.
    return code === 0 || code === 1 ? out : null;
  } catch {
    return null;
  }
}

/**
 * One folder of a workspace for the file tree: its folders, then its files, each marked when
 * .gitignore matches it or it has uncommitted changes (a folder: something inside it does).
 */
export async function listDir(cwd: string | undefined, relDir: string): Promise<TreeEntry[]> {
  const root = scanRoot(cwd);
  const dir = relDir ? inside(cwd, relDir).real : root;
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new Error("That folder doesn't exist anymore");
  }
  const rel = (name: string) => (relDir ? `${relDir}/${name}` : name);
  const entries: TreeEntry[] = children
    .filter((e) => e.name !== ".git")
    .slice(0, MAX_ENTRIES)
    .map((e) => {
      let isDirectory = e.isDirectory();
      // A symlinked folder is browsed like a folder (inside() still keeps it in the workspace).
      if (e.isSymbolicLink()) isDirectory = isDir(join(dir, e.name));
      return { name: e.name, dir: isDirectory };
    });
  const prefix = await gitText(root, ["rev-parse", "--show-prefix"]);
  if (prefix !== null && entries.length) {
    const base = prefix.trim() + (relDir ? `${relDir}/` : "");
    const [ignored, status] = await Promise.all([
      gitText(root, ["check-ignore", "-z", "--stdin"], entries.map((e) => rel(e.name) + (e.dir ? "/" : "")).join("\0") + "\0"),
      gitText(root, ["-c", "core.quotepath=off", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", relDir || "."]),
    ]);
    const ignoredSet = new Set((ignored ?? "").split("\0").filter(Boolean).map((p) => p.replace(/\/$/, "")));
    const marks = new Map<string, string>();
    const parts = (status ?? "").split("\0");
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i]!;
      if (line.length < 4) continue;
      const code = line[0] === "?" ? "?" : line[0] === "D" || line[1] === "D" ? "D" : line[0] === "A" ? "A" : "M";
      if (line[0] === "R" || line[0] === "C") i++;
      const path = line.slice(3);
      if (!path.startsWith(base)) continue;
      const [first, ...rest] = path.slice(base.length).split("/");
      if (!first) continue;
      // A folder takes "M" for anything changed inside it.
      marks.set(first, rest.length ? (marks.get(first) ?? "M") : code);
    }
    for (const e of entries) {
      if (ignoredSet.has(rel(e.name))) e.ignored = true;
      const mark = marks.get(e.name);
      if (mark) e.git = mark;
    }
  }
  return entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}
