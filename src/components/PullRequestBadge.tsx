import { GitPullRequest } from "lucide-react";
import type { ThreadPullRequest } from "../../shared/types";
import { NEW_TAB_CLICK, newTabClick } from "../lib/links";

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
 * rather than being a link of its own: in OpenBuild (`onOpen`, the side panel's pull requests tab)
 * when it can, and on GitHub with ⌘/Ctrl-click, Shift-click or a middle click.
 */
export function PullRequestBadge({ pr, size = 12, onOpen }: { pr: ThreadPullRequest; size?: number; onOpen?: () => void }) {
  const github = () => window.open(pr.url, "_blank", "noopener,noreferrer");
  return (
    <span
      role="link"
      className={`pr-badge pr-${pullRequestTone(pr)} history-pr`}
      title={onOpen ? `Pull request ${pullRequestLabel(pr)} · ${NEW_TAB_CLICK} to open on GitHub` : `Pull request ${pullRequestLabel(pr)} · open on GitHub`}
      // Opening the pull request mustn't also open (or start dragging) the thread.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onOpen && !newTabClick(e) && !e.shiftKey) onOpen();
        else github();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        github();
      }}
    >
      <GitPullRequest size={size} className="pr-icon" />
      <span>#{pr.number}</span>
    </span>
  );
}
