// The new-thread branch picker's choices: which ref a new thread starts from (or switches to), and
// the order the picker lists them in.
import type { GitInfo } from "../../shared/types";

export interface BranchRow {
  /** A branch, or the commit a detached checkout is at. */
  name: string;
  commit?: boolean;
  current?: boolean;
  default?: boolean;
  /** Checked out in another worktree. */
  worktree?: boolean;
  /** Listed above the rest: the default branch, and the current one. */
  pinned?: boolean;
}

/**
 * What a thread starts from when no branch was picked: the current branch, or for a worktree from a
 * checkout detached at a commit, the default branch (the commit itself when there's none).
 */
export function defaultRef(info: GitInfo | undefined, mode: "local" | "worktree"): string | undefined {
  if (!info) return undefined;
  if (info.branch) return info.branch;
  return (mode === "worktree" ? info.defaultBranch : undefined) ?? info.head;
}

/** The picked ref, while it's still there to start from; else the default. */
export function pickedRef(info: GitInfo | undefined, mode: "local" | "worktree", picked?: string): string | undefined {
  if (picked && info && (info.branches.includes(picked) || picked === info.head)) return picked;
  return defaultRef(info, mode);
}

/**
 * The picker's rows: the default branch, then the current branch (or the commit a detached checkout
 * is at), then every other branch, most recently committed first. A `query` keeps the rows whose
 * names have each of its words.
 */
export function branchRows(info: GitInfo | undefined, query = ""): BranchRow[] {
  if (!info) return [];
  const current = info.branch ?? info.head;
  const pinned = [...new Set([info.defaultBranch, current].filter((b): b is string => !!b))];
  const rest = info.branches.filter((b) => !pinned.includes(b));
  const worktrees = new Set(info.worktrees ?? []);
  const rows = [...pinned, ...rest].map((name): BranchRow => ({
    name,
    ...(name === info.head && !info.branches.includes(name) ? { commit: true } : {}),
    ...(name === current ? { current: true } : {}),
    ...(name === info.defaultBranch ? { default: true } : {}),
    ...(worktrees.has(name) ? { worktree: true } : {}),
    ...(pinned.includes(name) ? { pinned: true } : {}),
  }));
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? rows.filter((r) => words.every((w) => r.name.toLowerCase().includes(w))) : rows;
}
