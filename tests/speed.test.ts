import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effortKey, speedFor, supportedSpeed } from "../src/lib/effort";
import type { Chat, Settings } from "../src/lib/types";
import { chosenSpeed, withSpeed } from "../server/pi/extensions/speed";
import { isSpeedId } from "../shared/types";

const a = { plan: "pi" as const, id: "openai-codex/gpt-a" };
const b = { plan: "pi" as const, id: "anthropic/claude-b" };
const thread = (speeds?: Chat["speeds"], messages: Chat["messages"] = []): Chat => ({ id: "t", title: "T", createdAt: 0, updatedAt: 0, messages, speeds });

test("speed is kept per thread and model, and '' records standard", () => {
  const settings = { modelSpeeds: { [effortKey(a)]: "priority" } } as unknown as Settings;
  expect(speedFor(settings, undefined, a)).toBe("priority");
  expect(speedFor(settings, undefined, b)).toBeUndefined();
  expect(speedFor(settings, thread({ [effortKey(a)]: "" }), a)).toBeUndefined();
  expect(speedFor(settings, thread({ [effortKey(b)]: "fast" }), b)).toBe("fast");
  // A thread doesn't follow later new-thread changes.
  expect(speedFor(settings, thread(), a)).toBeUndefined();
  // Falls back to what the thread's last reply on that model used.
  const reply = { id: "m", role: "assistant", content: "", createdAt: 0, model: { ...a, name: "A", speed: "priority" } } as Chat["messages"][number];
  expect(speedFor(settings, thread(undefined, [reply]), a)).toBe("priority");
  expect(speedFor(settings, undefined, { auto: true })).toBeUndefined();
});

test("only speeds the model lists are used", () => {
  expect(supportedSpeed([{ id: "priority" }], "priority")).toBe("priority");
  expect(supportedSpeed([{ id: "priority" }], "fast")).toBeUndefined();
  expect(supportedSpeed(undefined, "priority")).toBeUndefined();
  expect(isSpeedId("priority")).toBe(true);
  expect(isSpeedId("a b")).toBe(false);
});

test("the Pi extension applies the speed only to the chosen model, the way its API takes it", () => {
  const file = join(mkdtempSync(join(tmpdir(), "speed-")), "s.json");
  writeFileSync(file, JSON.stringify({ model: "openai-codex/gpt-a", speed: "priority" }));
  expect(chosenSpeed(file, { provider: "openai-codex", id: "gpt-a" })).toBe("priority");
  expect(chosenSpeed(file, { provider: "openai-codex", id: "gpt-other" })).toBeUndefined();
  writeFileSync(file, JSON.stringify({ model: "openai-codex/gpt-a", speed: null }));
  expect(chosenSpeed(file, { provider: "openai-codex", id: "gpt-a" })).toBeUndefined();
  expect(chosenSpeed(join(file, "missing"), { provider: "x", id: "y" })).toBeUndefined();

  expect(withSpeed({ model: "m" }, "openai-codex-responses", "priority")).toEqual({ model: "m", service_tier: "priority" });
  expect(withSpeed({ model: "m" }, "openai-responses", "flex")).toEqual({ model: "m", service_tier: "flex" });
  expect(withSpeed({ model: "m" }, "anthropic-messages", "fast")).toEqual({ model: "m", speed: "fast" });
  expect(withSpeed({ model: "m" }, "openai-completions", "fast")).toEqual({ model: "m" });
});
