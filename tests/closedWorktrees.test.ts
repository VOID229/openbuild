// "Delete worktrees of closed threads" (server/closedWorktrees.ts): a closed thread keeps its worktree
// for a day, then the sweep removes it. Runs in its own process with its own data dir, so it never
// touches the user's database or worktrees.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

const script = `
  import { strict as assert } from "node:assert";
  import { existsSync, writeFileSync } from "node:fs";
  const root = process.env.TEST_ROOT;
  const sh = (cwd, ...args) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const repo = root + "/repo";
  Bun.spawnSync(["mkdir", "-p", repo]);
  sh(repo, "init", "-b", "main");
  sh(repo, "commit", "--allow-empty", "-m", "first");

  const storage = await import("./server/storage.ts");
  const projects = await import("./server/projects.ts");
  const cw = await import("./server/closedWorktrees.ts");
  const setting = (on) => storage.setValue("client-state", JSON.stringify({ state: { settings: { autoDeleteWorktrees: on } } }));

  const project = await projects.addProject(repo);
  const ws = async (p) => projects.prepareWorkspace(project.id, "worktree", undefined, p);
  const now = Date.now();
  const day = cw.KEEP_FOR;
  const chat = (id, workspace, extra = {}) => ({ id, title: id, createdAt: now - 3 * day, updatedAt: now - 3 * day, workspace, messages: [], ...extra });

  const old = await ws("closed two days ago");
  const recent = await ws("closed an hour ago");
  const shared = await ws("closed, but a fork is open");
  const dirty = await ws("closed with work in it");
  const legacy = await ws("closed before closedAt");
  const merged = await ws("closed by a merge");
  writeFileSync(dirty.cwd + "/wip.txt", "x");
  storage.putChat(chat("old", old, { archived: true, closedAt: now - 2 * day }));
  storage.putChat(chat("recent", recent, { archived: true, closedAt: now - 3600_000 }));
  storage.putChat(chat("shared", shared, { archived: true, closedAt: now - 2 * day }));
  storage.putChat(chat("fork", shared));
  storage.putChat(chat("dirty", dirty, { archived: true, closedAt: now - 2 * day }));
  storage.putChat(chat("legacy", legacy, { archived: true }));
  storage.putChat(chat("merged", merged, { archived: true, autoClosedAt: now - 2 * day }));
  storage.putChat(chat("remote", { ...old, cwd: "/elsewhere/wt", deviceId: "dev1" }, { archived: true, closedAt: now - 2 * day }));
  storage.putChat(chat("reopened", { ...old, cwd: "/elsewhere/wt2", deviceId: "dev1" }, { archived: false, closedAt: now - 2 * day }));

  const remote = [];
  const removeRemote = async (deviceId, cwd) => { remote.push(deviceId + ":" + cwd); };

  setting(false);
  await cw.sweepClosedWorktrees(removeRemote);
  assert.equal(existsSync(old.cwd), true, "off: nothing is removed");

  setting(true);
  await cw.sweepClosedWorktrees(removeRemote);
  assert.equal(existsSync(old.cwd), false, "closed over a day ago");
  assert.equal(existsSync(merged.cwd), false, "closed by a merge over a day ago");
  assert.equal(existsSync(recent.cwd), true, "closed under a day ago");
  assert.equal(existsSync(shared.cwd), true, "an open thread still works in it");
  assert.equal(existsSync(dirty.cwd), true, "uncommitted work stays");
  assert.equal(existsSync(legacy.cwd), true, "no close time: left alone");
  assert.deepEqual(remote, ["dev1:/elsewhere/wt"], "a paired device's goes to the device, and only a closed thread's");

  await cw.sweepClosedWorktrees(removeRemote);
  assert.equal(remote.length, 1, "a removed device worktree isn't asked again");

  // A day on, the recent one goes too.
  await cw.sweepClosedWorktrees(removeRemote, now + day);
  assert.equal(existsSync(recent.cwd), false);
  console.log("ok");
`;

test("closed threads' worktrees are removed a day after they close", async () => {
  const root = mkdtempSync(join(tmpdir(), "openbuild-closed-worktrees-"));
  try {
    const { stdout: out, stderr: err, code } = await spawnScript(script, { OPENCHAT_DATA_DIR: join(root, "data"), TEST_ROOT: root });
    if (code !== 0) console.error(out, err);
    expect(code).toBe(0);
    expect(out).toContain("ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
