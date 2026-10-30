import { expect, test } from "bun:test";
import { preferLimits } from "../server/usage/limitSelection";
import type { UsageLimits } from "../shared/usage";
const live: UsageLimits = { id: "codex:a", provider: "codex", asOf: 1000, windows: [{ id: "primary", label: "Session", kind: "session", usedPercent: 50 }] };
test("newest healthy reading wins", () => {
  expect(preferLimits({ ...live, asOf: 2000 }, live)).toBe(true);
  expect(preferLimits(live, { ...live, asOf: 2000 })).toBe(false);
});
test("newer failures and cached readings cannot replace a healthy reading", () => {
  for (const bad of [{ ...live, stale: true }, { ...live, error: "offline" }, { ...live, windows: [] }]) {
    expect(preferLimits({ ...bad, asOf: 2000 }, live)).toBe(false);
    expect(preferLimits(live, { ...bad, asOf: 2000 })).toBe(true);
  }
});
test("fallback readings keep their actual timestamp and prefer newer snapshots", () => {
  expect(preferLimits({ ...live, stale: true, asOf: 2000 }, { ...live, stale: true })).toBe(true);
  expect(preferLimits({ ...live, windows: [], asOf: 3000 }, { ...live, stale: true })).toBe(false);
});
