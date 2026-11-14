// The new-thread branch picker (src/lib/branches.ts): on a checkout with dozens of leftover thread
// branches, the default and current branches come first, search narrows the rest, and a worktree
// from a checkout detached at a commit starts from the default branch.
import { expect, test } from "bun:test";
import type { GitInfo } from "../shared/types";
import { branchRows, defaultRef, pickedRef } from "../src/lib/branches";

// Like a long-lived checkout: 67 thread branches and a few others committed to since main, which
// sorts 65th by date. HEAD is detached at a commit.
const threads = Array.from({ length: 67 }, (_, i) => `openbuild/thread-${67 - i}`);
const branches = [...threads.slice(0, 40), "fix-login", "add-search", "tidy-sidebar", ...threads.slice(40, 61), "main", ...threads.slice(61), "release-1.2"];
const detached: GitInfo = { head: "b59f256", branches, defaultBranch: "main", worktrees: ["add-search", "openbuild/thread-3"], remote: true, dirty: 0 };

test("the default branch and the checkout's commit are pinned above the rest, which keep their order", () => {
  expect(branches.indexOf("main")).toBe(64);
  const rows = branchRows(detached);
  expect(rows.slice(0, 2)).toEqual([
    { name: "main", default: true, pinned: true },
    { name: "b59f256", commit: true, current: true, pinned: true },
  ]);
  expect(rows.slice(2).map((r) => r.name)).toEqual(branches.filter((b) => b !== "main"));
  expect(rows.filter((r) => r.pinned).length).toBe(2);
});

test("on another branch, the current one is pinned under the default; on the default, it's pinned once", () => {
  const onFix = branchRows({ ...detached, head: undefined, branch: "fix-login" });
  expect(onFix.slice(0, 3).map((r) => [r.name, !!r.pinned, !!r.current])).toEqual([["main", true, false], ["fix-login", true, true], ["openbuild/thread-67", false, false]]);
  const onMain = branchRows({ ...detached, head: undefined, branch: "main" });
  expect(onMain[0]).toEqual({ name: "main", default: true, current: true, pinned: true });
  expect(onMain.filter((r) => r.name === "main").length).toBe(1);
  expect(onMain[1]!.pinned).toBeUndefined();
});

test("branches checked out in another worktree are tagged", () => {
  const tagged = branchRows(detached).filter((r) => r.worktree).map((r) => r.name);
  expect(tagged).toEqual(["add-search", "openbuild/thread-3"]);
});

test("search keeps the refs whose names have every word, pinned ones still first", () => {
  expect(branchRows(detached, "SEARCH").map((r) => r.name)).toEqual(["add-search"]);
  expect(branchRows(detached, "thread-6").map((r) => r.name)).toEqual([7, 6, 5, 4, 3, 2, 1, 0, ""].map((n) => `openbuild/thread-6${n}`));
  expect(branchRows(detached, "67 open").map((r) => r.name)).toEqual(["openbuild/thread-67"]);
  expect(branchRows(detached, "i").slice(0, 2).map((r) => r.name)).toEqual(["main", "openbuild/thread-67"]);
  expect(branchRows(detached, "  ")).toEqual(branchRows(detached));
  expect(branchRows(detached, "nothing-like-it")).toEqual([]);
  expect(branchRows(undefined, "main")).toEqual([]);
});

test("a worktree from a detached checkout starts from the default branch; a local checkout stays on its commit", () => {
  expect(defaultRef(detached, "worktree")).toBe("main");
  expect(pickedRef(detached, "worktree")).toBe("main");
  expect(defaultRef(detached, "local")).toBe("b59f256");
  // No default branch to go to: the commit.
  expect(defaultRef({ ...detached, defaultBranch: undefined }, "worktree")).toBe("b59f256");
  // On a named branch, that branch, as before.
  expect(defaultRef({ ...detached, head: undefined, branch: "fix-login" }, "worktree")).toBe("fix-login");
});

test("a pick that's gone falls back to the default; the detached commit can still be picked", () => {
  expect(pickedRef(detached, "worktree", "tidy-sidebar")).toBe("tidy-sidebar");
  expect(pickedRef(detached, "worktree", "b59f256")).toBe("b59f256");
  expect(pickedRef(detached, "worktree", "deleted-branch")).toBe("main");
  expect(pickedRef({ ...detached, head: "0000000" }, "worktree", "b59f256")).toBe("main");
});
