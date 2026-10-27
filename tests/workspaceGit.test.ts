// The Commit menu and the editor: a commit of one thread's files leaves everything else (staged or
// not) where it was, saving never overwrites a change made on disk since the file was read, and a
// thread owns the files its edit and write tools touched.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitChanges } from "../shared/types";
import { changes, commit } from "../server/workspaceGit";
import { listDir, readFile, writeFile as saveFile } from "../server/workspaceFiles";
import { commitPaths, commitScope, threadFiles } from "../src/lib/git";
import type { Chat } from "../src/lib/types";

let repo: string;
const sh = async (...args: string[]) => {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  return out.trim();
};

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "openbuild-git-"));
  await sh("init", "-q", "-b", "main");
  await sh("config", "user.email", "t@example.com");
  await sh("config", "user.name", "Test");
  await writeFile(join(repo, "a.txt"), "a\n");
  await writeFile(join(repo, "b.txt"), "b\n");
  await writeFile(join(repo, "c.txt"), "c\n");
  await writeFile(join(repo, ".gitignore"), "dist/\n");
  await sh("add", "-A");
  await sh("commit", "-qm", "init");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("workspace git", () => {
  test("committing some paths leaves the rest, including what's staged, out of the commit", async () => {
    await writeFile(join(repo, "a.txt"), "a2\n");
    await writeFile(join(repo, "b.txt"), "b2\n");
    await writeFile(join(repo, "new.txt"), "new\n");
    await sh("mv", "c.txt", "d.txt");
    const before = await changes(repo);
    expect(before.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(["? new.txt", "M a.txt", "M b.txt", "R d.txt"]);

    await commit(repo, "Only a and new", ["a.txt", "new.txt"]);
    expect((await sh("show", "--name-only", "--format=", "HEAD")).split("\n").sort()).toEqual(["a.txt", "new.txt"]);
    const after = await changes(repo);
    expect(after.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(["M b.txt", "R d.txt"]);
    // The rename someone staged by hand is still staged.
    expect(after.files.find((f) => f.path === "d.txt")?.staged).toBe(true);
  });

  test("paths can't climb out of the repository", async () => {
    await expect(commit(repo, "nope", ["../outside"])).rejects.toThrow("inside the repository");
    await expect(commit(repo, "  ", ["b.txt"])).rejects.toThrow("needs a message");
  });

  test("the tree marks ignored and changed entries", async () => {
    await Bun.write(join(repo, "dist/out.js"), "x");
    const entries = await listDir(repo, "");
    expect(entries.find((e) => e.name === "dist")).toMatchObject({ dir: true, ignored: true });
    expect(entries.find((e) => e.name === "b.txt")?.git).toBe("M");
    expect(entries.some((e) => e.name === ".git")).toBe(false);
  });

  test("a save doesn't overwrite a change made on disk since the file was read", async () => {
    const read = readFile(repo, "b.txt");
    saveFile(repo, "b.txt", "mine\n", read.mtime);
    await Bun.sleep(5);
    await writeFile(join(repo, "b.txt"), "theirs\n");
    expect(() => saveFile(repo, "b.txt", "mine again\n", read.mtime)).toThrow("changed on disk");
    // Without the mtime (the user chose to overwrite), it saves.
    saveFile(repo, "b.txt", "mine again\n");
    expect(readFile(repo, "b.txt").text).toBe("mine again\n");
  });
});

const tool = (name: string, path: string) => ({ type: "tool" as const, id: crypto.randomUUID(), name, args: { path }, status: "done" as const });
const chat = (id: string, cwd: string, paths: [string, string][], worktree = false): Chat => ({
  id,
  title: id,
  createdAt: 0,
  updatedAt: 0,
  workspace: { projectId: "p", projectName: "p", cwd, worktree },
  messages: [{ id: `${id}-a`, role: "assistant", content: "", createdAt: 0, parts: paths.map(([name, path]) => tool(name, path)) }],
});

describe("which changes are a thread's", () => {
  const changed: GitChanges = {
    repo: true,
    root: "/repo",
    prefix: "app/",
    files: [
      { path: "app/src/a.ts", status: "M" },
      { path: "app/b.ts", status: "?" },
      { path: "app/new.ts", status: "R", from: "app/old.ts" },
      { path: "README.md", status: "M" },
    ],
  };

  test("edit and write paths, relative or absolute, map to the repository's paths", () => {
    const c = chat("t1", "/repo/app", [["edit", "src/a.ts"], ["write", "/repo/app/b.ts"], ["read", "README.md"], ["edit", "./x/../c.ts"]]);
    expect([...threadFiles(c, "/repo", "app/")].sort()).toEqual(["app/b.ts", "app/c.ts", "app/src/a.ts"]);
  });

  test("a thread's files, the ones other threads in the checkout share, and renames bring their old path", () => {
    const mine = chat("t1", "/repo/app", [["edit", "src/a.ts"], ["edit", "old.ts"]]);
    const other = chat("t2", "/repo/app", [["edit", "src/a.ts"]]);
    const elsewhere = chat("t3", "/repo/wt", [["edit", "b.ts"]]);
    const scope = commitScope(mine, changed, [mine, other, elsewhere]);
    expect(scope.mine.map((f) => f.path)).toEqual(["app/src/a.ts", "app/new.ts"]);
    expect(scope.shared).toEqual([{ path: "app/src/a.ts", threads: ["t2"] }]);
    expect(scope.separable).toBe(true);
    expect(commitPaths(scope.mine)).toEqual(["app/src/a.ts", "app/new.ts", "app/old.ts"]);
  });

  test("a thread in its own worktree commits everything", () => {
    const wt = chat("t1", "/repo/app", [["edit", "src/a.ts"]], true);
    expect(commitScope(wt, changed, [wt]).separable).toBe(false);
  });
});
