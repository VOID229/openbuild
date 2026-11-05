// What a pull request's state means for merging it, for the Merge button and for bots.
import type { PullDetail } from "./types";

export interface Readiness {
  tone: "ok" | "wait" | "warn" | "bad" | "merged" | "closed" | "draft";
  text: string;
  /** GitHub should accept a merge now. */
  canMerge: boolean;
}

type ReadinessInput = Pick<PullDetail, "state" | "draft" | "base" | "mergeable" | "mergeState" | "reviewDecision" | "checkList" | "canWrite">;

/** GitHub hasn't finished working out whether this pull request can merge: asking again soon will tell. */
export const mergeUnsettled = (pr: Pick<PullDetail, "state" | "draft" | "mergeable" | "mergeState">) => pr.state === "open" && !pr.draft && (pr.mergeable === "UNKNOWN" || pr.mergeState === "UNKNOWN");

/** One line on where a pull request stands, and whether the Merge button should work. */
export function mergeReadiness(pr: ReadinessInput): Readiness {
  if (pr.state === "merged") return { tone: "merged", text: "Merged", canMerge: false };
  if (pr.state === "closed") return { tone: "closed", text: "Closed without merging", canMerge: false };
  if (pr.draft) return { tone: "draft", text: "Draft: not ready for review yet", canMerge: false };
  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") return { tone: "bad", text: `Conflicts with ${pr.base}`, canMerge: false };
  const failing = pr.checkList.filter((c) => c.state === "failing").length;
  const pending = pr.checkList.filter((c) => c.state === "pending").length;
  const checks = (n: number) => `${n} ${n === 1 ? "check" : "checks"}`;
  // BLOCKED: a branch rule stands in the way, so say the likeliest one.
  if (pr.mergeState === "BLOCKED") {
    if (failing) return { tone: "bad", text: `${checks(failing)} failing`, canMerge: false };
    if (pr.reviewDecision === "CHANGES_REQUESTED") return { tone: "bad", text: "Changes requested", canMerge: false };
    if (pending) return { tone: "wait", text: `Waiting on ${checks(pending)}`, canMerge: false };
    if (pr.reviewDecision === "REVIEW_REQUIRED") return { tone: "warn", text: "Needs a review", canMerge: false };
    return { tone: "warn", text: `Blocked by ${pr.base}'s branch rules`, canMerge: false };
  }
  if (pr.mergeState === "BEHIND") return { tone: "warn", text: `Behind ${pr.base}: update the branch first`, canMerge: false };
  if (pr.mergeable === "UNKNOWN" || pr.mergeState === "UNKNOWN") return { tone: "wait", text: "GitHub is checking if it can merge", canMerge: false };
  const can = pr.canWrite;
  if (failing) return { tone: "bad", text: `${checks(failing)} failing, not required`, canMerge: can };
  if (pending) return { tone: "wait", text: `${checks(pending)} still running`, canMerge: can };
  return can ? { tone: "ok", text: "Ready to merge", canMerge: true } : { tone: "warn", text: "You can't merge in this repository", canMerge: false };
}
