import { expect, test } from "bun:test";
import { disabledRuntimes, RUNTIMES, runtimeEnabled, setRuntimeEnabled } from "../src/lib/runtimes";

test("runtime defaults and explicit per-device overrides survive enabling all runtimes", () => {
  expect(RUNTIMES.filter(r => runtimeEnabled({}, r.runtime)).map(r => r.runtime).sort().join(","))
    .toEqual(["pi", "claude", "opencode", "codex", "cursor", "grok"].sort().join(","));
  let settings = {};
  for (const r of ["hermes", "durable", "fx"] as const) settings = setRuntimeEnabled(settings, r, true);
  expect(disabledRuntimes(settings)).toEqual([]);
  expect(runtimeEnabled(settings, "hermes")).toBe(true);
  expect(runtimeEnabled(settings, "hermes", "other-device")).toBe(false);
  expect(runtimeEnabled({ disabledRuntimes: { "": [] } }, "durable")).toBe(true);
});
