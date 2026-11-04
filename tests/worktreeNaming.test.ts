import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameTemporaryBranch, temporaryWorktreeBranch } from "../server/worktreeNaming";

let root: string;
let cwd: string;
const git = async (dir: string, ...args: string[]) => {
  const p = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code) throw new Error(err);
  return out.trim();
};
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ob-naming-"));
  await git(root, "init", "-b", "main");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init");
  cwd = join(root, "checkout");
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

async function fresh() {
  if (await Bun.file(join(cwd, ".git")).exists()) await git(root, "worktree", "remove", "--force", cwd);
  const branch = temporaryWorktreeBranch();
  await git(root, "worktree", "add", "-b", branch, cwd);
  return branch;
}

test("renames once without moving the checkout or losing uncommitted files", async () => {
  const branch = await fresh();
  await Bun.write(join(cwd, "working.txt"), "in progress");
  expect(await renameTemporaryBranch(cwd, branch, "improve-naming")).toBe("openbuild/improve-naming");
  expect(await Bun.file(join(cwd, "working.txt")).text()).toBe("in progress");
  expect(await git(cwd, "branch", "--show-current")).toBe("openbuild/improve-naming");
  expect(await renameTemporaryBranch(cwd, branch, "another-name")).toBeNull();
});

test("collisions and invalid names preserve the temporary branch", async () => {
  const branch = await fresh();
  expect(await renameTemporaryBranch(cwd, branch, "improve-naming")).toBeNull();
  for (const name of ["../bad", "UPPER", "a\nb", "", "x".repeat(49)])
    expect(await renameTemporaryBranch(cwd, branch, name)).toBeNull();
  expect(await git(cwd, "branch", "--show-current")).toBe(branch);
});

test("leaves manually switched and published branches alone", async () => {
  const branch = await fresh();
  await git(cwd, "switch", "-c", "manual");
  expect(await renameTemporaryBranch(cwd, branch, "leave-manual")).toBeNull();
  await git(cwd, "switch", branch);
  await git(cwd, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
  expect(await renameTemporaryBranch(cwd, branch, "leave-published")).toBeNull();
});
