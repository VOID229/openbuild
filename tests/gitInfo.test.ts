// What the branch picker reads about a checkout: its branch, or the commit when HEAD is detached.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitInfo } from "../server/projects";

describe("gitInfo", () => {
  let dir: string;
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "git-info-"));
    git("init", "-b", "main");
    git("commit", "--allow-empty", "-m", "first");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("on a branch there is no separate commit", async () => {
    const info = await gitInfo(dir);
    expect(info.branch).toBe("main");
    expect(info.head).toBeUndefined();
  });

  test("a detached HEAD reports its short commit, and the branches stay listed", async () => {
    git("switch", "--detach");
    const info = await gitInfo(dir);
    expect(info.branch).toBeUndefined();
    expect(info.head).toBe(git("rev-parse", "--short", "HEAD"));
    expect(info.branches).toEqual(["main"]);
    git("switch", "main");
  });

  test("a folder that isn't a repository has neither", async () => {
    const plain = mkdtempSync(join(tmpdir(), "git-info-plain-"));
    const info = await gitInfo(plain);
    rmSync(plain, { recursive: true, force: true });
    expect(info.branch).toBeUndefined();
    expect(info.head).toBeUndefined();
  });
});
