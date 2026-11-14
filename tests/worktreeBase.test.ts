// Where a new thread's worktree starts (server/projects.ts prepareWorkspace): a checkout detached at a
// commit starts from the default branch, and "Start from remote" starts from the base branch's remote
// branch, fetched first, falling back to the local branch without failing. Runs in its own process
// with its own data dir, so it never touches the user's projects or worktrees.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

const script = `
  import { strict as assert } from "node:assert";
  const root = process.env.TEST_ROOT;
  const sh = (cwd, ...args) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd });
    if (r.exitCode !== 0) throw new Error(args.join(" ") + ": " + r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const commit = (cwd, m) => (sh(cwd, "commit", "-q", "--allow-empty", "-m", m), sh(cwd, "rev-parse", "HEAD"));
  const head = (cwd) => sh(cwd, "rev-parse", "HEAD");
  const projects = await import("./server/projects.ts");

  // origin, the project's clone of it, and another clone that pushes ahead of the project.
  sh(root, "init", "-q", "--bare", "origin.git");
  sh(root, "clone", "-q", "origin.git", "app");
  const app = root + "/app", other = root + "/other";
  sh(app, "switch", "-q", "-c", "main");
  const first = commit(app, "first");
  sh(app, "push", "-q", "-u", "origin", "main");
  sh(app, "remote", "set-head", "origin", "main");
  sh(app, "switch", "-q", "-c", "feature");
  const feature = commit(app, "feature work");
  sh(app, "switch", "-q", "main");
  sh(root, "clone", "-q", "origin.git", "other");
  const ahead = commit(other, "pushed from elsewhere");
  sh(other, "push", "-q", "origin", "main");
  const project = await projects.addProject(app);
  const start = (branch, remote) => projects.prepareWorkspace(project.id, "worktree", branch, { remote });

  // A checkout detached at a commit: the worktree starts from the default branch, not the commit.
  sh(app, "switch", "-q", "--detach", "feature");
  let info = await projects.gitInfo(app);
  assert.equal(info.branch, undefined);
  assert.equal(info.defaultBranch, "main");
  assert.equal(info.remote, true);
  let ws = await start(undefined, false);
  assert.equal(ws.base, "main");
  assert.equal(head(ws.cwd), first, "detached: from main's commit");
  assert.notEqual(head(ws.cwd), feature);
  assert.equal(ws.remoteBase, undefined);
  // On a named branch, the current branch stays the default.
  sh(app, "switch", "-q", "feature");
  ws = await start(undefined, false);
  assert.equal(ws.base, "feature");
  assert.equal(head(ws.cwd), feature);
  sh(app, "switch", "-q", "--detach", "feature");

  // From remote: origin's main is a commit ahead, so the worktree starts there, after a fetch.
  ws = await start("main", true);
  assert.equal(head(ws.cwd), ahead, "from the remote branch's latest commit");
  assert.equal(ws.base, "main");
  assert.equal(ws.remoteBase, "origin/main");
  assert.equal(sh(app, "rev-parse", "main"), first, "the local branch never moves");
  assert.equal(sh(app, "rev-parse", "origin/main"), ahead);
  // The thread's own branch doesn't track origin/main, so a push never lands on main.
  assert.equal(Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: ws.cwd }).exitCode !== 0, true);
  // And the detached default goes to the remote too.
  ws = await start(undefined, true);
  assert.equal(head(ws.cwd), ahead);
  // Off: the local branch.
  ws = await start("main", false);
  assert.equal(head(ws.cwd), first);

  // A branch tracking a remote branch under another name starts from that one.
  sh(other, "switch", "-q", "-c", "their-name");
  const theirs = commit(other, "on their branch");
  sh(other, "push", "-q", "origin", "their-name");
  sh(app, "fetch", "-q", "origin");
  sh(app, "branch", "-q", "my-name", "main");
  sh(app, "branch", "-q", "--set-upstream-to=origin/their-name", "my-name");
  sh(other, "commit", "-q", "--allow-empty", "-m", "newer on their branch");
  sh(other, "push", "-q", "origin", "their-name");
  const newest = head(other);
  assert.notEqual(newest, theirs);
  ws = await start("my-name", true);
  assert.equal(head(ws.cwd), newest, "the tracked branch, fetched");
  assert.equal(ws.remoteBase, "origin/their-name");
  assert.equal(sh(app, "rev-parse", "my-name"), first);

  // No such branch on origin: the local branch, and the thread still starts.
  ws = await start("feature", true);
  assert.equal(head(ws.cwd), feature);
  assert.equal(ws.remoteBase, undefined);

  // The fetch fails (origin's gone): the local branch.
  sh(app, "remote", "set-url", "origin", root + "/missing.git");
  ws = await start("main", true);
  assert.equal(head(ws.cwd), first);
  assert.equal(ws.remoteBase, undefined);

  // No remote at all: the local branch.
  sh(app, "remote", "remove", "origin");
  info = await projects.gitInfo(app);
  assert.equal(info.remote, false);
  assert.equal(info.defaultBranch, "main", "main still counts as the default without origin's HEAD");
  ws = await start("main", true);
  assert.equal(head(ws.cwd), first);
  assert.equal(ws.remoteBase, undefined);

  // Local checkout mode never fetches or starts elsewhere: it works on the branch as it is.
  const local = await projects.prepareWorkspace(project.id, "local", "main", { remote: true });
  assert.equal(local.cwd, project.path);
  assert.equal(head(app), first);
  console.log("ok");
`;

test("a worktree starts from the default branch when detached, and from the remote branch when it can", async () => {
  const root = mkdtempSync(join(tmpdir(), "openbuild-worktree-base-"));
  try {
    const { stdout: out, stderr: err, code } = await spawnScript(script, { OPENCHAT_DATA_DIR: join(root, "data"), TEST_ROOT: root });
    if (code !== 0) console.error(out, err);
    expect(code).toBe(0);
    expect(out).toContain("ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
