// Incomplete snapshots must be checked sooner than complete ones. Keep failures on a
// separate clock: a failed refresh must neither hide old data nor hammer a sleeping device.
export const REPORT_FRESH_MS = 15_000;
export const REMOTE_FRESH_MS = 60_000;
export const PENDING_FRESH_MS = 3_000;
export const RETRY_MS = 15_000;

export function shouldRefresh(
  cache: { at: number; value?: unknown; retryAt?: number; error?: string },
  incomplete: boolean,
  force: boolean,
  now = Date.now(),
) {
  if (force) return true;
  // A failed machine stays stopped until an explicit refresh, not another page poll.
  if (cache.error) return false;
  if (cache.retryAt && now < cache.retryAt) return false;
  return cache.value === undefined || now - cache.at >= (incomplete ? PENDING_FRESH_MS : REMOTE_FRESH_MS);
}
