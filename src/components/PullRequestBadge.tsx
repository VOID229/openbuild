import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { ThreadPullRequest } from "../../shared/types";

/** What the badge says about a pull request: its state, and its checks while it's open. */
export function pullRequestLabel(pr: ThreadPullRequest): string {
  if (pr.state === "merged") return `#${pr.number} merged`;
  if (pr.state === "closed") return `#${pr.number} closed`;
  const checks = pr.checks === "failing" ? ", checks failing" : pr.checks === "pending" ? ", checks running" : pr.checks === "passing" ? ", checks passed" : "";
  return `#${pr.number} ${pr.draft ? "draft" : "open"}${checks}`;
}

/** A thread's pull request (server/pullRequests.ts): a link to it on GitHub, or just its number when compact. */
export function PullRequestBadge({ pr, size = 13, compact }: { pr: ThreadPullRequest; size?: number; compact?: boolean }) {
  const Icon = pr.state === "merged" ? GitMerge : pr.state === "closed" ? GitPullRequestClosed : pr.draft ? GitPullRequestDraft : GitPullRequest;
  const tone = pr.state === "open" ? (pr.checks ?? "open") : pr.state;
  const content = (
    <>
      <Icon size={size} />
      <span>{compact ? `#${pr.number}` : pullRequestLabel(pr)}</span>
    </>
  );
  const title = `Pull request ${pullRequestLabel(pr)}`;
  // A sidebar row is already a button, so its compact badge can't be a link of its own.
  if (compact) return <span className={`pr-badge pr-${tone}`} title={title}>{content}</span>;
  return (
    <a className={`pr-badge pr-${tone}`} href={pr.url} target="_blank" rel="noreferrer" title={title}>
      {content}
    </a>
  );
}
