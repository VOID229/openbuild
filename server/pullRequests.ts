// Follows threads' pull requests, and closes a thread once its pull request merges ("Close threads
// when their PR merges" in Settings › Workspace, on by default). Once a minute, while some open thread
// has one to follow, GitHub is asked about each repository's recent pull requests with one
// `gh pr list`. A thread is matched to the one from its worktree's branch, or to one its agent opened
// wherever it worked (a thread in the project's own checkout, say). The chat keeps what was found
// (`pullRequest`), so the sidebar and thread header can show it.
//
// A merge closes the thread only when it came after the thread's last user message (so a thread that
// kept going after the merge stays open), and never while it's working, pinned, snoozed or was
// reopened after an earlier auto-close. Its worktree is then removed when nothing would be lost:
// no uncommitted changes, HEAD is the commit GitHub merged, and no other open thread works there.
// Only OpenBuild's own worktrees are ever removed.
import { existsSync } from "node:fs";
import type { ThreadPullRequest } from "../shared/types";
import type { Chat } from "../src/lib/types";
import { managedSessionBoundary } from "./pi/projection";
import { findProject, removeWorktree } from "./projects";
import * as storage from "./storage";
import { gh, run } from "./workspaceGit";

const SWEEP_EVERY = 60_000;
/** Recent pull requests asked for per repository: open threads' branches are among the newest. */
const LIST_LIMIT = 100;

/** A pull request as `gh pr list --json` reports it. */
export interface GhPullRequest {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
  headRefName: string;
  headRefOid?: string;
  createdAt: string;
  mergedAt?: string | null;
  statusCheckRollup?: { __typename?: string; status?: string; conclusion?: string | null; state?: string }[] | null;
}

export const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

/** One word for a pull request's checks: any failure fails them, anything unfinished keeps them pending. */
export function checksOf(rollup: GhPullRequest["statusCheckRollup"]): ThreadPullRequest["checks"] {
  if (!rollup?.length) return undefined;
  let pending = false;
  for (const check of rollup) {
    // Check runs carry status and conclusion; commit statuses carry a single state.
    const result = check.conclusion || check.state;
    if (result && FAILED.has(result)) return "failing";
    if ((check.status && check.status !== "COMPLETED") || result === "PENDING" || result === "EXPECTED") pending = true;
  }
  return pending ? "pending" : "passing";
}

/**
 * This thread's pull request: one from its branch opened after the thread started (a reused branch
 * name mustn't inherit an old one), or one it opened itself, preferring an open one, else the newest.
 */
export function pickPullRequest(prs: GhPullRequest[], branch: string | undefined, since: number, opened: string[] = []): GhPullRequest | undefined {
  const mine = prs.filter((pr) => (pr.headRefName === branch && Date.parse(pr.createdAt) >= since) || opened.includes(pr.url));
  return mine.find((pr) => pr.state === "OPEN") ?? mine.sort((a, b) => b.number - a.number)[0];
}

export function toThreadPullRequest(pr: GhPullRequest, checkedAt: number): ThreadPullRequest {
  const mergedAt = pr.mergedAt ? Date.parse(pr.mergedAt) : NaN;
  const checks = checksOf(pr.statusCheckRollup);
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
    ...(pr.isDraft ? { draft: true } : {}),
    ...(checks ? { checks } : {}),
    ...(Number.isFinite(mergedAt) ? { mergedAt } : {}),
    checkedAt,
  };
}

/** A reply is still running, or waiting on an answer. */
const working = (chat: Chat) => {
  const last = chat.messages.findLast((m) => m.role === "assistant");
  return last?.status === "streaming" || managedSessionBoundary(chat.id) === Infinity;
};

/** Whether this thread should be closed now that its pull request is `pr`. */
export function shouldClose(chat: Chat, pr: ThreadPullRequest, now: number): boolean {
  if (pr.state !== "merged" || pr.mergedAt === undefined) return false;
  if (chat.archived || chat.pinned || chat.autoCloseOptOut || chat.autoClosedAt) return false;
  if (chat.snoozedUntil !== undefined && chat.snoozedUntil > now) return false;
  if (working(chat)) return false;
  // Talking to the thread after the merge means it's still in use.
  const lastAsked = chat.messages.findLast((m) => m.role === "user")?.createdAt ?? chat.createdAt;
  return pr.mergedAt >= Math.max(lastAsked, chat.createdAt);
}

/** Merged threads are closed unless the user turned it off (client settings are one JSON document). */
function closeMergedEnabled(): boolean {
  try {
    const raw = storage.getValue("client-state");
    if (!raw) return true;
    const parsed = JSON.parse(raw);
    return parsed?.state?.settings?.workspace?.closeMerged !== false;
  } catch {
    return true;
  }
}

/**
 * Keep the server's pull request fields through a browser's save: a tab that saved before it heard
 * about a merge mustn't drop the pull request or reopen the thread (unless the user acted on it).
 */
export function keepPullRequestFields(chat: Chat, stored: Chat | undefined): Chat {
  if (!stored) return chat;
  let next = chat;
  if (stored.pullRequest && (chat.pullRequest?.checkedAt ?? 0) < stored.pullRequest.checkedAt) next = { ...next, pullRequest: stored.pullRequest };
  const stale = !chat.autoClosedAt && !chat.autoCloseOptOut && chat.messages.length === stored.messages.length;
  if (stored.autoClosedAt && stale) next = { ...next, archived: stored.archived, done: stored.done, woke: stored.woke, autoClosedAt: stored.autoClosedAt };
  return next;
}

async function currentBranch(cwd: string): Promise<{ branch?: string; head?: string; dirty: boolean } | undefined> {
  if (!existsSync(cwd)) return undefined;
  const [branch, head, status] = await Promise.all([
    run(["git", "branch", "--show-current"], cwd, 10_000),
    run(["git", "rev-parse", "HEAD"], cwd, 10_000),
    run(["git", "status", "--porcelain"], cwd, 30_000),
  ]);
  if (branch.code !== 0) return undefined;
  return { branch: branch.out || undefined, head: head.code === 0 ? head.out : undefined, dirty: status.code !== 0 || !!status.out };
}

async function listPullRequests(repo: string): Promise<GhPullRequest[] | undefined> {
  const bin = gh();
  if (!bin) return undefined;
  const r = await run(
    [bin, "pr", "list", "--state", "all", "--limit", String(LIST_LIMIT), "--json", "number,url,state,isDraft,headRefName,headRefOid,createdAt,mergedAt,statusCheckRollup"],
    repo,
    60_000,
  );
  if (r.code !== 0) {
    console.warn(`[pull-requests] gh pr list failed in ${repo}: ${r.err || r.out}`);
    return undefined;
  }
  try {
    return JSON.parse(r.out) as GhPullRequest[];
  } catch {
    return undefined;
  }
}

/** Remove a closed thread's worktree when nothing in it would be lost. */
async function removeMergedWorktree(chat: Chat, pr: GhPullRequest, local: { head?: string; dirty: boolean } | undefined, open: Chat[]) {
  const cwd = chat.workspace?.cwd;
  if (!cwd || !local || local.dirty || !pr.headRefOid || local.head !== pr.headRefOid) return;
  if (open.some((other) => other.id !== chat.id && other.workspace?.cwd === cwd)) return;
  try {
    await removeWorktree(cwd, false, true);
  } catch (err) {
    console.warn(`[pull-requests] Kept the worktree ${cwd}: ${(err as Error).message}`);
  }
}

let sweeping: Promise<void> | undefined;

/**
 * Look up every open thread's pull request, saving what changed and closing merged threads. `refresh`
 * brings finished replies up to date first: with no browser polling, they'd still look like working.
 */
export function sweep(refresh?: () => Promise<void>): Promise<void> {
  return (sweeping ??= sweepOnce(refresh).catch((err) => console.error("[pull-requests] Sweep failed:", err)).finally(() => { sweeping = undefined; }));
}

async function sweepOnce(refresh?: () => Promise<void>) {
  // Paired devices follow their own threads; this server only knows its own checkouts.
  const following = () => storage.pullRequestChatSummaries().filter((c) => !c.archived && !c.workspace?.deviceId);
  if (!following().length || !gh()) return;
  await refresh?.();
  const open = following();
  const byRepo = new Map<string, Chat[]>();
  for (const chat of open) {
    const projectId = chat.workspace?.projectId;
    const repo = projectId && findProject(projectId)?.path;
    if (!repo || !existsSync(repo)) continue;
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), chat]);
  }
  const closeMerged = closeMergedEnabled();
  for (const [repo, chats] of byRepo) {
    const prs = await listPullRequests(repo);
    if (!prs) continue;
    for (const summary of chats) {
      // Only a worktree's branch is the thread's own: threads share a project's checkout and its branch.
      const local = summary.workspace?.worktree ? await currentBranch(summary.workspace.cwd) : undefined;
      // An agent may have switched the worktree to a branch of its own.
      const branch = summary.workspace?.worktree ? local?.branch ?? summary.workspace.branch : undefined;
      const found = pickPullRequest(prs, branch, summary.createdAt, summary.openedPullRequests);
      if (!found) continue;
      const now = Date.now();
      const pr = toThreadPullRequest(found, now);
      const stored = storage.getChat(summary.id) as Chat | undefined;
      if (!stored || stored.archived) continue;
      const close = closeMerged && shouldClose(stored, pr, now);
      const before = stored.pullRequest;
      const changed = !before || before.number !== pr.number || before.state !== pr.state || before.checks !== pr.checks || before.draft !== pr.draft;
      if (!changed && !close) continue;
      storage.putChat({
        ...stored,
        pullRequest: pr,
        ...(close ? { archived: true, done: false, woke: false, autoClosedAt: now } : {}),
      } as unknown as storage.StoredChat);
      if (close) {
        console.log(`[pull-requests] Closed "${stored.title}": #${pr.number} merged`);
        await removeMergedWorktree(stored, found, local, open);
      }
    }
  }
}

const hot = globalThis as { openbuildPullRequestTimer?: ReturnType<typeof setInterval> };

/** Start the once-a-minute sweep (once, even under `bun --hot`). */
export function startPullRequestSweep(refresh: () => Promise<void>) {
  if (hot.openbuildPullRequestTimer) clearInterval(hot.openbuildPullRequestTimer);
  hot.openbuildPullRequestTimer = setInterval(() => void sweep(refresh), SWEEP_EVERY);
  setTimeout(() => void sweep(refresh), 10_000);
}
