import { expect, test } from "bun:test";
import { effortFor, effortKey } from "../src/lib/effort";
import type { Chat, Settings } from "../src/lib/types";

const a = { plan: "pi" as const, id: "provider/a" };
const b = { plan: "pi" as const, id: "provider/b" };
const settings = { effort: "medium", modelEfforts: { [effortKey(a)]: "low" } } as Settings;
const thread = (efforts?: Chat["efforts"]): Chat => ({ id: "t", title: "Test", createdAt: 0, updatedAt: 0, messages: [], efforts });

test("reasoning stays isolated per thread and model", () => {
  const one = thread({ [effortKey(a)]: "high", [effortKey(b)]: "off" });
  const two = thread({ [effortKey(a)]: "max" });
  expect(effortFor(settings, one, a)).toBe("high");
  expect(effortFor(settings, one, b)).toBe("off");
  expect(effortFor(settings, two, a)).toBe("max");
  expect(effortFor(settings, two, b)).toBe("medium");
  expect(effortFor(settings, undefined, a)).toBe("low");
  expect(effortFor(settings, thread(), a)).toBe("medium");
  expect(effortFor(settings, JSON.parse(JSON.stringify(one)), a)).toBe("high");
});

test("older threads recover each model's latest recorded effort", () => {
  const chat = thread();
  chat.messages = ["low", "high"].map((effort) => ({ id: effort, role: "assistant", content: "ok", createdAt: 0, model: { ...a, name: "A", effort } })) as Chat["messages"];
  expect(effortFor(settings, chat, a)).toBe("high");
  chat.efforts = { [effortKey(a)]: "off" };
  expect(effortFor(settings, chat, a)).toBe("off");
});

test("auto and provider identities have independent keys", () => {
  expect(effortKey(a)).not.toBe(effortKey({ ...a, plan: "go" }));
  const chat = thread({ [effortKey({ auto: true })]: "max", [effortKey(a)]: "low" });
  expect(effortFor(settings, chat, { auto: true })).toBe("max");
  expect(effortFor(settings, chat, a)).toBe("low");
});
