// Follows threads' pull requests, and closes a thread once its pull request merges ("Close threads
// when their PR merges" in Settings › Workspace, on by default). While some open thread has one to
// follow, GitHub is asked about each repository's recent pull requests with one `gh pr list`: every
// 15 seconds while something is about to change (a followed thread is working, so it may push or open
// one, or a pull request's checks are running), once a minute otherwise. The pull requests tab's
// reads count too (`heardPullRequests`): what it shows, the sidebar shows, without waiting for a sweep. A thread is matched to the one from its worktree's branch, or to one its agent opened
// wherever it worked (a thread in the project's own checkout, say). The chat keeps what was found
// (`pullRequest`), so the sidebar and thread header can show it.
//
// A merge closes the thread only when it came after the thread's last user message (so a thread that
// kept going after the merge stays open), and never while it's working, pinned, snoozed or was
// reopened after an earlier auto-close. A day later its worktree is removed (closedWorktrees.ts) when
// nothing would be lost: no uncommitted changes, HEAD is the commit GitHub merged, and no other open thread works there.
// Only OpenBuild's own worktrees are ever removed.
import { existsSync } from "node:fs";
import type { ThreadPullRequest } from "../shared/types";
import type { Chat } from "../src/lib/types";
import { managedSessionBoundary } from "./pi/projection";
import { findProject } from "./projects";
import * as storage from "./storage";
import { gh, run } from "./workspaceGit";

const SWEEP_EVERY = 60_000;
/** While a followed pull request is in flux: about two GraphQL points per repository per sweep. */
const SWEEP_HOT = 15_000;
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
    ...(pr.headRefOid ? { head: pr.headRefOid } : {}),
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
  if (chat.archived || chat.pinned || chat.autoCloseOptOut) return false;
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

async function currentBranch(cwd: string): Promise<{ branch?: string } | undefined> {
  if (!existsSync(cwd)) return undefined;
  const branch = await run(["git", "branch", "--show-current"], cwd, 10_000);
  if (branch.code !== 0) return undefined;
  return { branch: branch.out || undefined };
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

let sweeping: Promise<void> | undefined;
let queued: Promise<void> | undefined;

/**
 * Look up every open thread's pull request, saving what changed and closing merged threads. `refresh`
 * brings finished replies up to date first: with no browser polling, they'd still look like working.
 * `fresh` is for just after a pull request changed: a sweep already under way may have asked GitHub
 * before it did, so another one follows it.
 */
export function sweep(refresh?: () => Promise<void>, fresh = false): Promise<void> {
  if (fresh && sweeping) return (queued ??= sweeping.then(() => { queued = undefined; return sweep(refresh); }));
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
    const asked = Date.now();
    const prs = await listPullRequests(repo);
    if (!prs) continue;
    for (const summary of chats) {
      // Only a worktree's branch is the thread's own: threads share a project's checkout and its branch.
      const local = summary.workspace?.worktree ? await currentBranch(summary.workspace.cwd) : undefined;
      // An agent may have switched the worktree to a branch of its own.
      const branch = summary.workspace?.worktree ? local?.branch ?? summary.workspace.branch : undefined;
      const found = pickPullRequest(prs, branch, summary.createdAt, summary.openedPullRequests);
      if (!found) continue;
      save(summary.id, () => toThreadPullRequest(found, asked), closeMerged);
    }
  }
}

/** The fields that change what a thread shows (or what its worktree's removal checks). */
const differs = (a: ThreadPullRequest | undefined, b: ThreadPullRequest) =>
  !a || a.number !== b.number || a.state !== b.state || a.checks !== b.checks || a.draft !== b.draft || a.head !== b.head || a.mergedAt !== b.mergedAt;

/**
 * Save what's now known about thread `id`'s pull request, closing the thread if it merged. Read and
 * written without yielding, so nothing saved in between is lost. An answer GitHub gave before the one
 * already saved is older news (a sweep and the tab can ask at once), and is dropped. Returns whether
 * it saved.
 */
function save(id: string, next: (before: ThreadPullRequest | undefined) => ThreadPullRequest | undefined, closeMerged: boolean): boolean {
  const stored = storage.getChat(id) as Chat | undefined;
  if (!stored || stored.archived) return false;
  const before = stored.pullRequest;
  const pr = next(before);
  if (!pr || (before && before.checkedAt > pr.checkedAt)) return false;
  const now = Date.now();
  const close = closeMerged && shouldClose(stored, pr, now);
  if (!differs(before, pr) && !close) return false;
  storage.putChat({
    ...stored,
    pullRequest: pr,
    ...(close ? { archived: true, done: false, woke: false, autoClosedAt: now } : {}),
  } as unknown as storage.StoredChat);
  // Its worktree goes a day later, if nothing in it would be lost (closedWorktrees.ts).
  if (close) console.log(`[pull-requests] Closed "${stored.title}": #${pr.number} merged`);
  return true;
}

/** A pull request as the pull requests tab read it (server/pullRequestView.ts). */
export interface HeardPullRequest {
  url: string;
  state: ThreadPullRequest["state"];
  draft?: boolean;
  checks?: ThreadPullRequest["checks"];
  mergedAt?: number;
  head?: string;
}

/**
 * The pull requests tab asked GitHub about these at `asked`: threads already following one take it at
 * once, so the sidebar never shows older news than the tab. A merge is left to a sweep, which knows
 * when it happened and whether to close the thread.
 */
export function heardPullRequests(heard: HeardPullRequest[], asked: number) {
  if (!heard.length) return;
  const byUrl = new Map(heard.map((pr) => [pr.url, pr]));
  let merged = false;
  for (const summary of storage.pullRequestChatSummaries()) {
    if (summary.archived || summary.workspace?.deviceId || !summary.pullRequest) continue;
    const pr = byUrl.get(summary.pullRequest.url);
    if (!pr) continue;
    if (pr.state === "merged" && summary.pullRequest.state !== "merged") {
      merged = true;
      continue;
    }
    save(summary.id, (before) => {
      if (!before || before.url !== pr.url) return undefined;
      const { draft: _d, checks: _c, ...rest } = before;
      return {
        ...rest,
        state: pr.state,
        ...(pr.draft ? { draft: true } : {}),
        ...(pr.checks ? { checks: pr.checks } : {}),
        ...(pr.mergedAt !== undefined ? { mergedAt: pr.mergedAt } : {}),
        ...(pr.head ? { head: pr.head } : {}),
        checkedAt: asked,
      };
    }, false);
  }
  if (merged) void sweep(undefined, true);
}

/** Whether a followed pull request may change soon: its checks are running, or its thread is working. */
export function inFlux(chats: Chat[]): boolean {
  return chats.some((c) => !c.archived && !c.workspace?.deviceId && ((c.pullRequest?.state === "open" && c.pullRequest.checks === "pending") || working(c)));
}

const hot = globalThis as { openbuildPullRequestTimer?: ReturnType<typeof setTimeout> };

/** Start sweeping: soon after starting, then every 15 seconds or every minute (once, even under `bun --hot`). */
export function startPullRequestSweep(refresh: () => Promise<void>) {
  if (hot.openbuildPullRequestTimer) clearTimeout(hot.openbuildPullRequestTimer);
  const next = (delay: number) => {
    hot.openbuildPullRequestTimer = setTimeout(async () => {
      await sweep(refresh);
      next(inFlux(storage.pullRequestChatSummaries()) ? SWEEP_HOT : SWEEP_EVERY);
    }, delay);
  };
  next(10_000);
}
