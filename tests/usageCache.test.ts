import { describe, expect, test } from "bun:test";
import { MAX_RETRY_MS, PENDING_FRESH_MS, REMOTE_FRESH_MS, RETRY_MS, retryDelay, shouldRefresh } from "../server/usage/cache";

describe("usage snapshot caching", () => {
  const at = 1_000_000;
  const cached = { at, value: {} };

  test("complete snapshots are reused for a minute", () => {
    expect(shouldRefresh(cached, false, false, at + REMOTE_FRESH_MS - 1)).toBe(false);
    expect(shouldRefresh(cached, false, false, at + REMOTE_FRESH_MS)).toBe(true);
  });

  test("incomplete snapshots refresh on the next browser poll, not a minute later", () => {
    expect(shouldRefresh(cached, true, false, at + PENDING_FRESH_MS - 1)).toBe(false);
    expect(shouldRefresh(cached, true, false, at + PENDING_FRESH_MS)).toBe(true);
  });

  test("first request starts immediately", () => {
    expect(shouldRefresh({ at: 0 }, false, false, at)).toBe(true);
  });

  test("failed first reads and stale refreshes both back off", () => {
    for (const value of [undefined, {}]) {
      const failed = { at: at - REMOTE_FRESH_MS, value, retryAt: at + RETRY_MS };
      expect(shouldRefresh(failed, false, false, at)).toBe(false);
      expect(shouldRefresh(failed, false, false, at + RETRY_MS)).toBe(true);
      expect(shouldRefresh(failed, true, false, at)).toBe(false);
    }
  });

  test("a failed first read is retried once its back-off passes, not left failed", () => {
    const failed = { at: 0, error: "it didn't answer in time", retryAt: at + RETRY_MS };
    expect(shouldRefresh(failed, false, false, at)).toBe(false);
    expect(shouldRefresh(failed, false, false, at + RETRY_MS)).toBe(true);
    expect(shouldRefresh(failed, false, true, at)).toBe(true);
  });

  test("repeated failures back off further, up to a cap", () => {
    expect(retryDelay(1)).toBe(RETRY_MS);
    expect(retryDelay(2)).toBe(RETRY_MS * 2);
    expect(retryDelay(3)).toBe(RETRY_MS * 4);
    expect(retryDelay(50)).toBe(MAX_RETRY_MS);
  });

  test("explicit refresh skips freshness and retry cooldowns", () => {
    expect(shouldRefresh(cached, false, true, at)).toBe(true);
    expect(shouldRefresh({ ...cached, retryAt: at + RETRY_MS }, false, true, at)).toBe(true);
  });
});
