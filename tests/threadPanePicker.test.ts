import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelInfo } from "../shared/types";
import type { Chat, Settings } from "../src/lib/types";

// A thread open in the OpenBots panel shows its composer while it isn't the active chat. Its pickers
// used to read `activeChatId`, so they showed (and set) the new-thread draft's model, effort and
// harness: a bot's Opus/medium Claude thread read "Haiku 5.5 Low" on the second account.
if (process.env.OPENBUILD_THREAD_PANE_PICKER_CHILD !== "1") {
  test("thread pane picker (isolated browser)", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, OPENBUILD_THREAD_PANE_PICKER_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code) throw new Error(`${out}\n${err}`);
    expect(code).toBe(0);
  });
} else {
  await import("fake-indexeddb/auto" as string);
  const g = globalThis as any;
  g.window ??= globalThis;
  g.innerWidth = 1280;
  g.document ??= { addEventListener() {}, visibilityState: "visible" };
  g.addEventListener ??= () => {};
  g.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const storage = new Map<string, string>();
  g.localStorage ??= { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  globalThis.fetch = (async (url: any) => {
    if (String(url) === "/api/config") return Response.json({ mode: "local", serverId: "thread-pane-picker" });
    return Response.json({});
  }) as typeof fetch;
  const { config } = await import("../src/lib/runtime");
  await config;
  const { useStore, selectionFor, composerEffort, atChat, claudeDetection } = await import("../src/lib/store");
  const { ModelPicker, PickerFoot } = await import("../src/components/Pickers");
  const base = useStore.getState().settings;

  const model = (id: string, name: string, provider: string): ModelInfo => ({ id, name, provider, protocol: "chat", input: ["text"], reasoning: { efforts: ["low", "medium", "high"], mode: "effort", toggle: false } });
  const second = { id: "claude-2", name: "Claude 2", runtime: "claude" as const, configDir: "/claude-2" };
  const listing = {
    plan: "claude" as const, status: "valid" as const, checkedAt: Date.now(), defaultModel: "claude/default",
    models: [model("claude/opus", "Opus 5.5", "claude"), model("claude/haiku", "Haiku 5.5", "claude")],
    accounts: [{ account: second, models: [model("claude-2/opus", "Opus 5.5", "claude-2"), model("claude-2/haiku", "Haiku 5.5", "claude-2")] }],
  };
  // As a bot leaves it: started with Opus at medium on the default account, nothing picked in the UI.
  const botThread: Chat = {
    id: "bot-thread", title: "Scope", createdAt: 0, updatedAt: 0, runtime: "claude", permission: "bypassPermissions",
    messages: [
      { id: "u", role: "user", content: "go", createdAt: 0 } as any,
      { id: "a", role: "assistant", content: "done", createdAt: 1, model: { plan: "claude", id: "claude/opus", name: "Opus 5.5", effort: "medium" } } as any,
    ],
  };
  const other: Chat = { id: "other", title: "Other", createdAt: 0, updatedAt: 0, runtime: "pi", messages: [] };
  function reset(settings: Partial<Settings> = {}) {
    useStore.setState({
      // The new-thread draft prefers the second account's Haiku at low effort.
      settings: { ...base, threadRuntime: "claude", workspace: { mode: "local" }, naming: { enabled: false, models: [] }, nativeSelections: { claude: { "": { plan: "claude", id: "claude-2/haiku" } } }, effort: "low", modelEfforts: { [JSON.stringify(["claude", "claude-2/haiku"])]: "low" }, ...settings },
      chats: [structuredClone(botThread), other], activeChatId: undefined, selections: {}, projects: [], claudeModels: { "": listing },
    });
  }
  function markup(element: Parameters<typeof renderToStaticMarkup>[0]) {
    const initial = useStore.getInitialState();
    const saved = { ...initial };
    Object.assign(initial, useStore.getState());
    try { return renderToStaticMarkup(element); }
    finally { Object.assign(initial, saved); }
  }

  test("a thread's picker shows its own model and effort, not the new-thread draft's", () => {
    for (const active of [undefined, "other"]) {
      reset();
      useStore.setState({ activeChatId: active });
      const pill = markup(createElement(ModelPicker, { dropUp: true, chatId: "bot-thread" }));
      expect(pill).toContain('aria-label="Model: Opus 5.5, Medium reasoning"');
      expect(pill).not.toContain("Haiku");
    }
    // The draft keeps its own choice.
    reset();
    expect(markup(createElement(ModelPicker, { dropUp: false }))).toContain('aria-label="Model: Haiku 5.5, Low reasoning"');
  });

  test("choosing a model or effort in a thread's picker changes that thread, not the draft or the active chat", () => {
    reset();
    useStore.setState({ activeChatId: "other" });
    useStore.getState().setSelection({ plan: "claude", id: "claude/haiku" }, "bot-thread");
    useStore.getState().setEffort("high", undefined, "bot-thread");
    const s = useStore.getState();
    expect(s.selections).toEqual({ "bot-thread": { plan: "claude", id: "claude/haiku" } });
    expect(selectionFor(atChat(s, "bot-thread"))).toEqual({ plan: "claude", id: "claude/haiku" });
    expect(composerEffort(atChat(s, "bot-thread"))).toBe("high");
    expect(s.chats.find((c) => c.id === "other")?.efforts).toBeUndefined();
    expect(s.settings.nativeSelections?.claude?.[""]).toEqual({ plan: "claude", id: "claude-2/haiku" });
    expect(s.settings.modelEfforts?.[JSON.stringify(["claude", "claude/haiku"])]).toBeUndefined();
  });

  test("a started thread's pane can't switch harness or account", () => {
    reset();
    const foot = markup(createElement(PickerFoot, { chatId: "bot-thread" }));
    expect(foot).toContain("mp-runtime-fixed");
    expect(foot).not.toContain('role="radiogroup" aria-label="Harness"');
    // Its account's models only: the second account's aren't offered.
    const pill = markup(createElement(ModelPicker, { dropUp: true, chatId: "bot-thread" }));
    expect(pill).toContain("Opus 5.5");
    expect(selectionFor(atChat(useStore.getState(), "bot-thread"))).toMatchObject({ plan: "claude", id: "claude/opus" });
    expect(claudeDetection(listing, useStore.getState().chats[0]).models.map((m) => m.id)).toEqual(["claude/opus", "claude/haiku"]);
    // The new-thread draft still chooses its harness.
    expect(markup(createElement(PickerFoot, {}))).toContain('aria-label="Harness"');
  });
}
