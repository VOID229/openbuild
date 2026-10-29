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
await idb.set("draft:fresh", { text: "still here", fileIds: ["kept"], updatedAt: Date.now() - 60_000 }, saved);
await idb.set("draftfile:kept", { id: "kept", name: "k.png", mime: "image/png", size: 1, dataUrl: "data:," }, saved);
await idb.set("draft:stale", { text: "too old", fileIds: ["orphan"], updatedAt: Date.now() - 6 * 60_000 }, saved);
await idb.set("draftfile:orphan", { id: "orphan", name: "o.png", mime: "image/png", size: 1, dataUrl: "data:," }, saved);

const { selectionFor, deviceDetection, useStore } = await import("../src/lib/store");
const { sendMessage } = await import("../src/lib/chat");
// A fresh copy of the module, as a page load would have (other test files may have loaded it already).
const { draftsReady, getDraft, saveDraft } = await import("../src/lib/drafts?reload" as string);
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

describe("threads on a paired device", () => {
  // The device's Pi lists only its own providers; this server's models aren't usable there.
  const remote = { pi: { plan: "pi", status: "valid", models: [model("llama/3")], checkedAt: 1 } } as Record<"pi", Detection>;
  const chat: Chat = {
    id: "r",
    title: "",
    createdAt: 0,
    updatedAt: 0,
    workspace: { cwd: "/srv/app", deviceId: "dev" } as any,
    messages: [
      { id: "u", role: "user", content: "hi", createdAt: 0 },
      { id: "a", role: "assistant", content: "hey", model: { plan: "pi", id: "llama/3", name: "llama/3" }, createdAt: 0 },
    ],
  };
  const on = (models?: Record<string, Detection>, over: Record<string, unknown> = {}) =>
    ({ activeChatId: "r", chats: [chat], selections: {}, settings, detection, remoteModels: models, ...over });

  test("the chat uses the device's model, not this server's list", () => {
    // This server knows nothing about llama/3; the device does.
    expect(selectionFor(on({ dev: remote.pi }))).toMatchObject({ id: "llama/3" });
  });
  test("its model is kept while the device's list is still on its way", () => {
    expect(selectionFor(on({}))).toMatchObject({ id: "llama/3" });
    expect(selectionFor(on(undefined))).toMatchObject({ id: "llama/3" });
  });
  test("a model this server has but the device doesn't gives way to one it does", () => {
    const gone = { ...chat, messages: [...chat.messages.slice(0, 1), { id: "a", role: "assistant", content: "", model: { plan: "pi", id: "deepseek/chat", name: "deepseek/chat" }, createdAt: 0 }] } as Chat;
    expect(selectionFor(on({ dev: remote.pi }, { chats: [gone] }))).toMatchObject({ id: "llama/3" });
  });
  test("new threads use the models of the project's device", () => {
    // The new-chat model is this server's (go/deepseek); the device offers llama/3.
    const st = on({ dev: remote.pi }, { activeChatId: undefined, chats: [], projects: [{ id: "dev::app", deviceId: "dev" }] });
    st.settings = { ...settings, workspace: { projectId: "dev::app" } } as Settings;
    expect(selectionFor(st)).toMatchObject({ id: "llama/3" });
  });
  test("the model it swaps in for the device is a stable object", () => {
    // The fallback is derived from the device's list, and this runs as a store selector: a fresh
    // object every call re-renders for ever (React drops the page: "getSnapshot should be cached").
    const st = on({ dev: remote.pi }, { activeChatId: undefined, chats: [], projects: [{ id: "dev::app", deviceId: "dev" }] });
    st.settings = { ...settings, workspace: { projectId: "dev::app" } } as Settings;
    expect(selectionFor(st)).toBe(selectionFor(st));
    const listed = { plan: "pi", status: "valid", models: [model("qwen/4")], checkedAt: 2 } as Detection;
    const newer = on({ dev: listed }, { activeChatId: undefined, chats: [], projects: [{ id: "dev::app", deviceId: "dev" }] });
    newer.settings = st.settings;
    expect(selectionFor(newer)).toBe(selectionFor(newer));
    expect(selectionFor(newer)).toMatchObject({ id: "qwen/4" });
  });
});

describe("native Codex model selection", () => {
  const listed = { plan: "codex", status: "valid", models: [model("codex/first"), model("codex/default")], defaultModel: "codex/default" } as Detection & { defaultModel: string };
  const native = () => ({
    activeChatId: undefined as string | undefined,
    chats: [] as Chat[], selections: {}, detection,
    settings: { ...settings, threadRuntime: "codex" as const },
    codexModels: { "": listed } as Record<string, Detection & { defaultModel?: string }>,
  });
  test("uses its own default, not Pi's openai-codex model, with a stable selector", () => {
    const st = native();
    st.settings.selection = { plan: "pi", id: "openai-codex/gpt-5" };
    expect(selectionFor(st)).toEqual({ plan: "codex", id: "codex/default" });
    expect(selectionFor(st)).toBe(selectionFor(st));
    expect(deviceDetection(st, undefined, "codex")).toEqual({ codex: listed });
  });
  test("uses the project's device list, never this server's list", () => {
    const st = { ...native(), projects: [{ id: "dev::app", deviceId: "dev", name: "app", path: "/app", git: false }], codexModels: { "": listed, dev: { ...listed, models: [model("codex/remote")], defaultModel: "codex/remote" } } };
    st.settings = { ...st.settings, workspace: { projectId: "dev::app" } } as typeof st.settings;
    expect(selectionFor(st)).toEqual({ plan: "codex", id: "codex/remote" });
  });
  test("preserves the last native reply while discovery is pending", () => {
    const st = native();
    st.activeChatId = "q";
    st.chats = [{ ...qwenChat, runtime: "codex", messages: [{ ...qwenChat.messages[1]!, model: { plan: "codex", id: "codex/last", name: "last" } }] }];
    st.codexModels = {};
    expect(selectionFor(st)).toMatchObject({ plan: "codex", id: "codex/last" });
  });
  test("native preference is independent of the Pi new-chat preference", () => {
    const st = native();
    st.settings = { ...st.settings, codexSelection: { plan: "codex", id: "codex/first" } } as typeof st.settings;
    expect(selectionFor(st)).toEqual({ plan: "codex", id: "codex/first" });
    expect(st.settings.selection).toEqual(settings.selection);
  });
});

describe("drafts", () => {
  test("recent drafts survive a reload; old ones are dropped", async () => {
    await draftsReady;
    expect(getDraft("fresh")).toMatchObject({ text: "still here", files: [{ id: "kept" }] });
    expect(getDraft("stale")).toBeUndefined();
    expect(await idb.get("draft:stale", saved)).toBeUndefined();
    expect(await idb.get("draftfile:orphan", saved)).toBeUndefined();
  });
  test("drafts, images included, are written to IndexedDB; emptying one removes it", async () => {
    const image = { id: "i", name: "a.png", mime: "image/png", size: 3, dataUrl: "data:image/png;base64,AAA" } as any;
    saveDraft("c1", "hello", [image]);
    expect(getDraft("c1")?.files).toEqual([image]);
    await Bun.sleep(500);
    expect(await idb.get("draft:c1", saved)).toMatchObject({ text: "hello", fileIds: ["i"] });
    expect(await idb.get("draftfile:i", saved)).toEqual(image);
    saveDraft("c1", "  ", []);
    expect(getDraft("c1")).toBeUndefined();
    await Bun.sleep(500);
    expect(await idb.get("draft:c1", saved)).toBeUndefined();
    expect(await idb.get("draftfile:i", saved)).toBeUndefined();
  });
});

describe("background send", () => {
  const model = { id: "pi/test", name: "Test", protocol: "openai", input: ["text"], reasoning: { efforts: [], mode: "none", toggle: false } };

  test("Cmd+Enter starts the thread without opening it, and the folder is the one chosen before the fresh thread", async () => {
    const bodies: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/api/workspaces")) bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ error: "stop" }), { status: 500, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const previous = useStore.getState();
    try {
      useStore.setState({
        activeChatId: undefined,
        chats: [],
        projects: [{ id: "p", name: "App", path: "/tmp/app", git: true }],
        detection: { pi: { plan: "pi", status: "valid", models: [model as any] } },
        settings: {
          ...previous.settings,
          naming: { enabled: false, models: [] },
          selection: { plan: "pi", id: model.id },
          threadRuntime: "pi",
          workspace: { mode: "local", projectId: "p", branch: "feature", defaultMode: "worktree" },
        },
      });
      expect(sendMessage("hello", [], undefined, true)).toBe(true);
      const started = useStore.getState().chats[0];
      expect(started?.messages[0]?.content).toBe("hello");
      expect(useStore.getState().activeChatId).toBeUndefined();
      useStore.getState().newChat();
      expect(useStore.getState().activeChatId).toBeUndefined();
      expect(useStore.getState().settings.workspace.mode).toBe("worktree");
      expect(useStore.getState().settings.workspace.branch).toBeUndefined();
      await Bun.sleep(30);
      expect(bodies[0]).toMatchObject({ mode: "local", projectId: "p", branch: "feature" });
      expect(useStore.getState().chats).toHaveLength(1);

      useStore.setState({ activeChatId: undefined, chats: [] });
      expect(sendMessage("stay", [])).toBe(true);
      expect(useStore.getState().activeChatId).toBe(useStore.getState().chats[0]?.id);
    } finally {
      globalThis.fetch = original;
      useStore.setState({ settings: previous.settings, chats: previous.chats, activeChatId: previous.activeChatId, projects: previous.projects, detection: previous.detection });
    }
  });
});
