// Pull request numbers ("#74") in OpenBots messages, as links to the pull request on GitHub.
// OpenBots has no pull requests tab, so these always open GitHub, unlike a thread's PR links.
import type { ThreadPullRequest } from "../../../shared/types";

/** A "#74" that isn't part of a word, an address or a heading marker ("##"). */
export const PULL_REF_RE = /(?<![\w&/#-])#(\d{1,6})\b(?![-\w])/g;

/**
 * The pull request a thread opened with number `n`, when exactly one did. A number no thread opened,
 * or one that two repositories share, stays unlinked: nothing is guessed from the repositories seen.
 */
export function pullRefUrl(number: number, pulls: Pick<ThreadPullRequest, "number" | "url">[]): string | undefined {
  const exact = new Set(pulls.filter((p) => p.number === number).map((p) => p.url));
  return exact.size === 1 ? [...exact][0] : undefined;
}

// "PR #74", "pull request #74", "merged #74", "PRs #3, #4 and #5".
const PULL_BEFORE_RE = /\b(?:PRs?|pull requests?|merged|merging|opened|reopened|closed|reverted|landed)\s*(?:#\d+(?:\s*,\s*|\s*,?\s+(?:and|&|or)\s+))*$/i;
// "#74 is merged", "#74 was opened", "#74 has landed".
const PULL_AFTER_RE = /^\s+(?:(?:is|was|has|had|been|got|just|now|also)\s+)*(?:merged|opened|reopened|closed|reverted|landed)\b/i;

/**
 * Whether the "#n" at `start`..`end` of `text` is plainly a pull request from the words beside it.
 * A bare number ("GPT 6.1 Sol #2", "step #3") is a label, not a pull request, even when one exists.
 */
export function inPullContext(text: string, start: number, end: number): boolean {
  return PULL_BEFORE_RE.test(text.slice(Math.max(0, start - 80), start)) || PULL_AFTER_RE.test(text.slice(end, end + 40));
}

/** `https://github.com/O/R/pull/12` → `https://github.com/O/R`. */
const repoOfPull = (url: string) => /^(https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/pull\/\d+(?:[/?#]|$)/.exec(url)?.[1];

interface PullThread {
  pullRequest?: Pick<ThreadPullRequest, "url">;
  openedPullRequests?: string[];
  startedBy?: { bot: string; conversation: string };
}

/**
 * The repository a conversation's "#n" are in, from the pull requests threads opened: the threads
 * started in this conversation, else by its bots, else any. Two repositories at the nearest of
 * those that has any is undecided, and nothing is guessed.
 */
export function conversationRepo(conversation: { id: string; botIds: string[] }, chats: PullThread[]): string | undefined {
  const tiers = [chats.filter((c) => c.startedBy?.conversation === conversation.id), chats.filter((c) => c.startedBy && conversation.botIds.includes(c.startedBy.bot)), chats];
  for (const tier of tiers) {
    const repos = new Map<string, string>();
    for (const c of tier)
      for (const url of [c.pullRequest?.url, ...(c.openedPullRequests ?? [])]) {
        const repo = url ? repoOfPull(url) : undefined;
        if (repo) repos.set(repo.toLowerCase(), repo);
      }
    if (repos.size) return repos.size === 1 ? [...repos.values()][0] : undefined;
  }
}

// "color: #333", "fill=#123456": a colour, not a pull request.
const COLOUR_BEFORE_RE = /\b(?:colou?r|background|fill|stroke|border|hex)[\w-]*\s*[:=]?\s*$/i;

/**
 * Where the "#n" at `start`..`end` of `text` links, if anywhere. With the conversation's repository
 * known, any "#n" there; without it, only one a thread opened. A one-digit number ("Sol #2", "step #3")
 * or a six-digit one (a colour) needs PR wording beside it, and a colour's "#333" stays text.
 */
export function pullRefHref(text: string, start: number, end: number, number: number, known: { repo?: string; pulls: Pick<ThreadPullRequest, "number" | "url">[] }): string | undefined {
  if (COLOUR_BEFORE_RE.test(text.slice(Math.max(0, start - 40), start))) return;
  const digits = end - start - 1;
  if ((number < 10 || digits === 6) && !inPullContext(text, start, end)) return;
  if (!known.repo) return pullRefUrl(number, known.pulls);
  const base = known.repo.toLowerCase();
  return known.pulls.find((p) => p.number === number && repoOfPull(p.url)?.toLowerCase() === base)?.url ?? `${known.repo}/pull/${number}`;
}
