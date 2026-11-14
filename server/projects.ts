// Projects (directories threads work in, usually git repositories), their branches, and the git
// worktrees OpenBuild makes so a thread can work on its own branch without touching the project's
// checkout. Worktrees live in <data dir>/worktrees/<project>/<name>.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { cloneTarget } from "../shared/clone";
import type { GitInfo, Project, Workspace } from "../shared/types";
import * as storage from "./storage";
import { temporaryWorktreeBranch, renameTemporaryBranch } from "./worktreeNaming";

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

/**
 * Runs git, stopped at `timeoutMs` or when `signal` aborts. It runs in a process group of its own, and
 * stopping kills the whole group: a fetch's ssh or https helper would otherwise hold the output open,
 * and the call would wait on it past its time.
 */
async function git(cwd: string, args: string[], timeoutMs = 30_000, env: Record<string, string> = {}, signal?: AbortSignal): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env } });
  const stop = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  };
  const timer = setTimeout(stop, timeoutMs);
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  signal?.removeEventListener("abort", stop);
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

/**
 * Where a path really lands: every symlink on the way resolved, and whatever doesn't exist yet kept as
 * written, so it can be checked before anything is made there. A broken link on the way is refused.
 */
export function canonicalPath(rawPath: string): string {
  let dir = expand(rawPath);
  const rest: string[] = [];
  while (!existsSync(dir)) {
    let link = false;
    try {
      link = lstatSync(dir).isSymbolicLink();
    } catch {}
    if (link) throw new Error(`${tilde(dir)} is a link to something that isn't there`);
    const up = dirname(dir);
    if (up === dir) break;
    rest.unshift(basename(dir));
    dir = up;
  }
  return join(realpathSync(dir), ...rest);
}

/** Refuses a project root it doesn't want, by throwing. Called with canonical paths only. */
export type ProjectGuard = (root: string) => void;

export function listProjects(): Project[] {
  return stored().map((p) => ({ ...p, git: existsSync(join(p.path, ".git")), missing: !isDir(p.path) }));
}

export const findProject = (id: string) => listProjects().find((p) => p.id === id);

/**
 * Add a directory as a project (a repository's root when it's inside one). With `create`, a folder
 * that doesn't exist yet is made first: that's how a new project starts.
 */
export async function addProject(rawPath: string, opts: { name?: string; create?: boolean; allow?: ProjectGuard } = {}): Promise<Project> {
  let path = expand(rawPath);
  // Before a folder is made: where it would land, through any links.
  opts.allow?.(canonicalPath(path));
  if (!isDir(path)) {
    if (!opts.create || existsSync(path)) throw new Error(`No folder at ${tilde(path)}`);
    mkdirSync(path, { recursive: true });
  }
  path = realpathSync(path);
  const top = await git(path, ["rev-parse", "--show-toplevel"]);
  if (top.code === 0 && top.out) path = realpathSync(top.out);
  // And the root that's saved: links resolved and promoted to its repository's top.
  opts.allow?.(path);
  const list = stored();
  const existing = list.find((p) => p.path === path);
  if (existing) return { ...existing, git: top.code === 0 };
  const project = { id: crypto.randomUUID().slice(0, 8), name: opts.name?.trim().slice(0, 80) || basename(path), path };
  store([...list, project]);
  return { ...project, git: top.code === 0 };
}

/** A repository URL git can clone over the network: https, ssh, or scp-style (git@host:owner/repo). */
const CLONE_URL = /^(?:(?:https?|ssh|git):\/\/[^\s/]+\/\S+|[\w.-]+@[\w.-]+:\S+)$/;

/**
 * Clone a repository and add it as a project. Into an existing folder it goes in a subfolder named
 * after the repository (~/code + …/app.git is ~/code/app); any other path is the clone's own folder.
 */
export async function cloneProject(url: string, rawPath: string, name?: string, allow?: ProjectGuard): Promise<Project> {
  url = url.trim();
  if (!CLONE_URL.test(url)) throw new Error("That doesn't look like a git URL (https://…, ssh://… or git@host:owner/repo)");
  const path = cloneTarget(url, expand(rawPath), isDir(expand(rawPath)));
  // Nothing is written until where it lands checks out.
  allow?.(canonicalPath(path));
  if (existsSync(path) && (!isDir(path) || readdirSync(path).length)) throw new Error(`${tilde(path)} already exists and isn't empty`);
  mkdirSync(dirname(path), { recursive: true });
  const r = await git(dirname(path), ["clone", "--", url, path], 10 * 60_000, {
    // Network transports only (no ext:: or file://), and ssh fails instead of waiting for a prompt.
    GIT_ALLOW_PROTOCOL: "https:http:ssh:git",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
  });
  if (r.code !== 0) throw new Error(r.err.split("\n").filter((l) => !l.startsWith("Cloning into")).pop() || "Couldn't clone the repository");
  return addProject(path, { name, allow });
}

export function removeProject(id: string) {
  store(stored().filter((p) => p.id !== id));
}

export function renameProject(id: string, name: string) {
  store(stored().map((p) => (p.id === id ? { ...p, name: name.trim().slice(0, 80) || p.name } : p)));
}

/**
 * Subfolders of a folder (an error when there's no folder there); repositories are marked. `hidden`
 * also lists dotfolders (bar "." and ".."), for a path being typed that starts with a dot. `empty`
 * when the folder holds nothing at all, files included.
 */
export function browse(rawDir: string | undefined, opts: { hidden?: boolean } = {}): { dir: string; parent?: string; empty: boolean; entries: { name: string; path: string; git: boolean }[] } {
  const dir = expand(rawDir || homedir());
  if (!isDir(dir)) throw new Error(`No folder at ${tilde(dir)}`);
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name !== "node_modules" && e.name !== "Library" && (opts.hidden ? e.name !== "." && e.name !== ".." : !e.name.startsWith(".")))
    .map((e) => ({ name: e.name, path: join(dir, e.name), git: existsSync(join(dir, e.name, ".git")) }))
    .filter((e) => isDir(e.path))
    .sort((a, b) => Number(b.git) - Number(a.git) || a.name.localeCompare(b.name));
  const parent = resolve(dir, "..");
  return { dir, parent: parent !== dir ? parent : undefined, empty: !readdirSync(dir).length, entries };
}

export async function gitInfo(cwd: string): Promise<GitInfo> {
  const [branch, head, branches, status, counts, originHead, worktrees, top, remotes] = await Promise.all([
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["rev-parse", "--short", "HEAD"]),
    git(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]),
    git(cwd, ["status", "--porcelain"]),
    git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    git(cwd, ["worktree", "list", "--porcelain"]),
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["remote"]),
  ]);
  const [behind, ahead] = counts.code === 0 ? counts.out.split(/\s+/).map(Number) : [];
  const names = branches.code === 0 ? branches.out.split("\n").filter(Boolean) : [];
  // The default branch: what origin's HEAD points at, else main or master, when it's a branch here.
  const fromOrigin = originHead.code === 0 ? originHead.out.replace(/^origin\//, "") : undefined;
  const defaultBranch = [fromOrigin, "main", "master"].find((b) => b && names.includes(b));
  return {
    branch: branch.out || undefined,
    head: !branch.out && head.code === 0 ? head.out || undefined : undefined,
    branches: names,
    defaultBranch,
    worktrees: worktrees.code === 0 ? worktreeBranches(worktrees.out, top.code === 0 ? top.out : cwd) : [],
    remote: remotes.code === 0 && !!remotes.out,
    dirty: status.code === 0 ? status.out.split("\n").filter(Boolean).length : 0,
    ahead,
    behind,
  };
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The branches `git worktree list --porcelain` shows checked out, but in the checkout at `own`. */
function worktreeBranches(porcelain: string, own: string): string[] {
  const mine = real(own);
  return porcelain
    .split("\n\n")
    .map((entry) => ({ path: /^worktree (.+)$/m.exec(entry)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1] }))
    .filter((w): w is { path: string; branch: string } => !!w.path && !!w.branch && real(w.path) !== mine)
    .map((w) => w.branch);
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

/** A registered project, an OpenBuild workspace, or the exact cwd of a discovered Pi session or imported thread. */
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
  // Threads imported from a native runtime (sessionImport.ts) work where their session did.
  for (const [, value] of storage.listValues("imported-session:")) {
    try {
      const session = JSON.parse(value);
      if (realpathSync(session.cwd) === real) return true;
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

/** ssh fails instead of waiting for a prompt (git's own prompts are off for every command). */
/**
 * How long a worktree waits on fetching its remote base before starting from the local branch. Well
 * inside the app's wait for the whole start (REQUEST_TIMEOUT_MS in src/lib/abort.ts), so the answer
 * always gets back to it.
 */
export const REMOTE_FETCH_TIMEOUT_MS = 10_000;

const NETWORK_ENV = () => ({ GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" });

/**
 * The remote-tracking ref a worktree starts from when it starts from the remote: the local branch's
 * tracked remote branch, even under another name, else the same-named branch on origin. It's fetched
 * first. Undefined, so the local branch is used, when there's no remote, the remote has no such
 * branch, or the fetch fails. Only that remote-tracking ref is written: the local branch never moves.
 */
export async function remoteBase(repo: string, branch: string, signal?: AbortSignal): Promise<string | undefined> {
  const [refs, remotes] = await Promise.all([
    git(repo, ["for-each-ref", "--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)", `refs/heads/${branch}`]),
    git(repo, ["remote"]),
  ]);
  const known = new Set(remotes.code === 0 ? remotes.out.split("\n").filter(Boolean) : []);
  const own = refs.code === 0 ? refs.out.split("\n").map((l) => l.split("\0")).find((f) => f[0] === `refs/heads/${branch}`) : undefined;
  // Not a local branch (a commit, a tag): it is what it is.
  if (!own) return undefined;
  const [, tracking, remote, ref] = own;
  // A branch tracking another local branch (remote ".") has no remote of its own: origin's then.
  const target = remote && known.has(remote) && tracking?.startsWith("refs/remotes/") && ref?.startsWith("refs/heads/")
    ? { remote, ref, tracking }
    : known.has("origin") ? { remote: "origin", ref: `refs/heads/${branch}`, tracking: `refs/remotes/origin/${branch}` } : undefined;
  if (!target) return undefined;
  const fetched = await git(repo, ["fetch", "--quiet", "--no-tags", target.remote, `+${target.ref}:${target.tracking}`], REMOTE_FETCH_TIMEOUT_MS, NETWORK_ENV(), signal);
  if (fetched.code !== 0) return undefined;
  const commit = await git(repo, ["rev-parse", "--verify", "--quiet", `${target.tracking}^{commit}`]);
  return commit.code === 0 ? target.tracking : undefined;
}

/**
 * Prepare a new thread's workspace. "local" works in the project's checkout, switching it to
 * `branch` first if asked (only when there's nothing uncommitted to carry over). "worktree" makes a
 * worktree on a new branch started from `branch`, else the current one, else (a checkout detached at
 * a commit) the default branch. With `remote`, a worktree starts from that branch's remote branch,
 * fetched first (see remoteBase), and from the local branch when that can't be had.
 *
 * `signal` is the asker going away (the app gave up waiting, or the start was stopped): a worktree is
 * then never left behind for a thread that won't exist. Before it's made, nothing is; once it's made,
 * it's removed again, with its branch.
 */
export async function prepareWorkspace(projectId: string, mode: "local" | "worktree", branch?: string, opts: { remote?: boolean; signal?: AbortSignal } = {}): Promise<Workspace> {
  const { signal } = opts;
  const cancelled = () => new Error("The thread start was cancelled");
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
  const from = branch || info.branch || info.defaultBranch || "HEAD";
  const remote = opts.remote === true && from !== "HEAD" ? await remoteBase(project.path, from, signal) : undefined;
  if (signal?.aborted) throw cancelled();
  const newBranch = temporaryWorktreeBranch();
  const dir = join(worktreesDir(), slug(project.name) || project.id, newBranch.slice("openbuild/".length));
  mkdirSync(join(worktreesDir(), slug(project.name) || project.id), { recursive: true });
  // --no-track: started from a remote branch, the thread's branch would otherwise push to it.
  const r = await git(project.path, ["worktree", "add", "--no-track", "-b", newBranch, dir, remote ?? from], 120_000);
  if (r.code !== 0) throw new Error(r.err || "Couldn't create the worktree");
  if (signal?.aborted) {
    await discardWorktree(project.path, dir, newBranch);
    throw cancelled();
  }
  return { ...base, cwd: dir, branch: newBranch, worktree: true, base: from, ...(remote ? { remoteBase: remote.replace(/^refs\/remotes\//, "") } : {}) };
}

/** Undo a worktree just made: the folder, git's record of it, and its branch. */
async function discardWorktree(repo: string, dir: string, branch: string) {
  const removed = await git(repo, ["worktree", "remove", "--force", dir]);
  if (removed.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    await git(repo, ["worktree", "prune"]);
  }
  await git(repo, ["branch", "-D", branch]);
}

/** Rename only a managed worktree's temporary branch, never its directory. */
export async function nameWorktree(cwd: string, expected: string, name: string): Promise<string | null> {
  const real = realpathSync(cwd);
  if (!real.startsWith(realpathSync(worktreesDir()) + sep)) throw new Error("Only worktrees OpenBuild made can be named here");
  return renameTemporaryBranch(real, expected, name);
}

/**
 * Remove a worktree OpenBuild made, and its branch if git sees it merged or `forceBranch` (a squash
 * merge leaves the branch's commits off the base, so only GitHub can say it merged).
 */
export async function removeWorktree(cwd: string, force = false, forceBranch = force): Promise<void> {
  let real: string;
  try {
    real = realpathSync(cwd);
  } catch (err) {
    // A pruned or never-created checkout is already cleaned up.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!real.startsWith(realpathSync(worktreesDir()) + sep)) throw new Error("Only worktrees OpenBuild made can be removed here");
  const top = await git(real, ["rev-parse", "--git-common-dir"]);
  const branch = (await git(real, ["branch", "--show-current"])).out;
  const repo = top.code === 0 ? resolve(real, top.out, "..") : undefined;
  if (!repo) throw new Error("This isn't a git worktree anymore");
  const r = await git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), real]);
  if (r.code !== 0) throw new Error(r.err.includes("modified or untracked") ? "The worktree has uncommitted changes" : r.err || "Couldn't remove the worktree");
  if (branch) await git(repo, ["branch", forceBranch ? "-D" : "-d", branch]);
}
