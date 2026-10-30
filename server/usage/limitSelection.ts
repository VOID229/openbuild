import type { UsageLimits } from "../../shared/usage";

/** Live readings outrank snapshots; among equally reliable readings take the newest. */
export function preferLimits(next: UsageLimits, previous: UsageLimits): boolean {
  const rank = (r: UsageLimits) => r.windows.length ? (r.stale || r.error ? 1 : 2) : 0;
  return rank(next) > rank(previous) || (rank(next) === rank(previous) && next.asOf > previous.asOf);
}
