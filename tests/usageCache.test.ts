import { describe, expect, test } from "bun:test";
import { PENDING_FRESH_MS, REMOTE_FRESH_MS, RETRY_MS, shouldRefresh } from "../server/usage/cache";

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

  test("failed machines stay stopped until explicit refresh, even with incomplete cached data", () => {
    const failed = { ...cached, error: "it's unreachable" };
    expect(shouldRefresh(failed, true, false, at + 86_400_000)).toBe(false);
    expect(shouldRefresh(failed, false, false, at + 86_400_000)).toBe(false);
    expect(shouldRefresh(failed, true, true, at)).toBe(true);
  });

  test("explicit refresh skips freshness and retry cooldowns", () => {
    expect(shouldRefresh(cached, false, true, at)).toBe(true);
    expect(shouldRefresh({ ...cached, retryAt: at + RETRY_MS }, false, true, at)).toBe(true);
  });
});
