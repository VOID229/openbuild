// The composer's per-chat state: which model it sends with, and drafts that outlive a reload.
import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import * as idb from "idb-keyval";

const g = globalThis as any;
g.window ??= globalThis;
g.innerWidth = 1280;
g.document ??= { addEventListener() {}, visibilityState: "visible" };
const ls = new Map<string, string>();
g.localStorage ??= { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) };
g.addEventListener ??= () => {};

// Drafts saved by "the previous page load": one fresh, one past the timeout.
const saved = idb.createStore("openchat-drafts", "drafts");
await idb.set("fresh", { text: "still here", files: [], updatedAt: Date.now() - 60_000 }, saved);
await idb.set("stale", { text: "too old", files: [], updatedAt: Date.now() - 6 * 60_000 }, saved);

const { selectionFor } = await import("../src/lib/store");
const { draftsReady, getDraft, saveDraft } = await import("../src/lib/drafts");
import type { Chat, Detection, Settings } from "../src/lib/types";

const model = (id: string) => ({ id, name: id }) as any;
const detection = { go: { plan: "go", status: "valid", models: [model("qwen"), model("deepseek"), model("glm")] } as Detection };
const settings = { selection: { plan: "go", id: "deepseek" }, autoRouter: false } as Settings;
const qwenChat: Chat = {
  id: "q",
  title: "",
  createdAt: 0,
  updatedAt: 0,
  messages: [
    { id: "u", role: "user", content: "hi", createdAt: 0 },
    { id: "a", role: "assistant", content: "hey", model: { plan: "go", id: "qwen", name: "qwen" }, createdAt: 0 },
  ],
};
const state = (activeChatId: string | undefined, selections = {}) => ({ activeChatId, chats: [qwenChat], selections, settings, detection });

describe("model selection", () => {
  test("a chat uses the model of its last reply, not the new-chat model", () => {
    expect(selectionFor(state("q"))).toMatchObject({ id: "qwen" });
  });
  test("the new-chat screen uses the new-chat model", () => {
    expect(selectionFor(state(undefined))).toMatchObject({ id: "deepseek" });
  });
  test("a model picked in a chat sticks to that chat", () => {
    expect(selectionFor(state("q", { q: { plan: "go", id: "glm" } }))).toMatchObject({ id: "glm" });
    expect(selectionFor(state(undefined, { q: { plan: "go", id: "glm" } }))).toMatchObject({ id: "deepseek" });
  });
  test("a chat whose model is gone falls back to the new-chat model", () => {
    expect(selectionFor(state("q", { q: { plan: "go", id: "removed" } }))).toMatchObject({ id: "deepseek" });
  });
  test("the selector returns stable objects", () => {
    expect(selectionFor(state("q"))).toBe(selectionFor(state("q")));
  });
});

describe("drafts", () => {
  test("recent drafts survive a reload; old ones are dropped", async () => {
    await draftsReady;
    expect(getDraft("fresh")?.text).toBe("still here");
    expect(getDraft("stale")).toBeUndefined();
    expect(await idb.get("stale", saved)).toBeUndefined();
  });
  test("drafts, images included, are written to IndexedDB; emptying one removes it", async () => {
    const image = { id: "i", name: "a.png", mime: "image/png", size: 3, dataUrl: "data:image/png;base64,AAA" } as any;
    saveDraft("c1", "hello", [image]);
    expect(getDraft("c1")?.files).toEqual([image]);
    await Bun.sleep(500);
    expect(await idb.get("c1", saved)).toMatchObject({ text: "hello", files: [image] });
    saveDraft("c1", "  ", []);
    expect(getDraft("c1")).toBeUndefined();
    await Bun.sleep(500);
    expect(await idb.get("c1", saved)).toBeUndefined();
  });
});
