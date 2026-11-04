import { GitPullRequest } from "lucide-react";
import type { ThreadPullRequest } from "../../shared/types";

/** What the badge says about a pull request: its state, and its checks while it's open. */
export function pullRequestLabel(pr: ThreadPullRequest): string {
  if (pr.state === "merged") return `#${pr.number} merged`;
  if (pr.state === "closed") return `#${pr.number} closed`;
  const checks = pr.checks === "failing" ? ", checks failing" : pr.checks === "pending" ? ", checks running" : pr.checks === "passing" ? ", checks passed" : "";
  return `#${pr.number} ${pr.draft ? "draft" : "open"}${checks}`;
}

/**
 * The icon's colour: orange while checks run, green when it's ready to merge, purple once merged,
 * red when closed or a check failed, grey as a draft.
 */
export function pullRequestTone(pr: Pick<ThreadPullRequest, "state" | "checks" | "draft">): "pending" | "ready" | "merged" | "failing" | "closed" | "draft" {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.checks === "failing") return "failing";
  if (pr.checks === "pending") return "pending";
  return pr.draft ? "draft" : "ready";
}

/**
 * A thread's pull request (server/pullRequests.ts) in its sidebar row: its number, with the icon
 * coloured by its state. The row is already a button, so the badge opens the pull request on click
 * rather than being a link of its own.
 */
export function PullRequestBadge({ pr, size = 12 }: { pr: ThreadPullRequest; size?: number }) {
  return (
    <span
      role="link"
      className={`pr-badge pr-${pullRequestTone(pr)} history-pr`}
      title={`Pull request ${pullRequestLabel(pr)} · open on GitHub`}
      // Opening the pull request mustn't also open (or start dragging) the thread.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(pr.url, "_blank", "noopener,noreferrer");
      }}
    >
      <GitPullRequest size={size} className="pr-icon" />
      <span>#{pr.number}</span>
    </span>
  );
}
