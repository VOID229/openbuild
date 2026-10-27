// Committing, pushing and opening pull requests from a thread's workspace (the thread header's
// Commit menu, src/components/GitMenu.tsx). A commit can take every change in the checkout, or only
// some paths: the files one thread touched, so two threads sharing a checkout commit separately.
// Paths are staged and committed by name (`git commit --only`), so whatever else is staged stays
// staged and out of the commit.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GitChange, GitChanges } from "../shared/types";

/** How much of a diff goes to the model that writes the commit message (Pi's one-off prompts take 20k). */
const MAX_DIFF = 15_000;
const MAX_UNTRACKED_FILE = 3_000;

async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out, err: err.trim() };
}

async function run(cmd: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { code, out: out.trim(), err: err.trim() };
  } catch (err) {
    return { code: 127, out: "", err: (err as Error).message };
  }
}

/** git's own words for why it failed, without the hint lines. */
const reason = (r: { err: string; out: string }, fallback: string) =>
  (r.err || r.out).split("\n").filter((l) => l.trim() && !/^hint:/.test(l)).slice(0, 6).join("\n") || fallback;

const fail = (r: { err: string; out: string }, fallback: string): never => {
  throw new Error(reason(r, fallback));
};

/** `git status --porcelain=v1 -z`, as changed paths relative to the repository's top. */
function parseStatus(raw: string): GitChange[] {
  const files: GitChange[] = [];
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const path = entry.slice(3);
    const change: GitChange = { path, status: x === "?" ? "?" : x === "D" || y === "D" ? "D" : x === "A" ? "A" : x === "R" ? "R" : x === "U" || y === "U" ? "U" : "M" };
    // A rename or copy is followed by the path it came from.
    if (x === "R" || x === "C") change.from = parts[++i];
    if (x !== " " && x !== "?") change.staged = true;
    files.push(change);
  }
  return files;
}

/** Whether a tool for opening pull requests (GitHub's `gh`) is on this machine. */
let ghPath: string | null | undefined;
const gh = () => (ghPath === undefined ? (ghPath = Bun.which("gh")) : ghPath);

/** The checkout's branch, what has changed in it, and where it stands against its upstream. */
export async function changes(cwd: string): Promise<GitChanges> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { repo: false, files: [] };
  const root = top.out.trim();
  const [prefix, branch, status, upstream, counts, remotes, head] = await Promise.all([
    git(cwd, ["rev-parse", "--show-prefix"]),
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
    git(cwd, ["remote"]),
    git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]),
  ]);
  const [behind, ahead] = counts.code === 0 ? counts.out.trim().split(/\s+/).map(Number) : [];
  const remote = remotes.out.split("\n").map((r) => r.trim()).filter(Boolean);
  const name = branch.out.trim() || undefined;
  // Commits not on any remote yet, for a branch that has never been pushed.
  let unpushed = ahead;
  if (upstream.code !== 0 && name && remote.length && head.code === 0) {
    const r = await git(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (r.code === 0) unpushed = Number(r.out.trim()) || 0;
  }
  return {
    repo: true,
    root,
    prefix: prefix.out.trim(),
    branch: name,
    upstream: upstream.code === 0 ? upstream.out.trim() : undefined,
    ahead: unpushed,
    behind,
    remote: remote.includes("origin") ? "origin" : remote[0],
    defaultBranch: remote.length ? await defaultBranch(cwd, remote.includes("origin") ? "origin" : remote[0]!) : undefined,
    files: status.code === 0 ? parseStatus(status.out) : [],
    gh: !!gh(),
  };
}

/** The remote's default branch (what a pull request goes into), when git knows it. */
async function defaultBranch(cwd: string, remote: string): Promise<string | undefined> {
  const r = await git(cwd, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
  if (r.code === 0) return r.out.trim().replace(`${remote}/`, "");
  for (const b of ["main", "master"]) if ((await git(cwd, ["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${b}`])).code === 0) return b;
  return undefined;
}

/** Paths are relative to the repository's top, as `changes` gives them; none may climb out of it. */
function checkPaths(paths: unknown): string[] | undefined {
  if (paths === undefined) return undefined;
  if (!Array.isArray(paths) || paths.length > 5000 || !paths.every((p) => typeof p === "string" && p.length > 0 && p.length < 4096 && !p.includes("\0")))
    throw new Error("Expected paths to be a list of file paths");
  if (paths.some((p) => p.startsWith("/") || p.split("/").includes(".."))) throw new Error("Paths must be inside the repository");
  return paths;
}

async function topOf(cwd: string): Promise<string> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) throw new Error("This folder isn't a git repository");
  return r.out.trim();
}

/** What a commit of these paths (or of everything) would change, for writing its message. */
export async function diff(cwd: string, rawPaths?: unknown): Promise<{ diff: string; recent: string[] }> {
  const paths = checkPaths(rawPaths);
  const root = await topOf(cwd);
  const spec = paths ? ["--", ...paths] : [];
  const [tracked, untracked, log, head] = await Promise.all([
    git(root, ["diff", "HEAD", "--stat", "--patch", "--no-color", "--no-ext-diff", ...spec]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z", ...spec]),
    git(root, ["log", "-12", "--format=%s"]),
    git(root, ["rev-parse", "--verify", "-q", "HEAD"]),
  ]);
  // Before the first commit there's no HEAD to compare with: everything staged is new.
  let text = head.code === 0 ? tracked.out : (await git(root, ["diff", "--cached", "--patch", "--no-color", ...spec])).out;
  for (const file of untracked.out.split("\0").filter(Boolean)) {
    if (text.length > MAX_DIFF) break;
    let body = "(binary or unreadable)";
    try {
      const full = join(root, file);
      if (statSync(full).size <= 512_000) {
        const buf = readFileSync(full);
        if (!buf.includes(0)) body = buf.toString("utf8").slice(0, MAX_UNTRACKED_FILE);
      }
    } catch {}
    text += `\nnew file: ${file}\n${body}\n`;
  }
  return { diff: text.length > MAX_DIFF ? `${text.slice(0, MAX_DIFF)}\n… (diff truncated)` : text, recent: log.code === 0 ? log.out.split("\n").filter(Boolean) : [] };
}

/** Commit these paths (or every change) with this message. */
export async function commit(cwd: string, message: unknown, rawPaths?: unknown): Promise<{ sha: string }> {
  if (typeof message !== "string" || !message.trim() || message.length > 20_000) throw new Error("A commit needs a message");
  const paths = checkPaths(rawPaths);
  if (paths && !paths.length) throw new Error("Nothing to commit");
  const root = await topOf(cwd);
  // Staging by name takes in new files and deletions too; `--only` then commits just those paths.
  const add = await git(root, ["add", "-A", "--", ...(paths ?? ["."])], 120_000);
  if (add.code !== 0) fail(add, "Couldn't stage the changes");
  const r = await git(root, ["commit", "-m", message.trim(), ...(paths ? ["--only", "--", ...paths] : [])], 5 * 60_000);
  if (r.code !== 0) fail(r, "git commit failed");
  const sha = await git(root, ["rev-parse", "--short", "HEAD"]);
  return { sha: sha.out.trim() };
}

/** Push the branch, setting its upstream the first time. */
export async function push(cwd: string): Promise<{ upstream: string }> {
  const state = await changes(cwd);
  if (!state.repo) throw new Error("This folder isn't a git repository");
  if (!state.branch) throw new Error("Not on a branch (detached HEAD), so there's nothing to push to");
  if (!state.upstream && !state.remote) throw new Error("This repository has no remote to push to");
  const args = state.upstream ? ["push"] : ["push", "--set-upstream", state.remote!, state.branch];
  const r = await git(cwd, args, 5 * 60_000);
  if (r.code !== 0) fail(r, "git push failed");
  return { upstream: state.upstream ?? `${state.remote}/${state.branch}` };
}

/** Open a pull request for the branch with GitHub's `gh` (pushing it first), or find the one that's open. */
export async function pullRequest(cwd: string): Promise<{ url: string; existing: boolean }> {
  const bin = gh();
  if (!bin) throw new Error("Creating a pull request needs the GitHub CLI (gh) on this machine");
  const state = await changes(cwd);
  if (!state.repo || !state.branch) throw new Error("Not on a branch, so there's nothing to open a pull request for");
  if (state.defaultBranch && state.branch === state.defaultBranch) throw new Error(`You're on ${state.branch}, the default branch. Switch to another branch to open a pull request.`);
  const open = await run([bin, "pr", "view", "--json", "url,state", "-q", 'select(.state == "OPEN") | .url'], cwd, 60_000);
  if (open.code === 0 && open.out) return { url: open.out, existing: true };
  if (!state.upstream || state.ahead) await push(cwd);
  const r = await run([bin, "pr", "create", "--fill", "--head", state.branch, ...(state.defaultBranch ? ["--base", state.defaultBranch] : [])], cwd, 2 * 60_000);
  if (r.code !== 0) fail(r, "gh pr create failed");
  const url = r.out.split("\n").reverse().find((l) => /^https?:\/\//.test(l.trim()));
  if (!url) throw new Error(r.out || "gh didn't say where the pull request is");
  return { url: url.trim(), existing: false };
}
