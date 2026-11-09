// The width of a thread opened in OpenBots' details panel (src/lib/bots/threadWidth.ts): held between a
// smallest width and one that leaves the bot chat its room, and kept unless it's the default.
import { afterEach, describe, expect, test } from "bun:test";
import { CHAT_MIN, clampThreadWidth, loadThreadWidth, saveThreadWidth, THREAD_DEFAULT, THREAD_MIN, threadMax } from "../src/lib/bots/threadWidth";

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  },
});
afterEach(() => store.clear());

describe("thread width", () => {
  test("stays between the smallest width and what leaves the chat its room", () => {
    expect(clampThreadWidth(100, 1200)).toBe(THREAD_MIN);
    expect(clampThreadWidth(600.4, 1200)).toBe(600);
    expect(clampThreadWidth(5000, 1200)).toBe(1200 - CHAT_MIN);
    expect(threadMax(1200)).toBe(1200 - CHAT_MIN);
  });

  test("never goes under the smallest, even when the row is too narrow for both", () => {
    expect(threadMax(500)).toBe(THREAD_MIN);
    expect(clampThreadWidth(900, 500)).toBe(THREAD_MIN);
  });

  test("starts at the default, and keeps a width only when it isn't the default", () => {
    expect(loadThreadWidth()).toBe(THREAD_DEFAULT);
    saveThreadWidth(640);
    expect(loadThreadWidth()).toBe(640);
    saveThreadWidth(THREAD_DEFAULT);
    expect(store.size).toBe(0);
  });

  test("ignores a saved width that's unreadable or too small", () => {
    for (const bad of ["nope", "12", "", "-400"]) {
      store.set("openbuild:bots-thread-width", bad);
      expect(loadThreadWidth()).toBe(THREAD_DEFAULT);
    }
  });

  test("falls back to the default when storage throws", () => {
    const saved = globalThis.localStorage;
    Object.assign(globalThis, { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} } });
    try {
      expect(loadThreadWidth()).toBe(THREAD_DEFAULT);
      expect(() => saveThreadWidth(700)).not.toThrow();
    } finally {
      Object.assign(globalThis, { localStorage: saved });
    }
  });
});
