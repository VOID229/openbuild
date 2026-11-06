import { expect, test } from "bun:test";
import type { ThreadRuntime } from "../shared/types";
import { disabledRuntimes, RUNTIMES, runtimeEnabled, setRuntimeEnabled } from "../src/lib/runtimes";

const detected = (...installed: ThreadRuntime[]) =>
  Object.fromEntries(RUNTIMES.map((r) => [r.runtime, { installed: installed.includes(r.runtime) }]));
const enabled = (...args: Parameters<typeof disabledRuntimes>) => RUNTIMES.filter((r) => runtimeEnabled(args[0], r.runtime, args[1], args[2])).map((r) => r.runtime);

test("a device with nothing saved turns on exactly the runtimes its detection found", () => {
  expect(enabled({}, undefined, detected("pi", "codex", "claude"))).toEqual(["pi", "claude", "codex"]);
  expect(enabled({}, undefined, detected("hermes", "fx", "durable", "pi"))).toEqual(["pi", "durable", "hermes", "fx"]);
  // A runtime the device's server doesn't report (an older server) isn't installed there.
  expect(enabled({}, undefined, { pi: { installed: true } })).toEqual(["pi"]);
  // Before detection answers, nothing is hidden: the picker greys out what turns out missing.
  expect(disabledRuntimes({})).toEqual([]);
});

test("a saved choice wins over detection, per device", () => {
  const statuses = detected("pi", "codex");
  let settings = setRuntimeEnabled({}, "claude", true, undefined, statuses);
  expect(enabled(settings, undefined, statuses)).toEqual(["pi", "claude", "codex"]);
  settings = setRuntimeEnabled(settings, "codex", false, undefined, statuses);
  // Installing more later doesn't override what the user chose for this device.
  expect(enabled(settings, undefined, detected("pi", "codex", "grok"))).toEqual(["pi", "claude"]);
  expect(enabled(settings, "other-device", detected("grok"))).toEqual(["grok"]);
  expect(runtimeEnabled({ disabledRuntimes: { "": [] } }, "durable", undefined, detected())).toBe(true);
});
