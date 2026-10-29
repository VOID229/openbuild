import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Chat, Settings } from "../src/lib/types";

// Browser shims, store persistence and fetch overrides stay in a separate process.
if (process.env.OPENBUILD_RUNTIME_UI_CHILD !== "1") {
  test("runtime UI and first-send invariants (isolated browser)", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, OPENBUILD_RUNTIME_UI_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`${out}\n${err}`);
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
const ls = new Map<string, string>();
g.localStorage ??= { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) };

const { useStore, deviceDetection, selectionFor, hasPermissionModes, permissionOf } = await import("../src/lib/store");
const { canSteer } = await import("../src/lib/chat");
const { runShell } = await import("../src/lib/shell");
const { WorkspaceTop, WorkspaceBelow } = await import("../src/components/Workspace");
const { Sidebar } = await import("../src/components/Sidebar");
const { sendMessage, regenerate, answerQuestion } = await import("../src/lib/chat");
const { AskCard } = await import("../src/components/ToolCalls");
const initialSettings = useStore.getState().settings;
const thread = (runtime?: Chat["runtime"]): Chat => ({ id: "runtime-test", title: "Test", createdAt: 0, updatedAt: 0, messages: [], runtime });

function markup(element: Parameters<typeof renderToStaticMarkup>[0]) {
  // Zustand's server snapshot normally points at boot state; render the test's current state.
  const snapshot = useStore.getInitialState();
  const original = { ...snapshot };
  Object.assign(snapshot, useStore.getState());
  try { return renderToStaticMarkup(element); }
  finally { Object.assign(snapshot, original); }
}

function reset(settings: Partial<Settings> = {}, chats: Chat[] = []) {
  useStore.setState({ settings: { ...initialSettings, workspace: { mode: "local" }, ...settings }, chats, activeChatId: undefined, projects: [], selections: {} });
}

test("files and terminals keep the folder's device instead of inheriting the scratch-device preference", async () => {
  const { terminalFolder, refreshTerminal, useTerminal, useSideTerminal } = await import("../src/lib/terminal");
  const { usePanel } = await import("../src/lib/panel");
  const project = { id: "local-project", name: "openbuild", path: "/home/imac/openbuild", git: true };
  reset({ workspace: { mode: "local", projectId: project.id, deviceId: "cachyos" } });
  useStore.setState({ projects: [project] });
  expect(terminalFolder()).toMatchObject({ cwd: project.path, deviceId: undefined });
  const chat = { ...thread("codex"), workspace: { projectId: project.id, projectName: project.name, cwd: project.path } };
  useStore.setState({ chats: [chat], activeChatId: chat.id, projects: [{ ...project, deviceId: "another-device" }] });
  refreshTerminal();
  for (const store of [usePanel, useTerminal, useSideTerminal]) {
    expect(store.getState().folder).toMatchObject({ cwd: project.path, deviceId: undefined });
  }
  useStore.setState({ chats: [{ ...chat, workspace: { ...chat.workspace, deviceId: "remote-imac" } }] });
  expect(terminalFolder()).toMatchObject({ cwd: project.path, deviceId: "remote-imac" });
  reset({ workspace: { mode: "local", deviceId: "cachyos" } });
  expect(terminalFolder()).toMatchObject({ cwd: undefined, deviceId: "cachyos" });
  useStore.setState({ projects: [{ ...project, deviceId: "remote-imac" }], settings: { ...useStore.getState().settings, workspace: { mode: "local", projectId: project.id, deviceId: "cachyos" } } });
  expect(terminalFolder()).toMatchObject({ cwd: project.path, deviceId: "remote-imac" });
  reset();
});

test("scratch threads offer a runtime picker, defaulting old settings to the Default runtime", () => {
  reset({ threadRuntime: undefined });
  const html = markup(createElement(WorkspaceTop));
  expect(html).toContain('aria-label="Thread runtime: Default"');
  expect(html).not.toContain("Local checkout");
  reset({ threadRuntime: "durable" });
  expect(markup(createElement(WorkspaceTop))).toContain('aria-label="Thread runtime: Durable"');
  reset({ threadRuntime: "codex" });
  const codex = markup(createElement(WorkspaceTop));
  expect(codex).toContain('aria-label="Thread runtime: Codex"');
  expect(codex).toContain("Native Codex");
  reset({ threadRuntime: "cursor" });
  const cursor = markup(createElement(WorkspaceTop));
  expect(cursor).toContain('aria-label="Thread runtime: Cursor"');
  expect(cursor).toContain("Native Cursor");
  reset({ threadRuntime: "claude" });
  const claude = markup(createElement(WorkspaceTop));
  expect(claude).toContain('aria-label="Thread runtime: Claude Code"');
  expect(claude).toContain("Native Claude Code");
  expect(claude).toContain('fill="#D97757"');
  reset({ threadRuntime: "opencode" });
  const opencode = markup(createElement(WorkspaceTop));
  expect(opencode).toContain('aria-label="Thread runtime: OpenCode"');
  expect(opencode).toContain("Native OpenCode");
  expect(opencode).toContain('fill-rule="evenodd"');
});

test("existing threads have a locked runtime label even before workspace preparation", () => {
  for (const runtime of [undefined, "pi", "durable", "fx", "codex", "cursor", "claude", "opencode"] as const) {
    reset({ threadRuntime: "durable" }, [thread(runtime)]);
    const html = markup(createElement(WorkspaceBelow, { chatId: "runtime-test", streaming: false }));
    expect(html).toContain(runtime === "opencode" ? "OpenCode" : runtime === "claude" ? "Claude Code" : runtime === "cursor" ? "Cursor" : runtime === "durable" ? "Durable" : runtime === "codex" ? "Codex" : runtime === "fx" ? "fx" : "Pi");
    expect(html).not.toContain('aria-haspopup="listbox"');
    expect(html).toContain("Runtime");
  }
});

test("sidebar shows each thread's runtime and filters to Pi, Durable or both", () => {
  const now = 1_700_000_000_000;
  const chat = (id: string, runtime?: Chat["runtime"]): Chat => ({ id, title: id, createdAt: now, updatedAt: now, messages: [], runtime });
  const titles = (html: string) => [...html.matchAll(/<span class="history-title-text">([^<]*)<\/span>/g)].map((m) => m[1]);
  reset({}, [chat("pi-thread", "pi"), chat("durable-thread", "durable"), chat("legacy-thread")]);

  useStore.setState((s) => ({ view: { ...s.view, runtime: "all" } }));
  let html = markup(createElement(Sidebar));
  expect(titles(html)).toEqual(["pi-thread", "durable-thread", "legacy-thread"]);
  expect(html).toContain('title="Pi runtime"');
  expect(html).toContain('title="Durable runtime"');
  // The footer's runtime switch became the usage button; the filter menu still filters by runtime.
  expect(html).not.toContain("runtime-toggle");
  expect(html).toContain('class="usage-toggle"');

  useStore.setState((s) => ({ view: { ...s.view, runtime: "pi" } }));
  html = markup(createElement(Sidebar));
  expect(titles(html)).toEqual(["pi-thread", "legacy-thread"]);
  expect(html).toContain("filter-active");

  useStore.setState((s) => ({ view: { ...s.view, runtime: "durable" } }));
  html = markup(createElement(Sidebar));
  expect(titles(html)).toEqual(["durable-thread"]);
  expect(html).not.toContain('title="Pi runtime"');
});

test("OpenCode sidebar identity and runtime filter use the shared controls", () => {
  reset({}, [{ ...thread("opencode"), title: "OpenCode thread" }, { ...thread("pi"), id: "pi-only", title: "pi-only" }]);
  useStore.setState((s) => ({ view: { ...s.view, runtime: "opencode" } }));
  const html = markup(createElement(Sidebar));
  expect(html).toContain('title="Native OpenCode runtime"');
  expect(html).toContain('history-title-text">OpenCode thread');
  expect(html).not.toContain('history-title-text">pi-only');
  useStore.setState((s) => ({ view: { ...s.view, runtime: "all" } }));
});

test("OpenCode native selection is device-scoped and never borrows Pi models or permissions", () => {
  const id = "opencode/anthropic/claude-sonnet";
  reset({ threadRuntime: "opencode", codexSelection: { plan: "codex", id: "codex/default" } });
  useStore.setState({ opencodeModels: {} });
  expect(deviceDetection(useStore.getState(), "paired", "opencode").opencode?.status).toBe("checking");
  expect(selectionFor(useStore.getState())).toBeUndefined();
  const models = [{ id, name: "Sonnet", protocol: "openai", input: ["text"], reasoning: { efforts: [], mode: "none", toggle: false } }] as any;
  useStore.setState({ opencodeModels: { "": { plan: "opencode", status: "valid", models, defaultModel: id } } });
  expect(selectionFor(useStore.getState())).toEqual({ plan: "opencode", id });
  expect(deviceDetection(useStore.getState(), "paired", "opencode").opencode?.models).toEqual([]);
  useStore.getState().setSelection({ plan: "opencode", id });
  expect(useStore.getState().settings.nativeSelections?.opencode?.[""]).toEqual({ plan: "opencode", id });
  expect(hasPermissionModes("opencode")).toBe(false);
  expect(permissionOf(useStore.getState())).toBeUndefined();
  expect(canSteer("opencode")).toBe(false);
});

test("OpenCode loads and refreshes its own models, preserving cached models on errors", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const id = "opencode/openai/gpt-test";
  const models = [{ id, name: "Test", protocol: "openai", input: ["text"], reasoning: { efforts: [], mode: "none", toggle: false } }];
  globalThis.fetch = (async (url: any) => { calls.push(String(url)); return Response.json({ models, defaultModel: id, checkedAt: 123 }); }) as typeof fetch;
  try {
    useStore.setState({ opencodeModels: {} });
    await useStore.getState().loadOpencodeModels(undefined, true);
    expect(calls).toEqual(["/api/opencode/models?fresh=1"]);
    expect(useStore.getState().opencodeModels[""]?.defaultModel).toBe(id);
    expect(useStore.getState().opencodeModels[""]?.checkedAt).toBe(123);
    globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await useStore.getState().loadOpencodeModels(undefined, true);
    expect(useStore.getState().opencodeModels[""]?.status).toBe("error");
    expect(useStore.getState().opencodeModels[""]?.models).toEqual(models as any);
  } finally { globalThis.fetch = originalFetch; reset(); }
});

test("OpenCode rejects shell commands before creating a thread", async () => {
  reset({ threadRuntime: "opencode" });
  await expect(runShell("!pwd")).rejects.toThrow("Shell commands aren't available in OpenCode threads yet.");
  expect(useStore.getState().chats).toHaveLength(0);
});

test("Durable regeneration cannot clear an existing turn", () => {
  const chat = thread("durable");
  chat.workspace = { projectId: "", projectName: "", cwd: "/tmp/runtime-ui" };
  chat.messages = [{ id: "a", role: "assistant", content: "Keep this answer", status: "error", error: "Turn failed", createdAt: 0, stream: { id: "run", via: "server" }, parts: [{ type: "text", text: "Keep this answer" }] }];
  reset({}, [chat]);
  const before = JSON.stringify(chat);
  regenerate(chat.id, "a");
  expect(JSON.stringify(useStore.getState().chats[0])).toBe(before);
});

test("native approvals reach their runtime and sensitive answers are not stored in chat", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    for (const runtime of ["codex", "fx", "cursor", "opencode"] as const) {
      const chat = thread(runtime);
      const part = { type: "ask" as const, id: "native-question", method: "input" as const, title: "Credential", secret: true };
      chat.messages = [{ id: "assistant", role: "assistant", content: "", createdAt: 0, parts: [part] }];
      reset({}, [chat]);
      const html = markup(createElement(AskCard, { part, chatId: chat.id, messageId: "assistant" }));
      expect(html).toContain('type="password"');
      expect(html).not.toContain("dictation-button");
      await answerQuestion(chat.id, "assistant", part, { value: "test-secret-value" });
      expect(JSON.stringify(useStore.getState().chats)).not.toContain("test-secret-value");
      expect(JSON.stringify(useStore.getState().chats)).toContain("[redacted]");
      expect(calls.at(-1)?.url).toContain(`/api/pi/threads/${chat.id}/answer`);
      expect(calls.at(-1)?.body.value).toBe("test-secret-value");
    }
    expect(calls.length).toBe(4);
  } finally { globalThis.fetch = originalFetch; reset(); }
});

test("OpenCode first send captures native runtime without overriding permission policy", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("workspace unavailable"); }) as unknown as typeof fetch;
  const id = "opencode/anthropic/claude-sonnet";
  try {
    reset({ threadRuntime: "opencode", naming: { enabled: false, models: [] } });
    useStore.setState({ opencodeModels: { "": { plan: "opencode", status: "valid", defaultModel: id, models: [{ id, name: "Sonnet", protocol: "openai", input: ["text"], reasoning: { efforts: [], mode: "none", toggle: false } } as any] } } });
    expect(sendMessage("hello", [])).toBe(true);
    const chat = useStore.getState().chats[0]!;
    expect(chat.runtime).toBe("opencode");
    expect(chat.permission).toBeUndefined();
    expect(chat.messages.at(-1)?.model?.plan).toBe("opencode");
    await Bun.sleep(20);
    useStore.getState().updateSettings({ threadRuntime: "pi" });
    regenerate(chat.id, chat.messages.at(-1)!.id);
    await Bun.sleep(20);
    expect(useStore.getState().chats[0]?.runtime).toBe("opencode");
  } finally { globalThis.fetch = originalFetch; reset(); }
});

test("runtime is captured before workspace failure and survives settings changes, retries and sends", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("workspace unavailable"); }) as unknown as typeof fetch;
  const model = { id: "test/model", name: "Test", protocol: "openai", input: ["text"], reasoning: { efforts: [], mode: "none", toggle: false } } as const;
  try {
    reset({ threadRuntime: "durable", selection: { plan: "pi", id: model.id }, naming: { enabled: false, models: [] } });
    useStore.setState({ detection: { pi: { plan: "pi", status: "valid", models: [model as any] } } });
    expect(sendMessage("hello", [])).toBe(true);
    const chat = useStore.getState().chats[0]!;
    expect(chat.runtime).toBe("durable");
    await Bun.sleep(20);
    expect(useStore.getState().chats[0]?.messages.at(-1)?.status).toBe("error");
    useStore.getState().updateSettings({ threadRuntime: "pi" });
    regenerate(chat.id, chat.messages.at(-1)!.id);
    await Bun.sleep(20);
    expect(useStore.getState().chats[0]?.runtime).toBe("durable");
    expect(sendMessage("again", [], chat.id)).toBe(true);
    await Bun.sleep(20);
    expect(useStore.getState().chats[0]?.runtime).toBe("durable");

    reset({ threadRuntime: "durable", selection: { plan: "pi", id: model.id } }, [thread()]);
    expect(sendMessage("legacy", [], "runtime-test")).toBe(true);
    await Bun.sleep(20);
    expect(useStore.getState().chats[0]?.runtime).toBe("pi");
  } finally {
    globalThis.fetch = originalFetch;
    reset();
  }
});
}
