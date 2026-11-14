// A closed thread keeps its worktree for a day, in case it's reopened, and then a sweep removes it:
// - with "Delete worktrees of closed threads" on, any closed thread's;
// - one its pull request's merge closed, even with it off, when nothing would be lost: HEAD is still
//   the commit GitHub merged (so its branch can go too).
// Never forced: uncommitted work stays, and so does a worktree an open thread still works in.
// A thread deleted by hand takes its worktree with it straight away (removeDeletedThreadWorktree).
import { existsSync } from "node:fs";
import type { Chat } from "../src/lib/types";
import { removeWorktree } from "./projects";
import * as storage from "./storage";
import { run } from "./workspaceGit";

/** How long a closed thread keeps its worktree. */
export const KEEP_FOR = 24 * 60 * 60 * 1000;
const SWEEP_EVERY = 60 * 60 * 1000;

/** Removes a worktree on a paired device. */
export type RemoteRemove = (deviceId: string, cwd: string) => Promise<void>;

/** When the thread was closed, if it's closed and we know. Threads closed before this was recorded have no time. */
export const closedSince = (chat: Chat): number | undefined => (chat.archived ? (chat.closedAt ?? chat.autoClosedAt) : undefined);

function enabled(): boolean {
  try {
    return JSON.parse(storage.getValue("client-state") ?? "{}")?.state?.settings?.autoDeleteWorktrees === true;
  } catch {
    return false;
  }
}

/** Closed because its pull request merged (a bot's close also stamps autoClosedAt, but not a merge). */
const mergeClosed = (chat: Chat) => !!chat.autoClosedAt && chat.pullRequest?.state === "merged" && !!chat.pullRequest.head;

/** A merged thread's worktree still at the commit GitHub merged. */
async function atMergedHead(chat: Chat): Promise<boolean> {
  const head = await run(["git", "rev-parse", "HEAD"], chat.workspace!.cwd, 10_000);
  return head.code === 0 && head.out === chat.pullRequest?.head;
}

/** The worktrees due for removal: closed over a day ago, and no open thread working in them. */
export function due(chats: Chat[], now = Date.now()): Chat[] {
  const inUse = new Set(chats.filter((c) => !c.archived && c.workspace?.worktree).map((c) => `${c.workspace!.deviceId ?? ""}\0${c.workspace!.cwd}`));
  const seen = new Set<string>();
  return chats.filter((c) => {
    const ws = c.workspace;
    const since = closedSince(c);
    if (!ws?.worktree || since === undefined || now - since < KEEP_FOR) return false;
    const key = `${ws.deviceId ?? ""}\0${ws.cwd}`;
    if (inUse.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Per process: worktrees already removed (a paired device's can't be checked locally) and ones kept, logged once.
const removed = new Set<string>();
const kept = new Set<string>();

export async function sweepClosedWorktrees(removeRemote?: RemoteRemove, now = Date.now()): Promise<void> {
  const all = enabled();
  for (const chat of due(storage.pullRequestChatSummaries(), now)) {
    if (!all && !mergeClosed(chat)) continue;
    const { cwd, deviceId } = chat.workspace!;
    const key = `${deviceId ?? ""}\0${cwd}`;
    if (removed.has(key)) continue;
    if (!deviceId && !existsSync(cwd)) {
      removed.add(key);
      continue;
    }
    if (deviceId && !removeRemote) continue;
    try {
      // A squash merge leaves the branch's commits off the base: only a branch still at the merged commit is deleted by force.
      const merged = !deviceId && mergeClosed(chat) && (await atMergedHead(chat));
      if (!all && !merged) continue;
      await (deviceId ? removeRemote!(deviceId, cwd) : removeWorktree(cwd, false, merged));
      removed.add(key);
      console.log(`[worktrees] Removed the worktree of "${chat.title}", closed over a day ago`);
    } catch (err) {
      if (!kept.has(key)) console.warn(`[worktrees] Kept the worktree ${cwd}: ${(err as Error).message}`);
      kept.add(key);
    }
  }
}

/**
 * Remove the worktree of a thread that's being deleted, right away: nothing would bring the thread
 * back to it. Called before the thread is deleted, with it still stored. Not forced, so uncommitted
 * work stays, and neither is a worktree another open thread works in.
 */
export async function removeDeletedThreadWorktree(id: string, removeRemote?: RemoteRemove): Promise<void> {
  const chat = storage.getChat(id) as Chat | undefined;
  const ws = chat?.workspace;
  if (!ws?.worktree) return;
  const key = `${ws.deviceId ?? ""}\0${ws.cwd}`;
  const inUse = storage.pullRequestChatSummaries().some((c) => c.id !== id && !c.archived && c.workspace?.worktree && `${c.workspace.deviceId ?? ""}\0${c.workspace.cwd}` === key);
  if (inUse || removed.has(key)) return;
  if (ws.deviceId && !removeRemote) return;
  try {
    await (ws.deviceId ? removeRemote!(ws.deviceId, ws.cwd) : removeWorktree(ws.cwd));
    removed.add(key);
    console.log(`[worktrees] Removed the worktree of "${chat!.title}", deleted`);
  } catch (err) {
    console.warn(`[worktrees] Kept the worktree ${ws.cwd} of a deleted thread: ${(err as Error).message}`);
  }
}

const hot = globalThis as { openbuildClosedWorktreeTimer?: ReturnType<typeof setInterval> };

/** Start the hourly sweep (once, even under `bun --hot`). */
export function startClosedWorktreeSweep(removeRemote: RemoteRemove) {
  const run = () => void sweepClosedWorktrees(removeRemote).catch((err) => console.error("[worktrees] Sweep failed:", err));
  if (hot.openbuildClosedWorktreeTimer) clearInterval(hot.openbuildClosedWorktreeTimer);
  hot.openbuildClosedWorktreeTimer = setInterval(run, SWEEP_EVERY);
  setTimeout(run, 60_000);
}
