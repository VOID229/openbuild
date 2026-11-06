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
