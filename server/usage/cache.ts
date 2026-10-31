// Incomplete snapshots must be checked sooner than complete ones. Keep failures on a
// separate clock: a failed refresh must neither hide old data nor hammer a sleeping device.
export const REPORT_FRESH_MS = 15_000;
export const REMOTE_FRESH_MS = 60_000;
export const PENDING_FRESH_MS = 3_000;
export const RETRY_MS = 15_000;
/** The longest wait between retries of a machine that keeps failing. */
export const MAX_RETRY_MS = 5 * 60_000;

/** The wait after `failures` failures in a row: doubling from RETRY_MS, capped at MAX_RETRY_MS. */
export const retryDelay = (failures: number) => Math.min(RETRY_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_MS);

export function shouldRefresh(
  cache: { at: number; value?: unknown; retryAt?: number; error?: string },
  incomplete: boolean,
  force: boolean,
  now = Date.now(),
) {
  if (force) return true;
  // A failed machine is retried on its back-off clock: a first read that timed out (a device
  // still scanning its history right after pairing) mustn't leave it failed until a manual refresh.
  if (cache.retryAt && now < cache.retryAt) return false;
  return cache.value === undefined || now - cache.at >= (incomplete ? PENDING_FRESH_MS : REMOTE_FRESH_MS);
}
