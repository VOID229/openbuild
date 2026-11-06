import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ob-remove-worktree-"));
const previousDataDir = process.env.OPENCHAT_DATA_DIR;
process.env.OPENCHAT_DATA_DIR = join(root, "data");
const { removeWorktree, worktreesDir } = await import("../server/projects");
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAT_DATA_DIR;
  else process.env.OPENCHAT_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

test("a missing checkout succeeds even before the worktrees directory exists", async () => {
  await expect(removeWorktree(join(worktreesDir(), "project", "tmp-missing"))).resolves.toBeUndefined();
});

test("other realpath errors still surface", async () => {
  const loop = join(root, "loop");
  symlinkSync(loop, loop);
  await expect(removeWorktree(loop)).rejects.toMatchObject({ code: "ELOOP" });
});

test("an existing directory outside managed worktrees is rejected", async () => {
  mkdirSync(worktreesDir(), { recursive: true });
  await expect(removeWorktree(root)).rejects.toThrow("Only worktrees OpenBuild made can be removed here");
});

test("git removal errors still surface and preserve a dirty worktree", async () => {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: repo });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  git("init", "-b", "main");
  git("commit", "--allow-empty", "-m", "init");
  const checkout = join(worktreesDir(), "dirty");
  git("worktree", "add", "-b", "openbuild/dirty", checkout);
  await Bun.write(join(checkout, "untracked.txt"), "keep me");
  await expect(removeWorktree(checkout)).rejects.toThrow("The worktree has uncommitted changes");
  expect(await Bun.file(join(checkout, "untracked.txt")).text()).toBe("keep me");
});
