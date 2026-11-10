// Where a clone lands (shared/clone.ts, server/projects.ts): into an existing folder it goes in a
// subfolder named after the repository, any other path is the clone itself. The real clones run in
// cloneProject.scenario.ts, in its own process on a throwaway data directory.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneTarget, repoName } from "../shared/clone";
import { browse } from "../server/projects";

test("the repository's name comes from any kind of git URL", () => {
  expect(repoName("https://github.com/dkod-ai/kodbot.git")).toBe("kodbot");
  expect(repoName("https://github.com/dkod-ai/kodbot/")).toBe("kodbot");
  expect(repoName("git@github.com:dkod-ai/kodbot.git")).toBe("kodbot");
  expect(repoName("ssh://git@host/x/kodbot.git ")).toBe("kodbot");
  expect(repoName("")).toBe("");
});

test("an existing folder gets the clone in a subfolder; any other path is the clone", () => {
  const url = "https://github.com/dkod-ai/kodbot.git";
  expect(cloneTarget(url, "~/Efforts/active", true)).toBe("~/Efforts/active/kodbot");
  expect(cloneTarget(url, "~/Efforts/active/", true)).toBe("~/Efforts/active/kodbot");
  expect(cloneTarget(url, "~/Efforts/active", false)).toBe("~/Efforts/active");
  // No usable name: the path as it is.
  expect(cloneTarget("", "~/x", true)).toBe("~/x");
  expect(cloneTarget("https://host/..", "~/x", true)).toBe("~/x");
});

test("a folder listing says whether the folder is empty, files included", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-clone-browse-"));
  try {
    expect(browse(dir).empty).toBe(true);
    writeFileSync(join(dir, "file.txt"), "x");
    expect(browse(dir).empty).toBe(false);
    expect(browse(dir).entries).toEqual([]);
    mkdirSync(join(dir, "sub"));
    expect(browse(join(dir, "sub")).empty).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real clones from a local repository, on a throwaway data directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-clone-"));
  try {
    const run = Bun.spawnSync([process.execPath, "test", "./tests/cloneProject.scenario.ts"], {
      env: { ...process.env, OPENCHAT_DATA_DIR: dir, OPENBUILD_CLONE_SCENARIO: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
