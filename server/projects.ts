// Projects (directories threads work in, usually git repositories), their branches, and the git
// worktrees OpenBuild makes so a thread can work on its own branch without touching the project's
// checkout. Worktrees live in <data dir>/worktrees/<project>/<name>.
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { GitInfo, Project, Workspace } from "../shared/types";
import * as storage from "./storage";

const KEY = "projects";

interface StoredProject {
  id: string;
  name: string;
  path: string;
}

function stored(): StoredProject[] {
  try {
    return JSON.parse(storage.getValue(KEY) ?? "[]");
  } catch {
    return [];
  }
}
const store = (list: StoredProject[]) => storage.setValue(KEY, JSON.stringify(list));

async function git(cwd: string, args: string[], timeoutMs = 30_000, env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out: out.trim(), err: err.trim() };
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** "~/x" and relative paths, made absolute. */
const expand = (p: string) => resolve(p.trim().replace(/^~(?=$|\/)/, homedir()));
const tilde = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);

export function listProjects(): Project[] {
  return stored().map((p) => ({ ...p, git: existsSync(join(p.path, ".git")), missing: !isDir(p.path) }));
}

export const findProject = (id: string) => listProjects().find((p) => p.id === id);

/**
 * Add a directory as a project (a repository's root when it's inside one). With `create`, a folder
 * that doesn't exist yet is made first: that's how a new project starts.
 */
export async function addProject(rawPath: string, opts: { name?: string; create?: boolean } = {}): Promise<Project> {
  let path = expand(rawPath);
  if (!isDir(path)) {
    if (!opts.create || existsSync(path)) throw new Error(`No folder at ${tilde(path)}`);
    mkdirSync(path, { recursive: true });
  }
  path = realpathSync(path);
  const top = await git(path, ["rev-parse", "--show-toplevel"]);
  if (top.code === 0 && top.out) path = realpathSync(top.out);
  const list = stored();
  const existing = list.find((p) => p.path === path);
  if (existing) return { ...existing, git: top.code === 0 };
  const project = { id: crypto.randomUUID().slice(0, 8), name: opts.name?.trim().slice(0, 80) || basename(path), path };
  store([...list, project]);
  return { ...project, git: top.code === 0 };
}

/** A repository URL git can clone over the network: https, ssh, or scp-style (git@host:owner/repo). */
const CLONE_URL = /^(?:(?:https?|ssh|git):\/\/[^\s/]+\/\S+|[\w.-]+@[\w.-]+:\S+)$/;

/** Clone a repository into a new folder and add it as a project. */
export async function cloneProject(url: string, rawPath: string, name?: string): Promise<Project> {
  url = url.trim();
  if (!CLONE_URL.test(url)) throw new Error("That doesn't look like a git URL (https://…, ssh://… or git@host:owner/repo)");
  const path = expand(rawPath);
  if (existsSync(path) && (!isDir(path) || readdirSync(path).length)) throw new Error(`${tilde(path)} already exists`);
  mkdirSync(dirname(path), { recursive: true });
  const r = await git(dirname(path), ["clone", "--", url, path], 10 * 60_000, {
    // Network transports only (no ext:: or file://), and ssh fails instead of waiting for a prompt.
    GIT_ALLOW_PROTOCOL: "https:http:ssh:git",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
  });
  if (r.code !== 0) throw new Error(r.err.split("\n").filter((l) => !l.startsWith("Cloning into")).pop() || "Couldn't clone the repository");
  return addProject(path, { name });
}

export function removeProject(id: string) {
  store(stored().filter((p) => p.id !== id));
}

export function renameProject(id: string, name: string) {
  store(stored().map((p) => (p.id === id ? { ...p, name: name.trim().slice(0, 80) || p.name } : p)));
}

/**
 * Subfolders of a folder (an error when there's no folder there); repositories are marked. `hidden`
 * also lists dotfolders (bar "." and ".."), for a path being typed that starts with a dot.
 */
export function browse(rawDir: string | undefined, opts: { hidden?: boolean } = {}): { dir: string; parent?: string; entries: { name: string; path: string; git: boolean }[] } {
  const dir = expand(rawDir || homedir());
  if (!isDir(dir)) throw new Error(`No folder at ${tilde(dir)}`);
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name !== "node_modules" && e.name !== "Library" && (opts.hidden ? e.name !== "." && e.name !== ".." : !e.name.startsWith(".")))
    .map((e) => ({ name: e.name, path: join(dir, e.name), git: existsSync(join(dir, e.name, ".git")) }))
    .filter((e) => isDir(e.path))
    .sort((a, b) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name));
  const parent = resolve(dir, "..");
  return { dir, parent: parent !== dir ? parent : undefined, entries };
}

export async function gitInfo(cwd: string): Promise<GitInfo> {
  const [branch, branches, status, counts] = await Promise.all([
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]),
    git(cwd, ["status", "--porcelain"]),
    git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
  ]);
  const [behind, ahead] = counts.code === 0 ? counts.out.split(/\s+/).map(Number) : [];
  return {
    branch: branch.out || undefined,
    branches: branches.code === 0 ? branches.out.split("\n").filter(Boolean) : [],
    dirty: status.code === 0 ? status.out.split("\n").filter(Boolean).length : 0,
    ahead,
    behind,
  };
}

/** Where OpenBuild keeps its worktrees. */
export const worktreesDir = () => join(storage.dataDir(), "worktrees");

/** Folders for threads that aren't in a project, one per thread. */
export const scratchDir = () => join(storage.dataDir(), "scratch");

/** A new empty folder for a thread that isn't in a project. */
export function scratchWorkspace(): Workspace {
  const dir = join(scratchDir(), `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 6)}`);
  mkdirSync(dir, { recursive: true });
  return { projectId: "", projectName: "", cwd: realpathSync(dir) };
}

/** A registered project, an OpenBuild workspace, or the exact cwd of a discovered Pi session. */
export function allowedCwd(cwd: string): boolean {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch {
    return false;
  }
  const inside = (root: string) => real === root || real.startsWith(root + sep);
  if (stored().some((p) => inside(p.path))) return true;
  // Only server-discovered bindings authorize these folders, never a client-supplied workspace.
  for (const [, value] of storage.listValues("pi-session:")) {
    try {
      const session = JSON.parse(value);
      if (existsSync(session.file) && realpathSync(session.cwd) === real) return true;
    } catch {}
  }
  for (const dir of [worktreesDir(), scratchDir()]) {
    try {
      if (inside(realpathSync(dir))) return true;
    } catch {}
  }
  return false;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/**
 * Prepare a new thread's workspace. "local" works in the project's checkout, switching it to
 * `branch` first if asked (only when there's nothing uncommitted to carry over). "worktree" makes a
 * worktree on a new branch started from `branch` (or the current one).
 */
export async function prepareWorkspace(projectId: string, mode: "local" | "worktree", branch?: string, name?: string): Promise<Workspace> {
  const project = findProject(projectId);
  if (!project) throw new Error("That project isn't in OpenBuild anymore");
  if (project.missing) throw new Error(`${tilde(project.path)} doesn't exist anymore`);
  const base: Workspace = { projectId: project.id, projectName: project.name, cwd: project.path };
  if (!project.git) {
    if (mode === "worktree") throw new Error(`${project.name} isn't a git repository, so it can't have worktrees`);
    return base;
  }
  const info = await gitInfo(project.path);
  if (mode === "local") {
    if (branch && branch !== info.branch) {
      if (info.dirty) throw new Error(`${project.name} has uncommitted changes, so it can't switch to ${branch}. Use a worktree, or commit first.`);
      const r = await git(project.path, ["switch", branch]);
      if (r.code !== 0) throw new Error(r.err || `Couldn't switch to ${branch}`);
      return { ...base, branch };
    }
    return { ...base, branch: info.branch };
  }
  const from = branch || info.branch || "HEAD";
  // A few words of the thread's title make a readable branch name.
  const short = slug((name ?? "").split(/\s+/).slice(0, 4).join(" ")).slice(0, 32).replace(/[-.]+$/, "") || crypto.randomUUID().slice(0, 6);
  let newBranch = `openbuild/${short}`;
  for (let i = 2; info.branches.includes(newBranch); i++) newBranch = `openbuild/${short}-${i}`;
  const dir = join(worktreesDir(), slug(project.name) || project.id, newBranch.slice("openbuild/".length));
  mkdirSync(join(worktreesDir(), slug(project.name) || project.id), { recursive: true });
  const r = await git(project.path, ["worktree", "add", "-b", newBranch, dir, from], 120_000);
  if (r.code !== 0) throw new Error(r.err || "Couldn't create the worktree");
  return { ...base, cwd: dir, branch: newBranch, worktree: true, base: from };
}

/** Remove a worktree OpenBuild made (and its branch, if it was merged or `force`). */
export async function removeWorktree(cwd: string, force = false): Promise<void> {
  const real = realpathSync(cwd);
  if (!real.startsWith(realpathSync(worktreesDir()) + sep)) throw new Error("Only worktrees OpenBuild made can be removed here");
  const top = await git(real, ["rev-parse", "--git-common-dir"]);
  const branch = (await git(real, ["branch", "--show-current"])).out;
  const repo = top.code === 0 ? resolve(real, top.out, "..") : undefined;
  if (!repo) throw new Error("This isn't a git worktree anymore");
  const r = await git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), real]);
  if (r.code !== 0) throw new Error(r.err.includes("modified or untracked") ? "The worktree has uncommitted changes" : r.err || "Couldn't remove the worktree");
  if (branch) await git(repo, ["branch", force ? "-D" : "-d", branch]);
}
