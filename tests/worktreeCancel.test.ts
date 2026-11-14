// A new thread's worktree and an app that stops waiting for it (server/projects.ts prepareWorkspace,
// through POST /api/workspaces): a remote that never answers is given up on well inside the app's own
// wait, and when the app goes away mid-start no worktree is left without a thread. Runs in its own
// process with its own data dir, so it never touches the user's projects or worktrees.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

const script = `
  import { strict as assert } from "node:assert";
  import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
  const root = process.env.TEST_ROOT;
  const sh = (cwd, ...args) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd });
    if (r.exitCode !== 0) throw new Error(args.join(" ") + ": " + r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const projects = await import("./server/projects.ts");
  const { REQUEST_TIMEOUT_MS } = await import("./src/lib/abort.ts");
  const { piRoutes } = await import("./server/pi/routes.ts");
  const routes = piRoutes((handler) => handler);

  // A remote that takes the connection and never answers.
  const silent = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise(() => {}) });
  // Named at random, so only git's processes have it on their command line (not this script's own).
  const tag = "silent-" + crypto.randomUUID().slice(0, 8);
  const remoteUrl = "http://127.0.0.1:" + silent.port + "/" + tag + ".git";
  sh(root, "init", "-q", "app");
  const app = root + "/app";
  sh(app, "commit", "-q", "--allow-empty", "-m", "first");
  const first = sh(app, "rev-parse", "HEAD");
  sh(app, "remote", "add", "origin", remoteUrl);
  const project = await projects.addProject(app);

  // The app's side: POST /api/workspaces as the server routes it, each request's handling kept to wait on.
  const handling = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: (req) => { const p = routes["/api/workspaces"].POST(req); handling.push(p); return p; } });
  const start = (body, signal) => fetch("http://127.0.0.1:" + server.port + "/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id, mode: "worktree", ...body }), signal });
  const settled = async (what, within) => {
    const timer = Bun.sleep(within).then(() => "still running");
    assert.notEqual(await Promise.race([Promise.allSettled(handling).then(() => "done"), timer]), "still running", what);
    handling.length = 0;
  };
  const worktrees = () => sh(app, "worktree", "list", "--porcelain").split("\\n").filter((l) => l.startsWith("worktree ")).length;
  const threadBranches = () => sh(app, "branch", "--list", "openbuild/*");
  const fetching = () => Bun.spawnSync(["pgrep", "-f", tag]).stdout.toString().trim();
  assert.equal(worktrees(), 1);

  // The fetch is given up on well inside the app's wait for the whole start.
  assert.ok(projects.REMOTE_FETCH_TIMEOUT_MS * 2 <= REQUEST_TIMEOUT_MS, "fetch " + projects.REMOTE_FETCH_TIMEOUT_MS + " ms vs the app's " + REQUEST_TIMEOUT_MS + " ms");

  // 1. The app gives up while the fetch hangs: the server stops too, and makes nothing.
  await assert.rejects(start({ branch: "main", remote: true }, AbortSignal.timeout(500)));
  await settled("the start went on after the app left", 5000);
  assert.equal(worktrees(), 1, "no worktree");
  assert.equal(threadBranches(), "", "no thread branch");
  assert.equal(fetching(), "", "the fetch, ssh/https helper and all, is gone");

  // 2. The app gives up while the worktree is being made: it's removed again, with its branch.
  const mark = root + "/checkout-started";
  writeFileSync(app + "/.git/hooks/post-checkout", "#!/bin/sh\\ntouch '" + mark + "'\\nsleep 2\\n");
  chmodSync(app + "/.git/hooks/post-checkout", 0o755);
  const leaving = new AbortController();
  const asked = start({ branch: "main", remote: false }, leaving.signal);
  while (!existsSync(mark)) await Bun.sleep(20);
  leaving.abort();
  await assert.rejects(asked);
  await settled("the start never finished", 10_000);
  assert.equal(worktrees(), 1, "the worktree made for nobody is removed");
  assert.equal(threadBranches(), "", "and its branch");
  rmSync(app + "/.git/hooks/post-checkout");

  // 3. Nobody leaves, the remote never answers: the local branch, in about REMOTE_FETCH_TIMEOUT_MS.
  const began = Date.now();
  const res = await start({ branch: "main", remote: true }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  const took = Date.now() - began;
  assert.equal(res.status, 200);
  const { workspace } = await res.json();
  await settled("answered", 1000);
  assert.ok(took < projects.REMOTE_FETCH_TIMEOUT_MS + 5000, "answered in " + took + " ms");
  assert.equal(workspace.remoteBase, undefined);
  assert.equal(sh(workspace.cwd, "rev-parse", "HEAD"), first, "from the local branch");
  assert.equal(fetching(), "");
  console.log("ok");
  process.exit(0);
`;

test("a hanging remote is given up on in time, and a start the app leaves leaves no worktree", async () => {
  const root = mkdtempSync(join(tmpdir(), "openbuild-worktree-cancel-"));
  try {
    const { stdout: out, stderr: err, code } = await spawnScript(script, { OPENCHAT_DATA_DIR: join(root, "data"), TEST_ROOT: root });
    if (code !== 0) console.error(out, err);
    expect(code).toBe(0);
    expect(out).toContain("ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
