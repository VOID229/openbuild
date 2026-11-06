// Pull request numbers ("#74") in OpenBots messages, as links to the pull request on GitHub.
// OpenBots has no pull requests tab, so these always open GitHub, unlike a thread's PR links.
import type { ThreadPullRequest } from "../../../shared/types";

/** A "#74" that isn't part of a word, an address or a heading marker ("##"). */
export const PULL_REF_RE = /(?<![\w&/#-])#(\d{1,6})\b(?![-\w])/g;

/**
 * Where "#n" goes, from the pull requests the threads opened: the thread's own pull request with
 * that number, else (when every known pull request is in one repository) that repository's
 * pull request, if the number isn't past the newest one seen there. Anything else stays text.
 */
export function pullRefUrl(number: number, pulls: Pick<ThreadPullRequest, "number" | "url">[]): string | undefined {
  const exact = new Set(pulls.filter((p) => p.number === number).map((p) => p.url));
  if (exact.size === 1) return [...exact][0];
  if (exact.size > 1) return;
  const repos = new Set(pulls.map((p) => repoOf(p.url)).filter(Boolean));
  if (repos.size !== 1) return;
  if (number > Math.max(...pulls.map((p) => p.number))) return;
  return `${[...repos][0]}/pull/${number}`;
}

/** `https://github.com/o/r/pull/12` → `https://github.com/o/r`. */
const repoOf = (url: string) => /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(url)?.[1];
