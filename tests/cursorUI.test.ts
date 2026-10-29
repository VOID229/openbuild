import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelInfo } from "../shared/types";
import type { Chat, Settings } from "../src/lib/types";

if (process.env.OPENBUILD_CURSOR_UI_CHILD !== "1") {
  test("Cursor frontend (isolated browser)", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, OPENBUILD_CURSOR_UI_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
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
    if (String(url) === "/api/config") return Response.json({ mode: "local", serverId: "cursor-ui" });
    return Response.json({});
  }) as typeof fetch;
  const { config } = await import("../src/lib/runtime");
  await config;
  const { useStore, deviceDetection, selectionFor, composerEffort } = await import("../src/lib/store");
  const { WorkspaceTop, WorkspaceBelow } = await import("../src/components/Workspace");
  const { Sidebar } = await import("../src/components/Sidebar");
  const { EffortPicker, ModelPicker, PermissionPicker } = await import("../src/components/Pickers");
  const { sendMessage, regenerate, resumeReplies, steerQueued } = await import("../src/lib/chat");
  const { runShell } = await import("../src/lib/shell");
  const { providerSvg } = await import("../src/lib/models");
  const { usePlugins } = await import("../src/lib/plugins");
  await usePlugins.getState().refresh();
  const base = useStore.getState().settings;
  const model = (id: string, efforts: ModelInfo["reasoning"]["efforts"] = ["low", "high"]): ModelInfo => ({ id: `cursor/${id}`, name: id, protocol: "chat", input: ["text"], reasoning: { efforts, mode: "effort", toggle: false } });
  const local = model("local");
  const remote = model("remote");
  function reset(settings: Partial<Settings> = {}, chats: Chat[] = []) {
    useStore.setState({ settings: { ...base, threadRuntime: "cursor", workspace: { mode: "local" }, naming: { enabled: false, models: [] }, ...settings }, chats, activeChatId: undefined, draftPermission: undefined, permissionModes: {}, selections: {}, projects: [], settingsOpen: false, cursorModels: {}, codexModels: {}, fxModels: {} });
  }
  function markup(element: Parameters<typeof renderToStaticMarkup>[0]) {
    const initial = useStore.getInitialState();
    const saved = { ...initial };
    Object.assign(initial, useStore.getState());
    try { return renderToStaticMarkup(element); }
    finally { Object.assign(initial, saved); }
  }
  const listing = (m: ModelInfo) => ({ plan: "cursor" as const, status: "valid" as const, models: [m], defaultModel: m.id, checkedAt: Date.now() });
  const ndjson = (...events: unknown[]) => new Response(events.map((ev) => JSON.stringify(ev)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson", "x-openchat-run": "1" } });
  async function settled() {
    for (let i = 0; i < 100; i++) {
      if (!useStore.getState().chats.some((c) => c.messages.some((m) => m.status === "streaming"))) return;
      await Bun.sleep(10);
    }
    throw new Error("Reply did not settle");
  }

  test("Cursor selector, locked label and sidebar use Cursor branding", () => {
    reset();
    const html = markup(createElement(WorkspaceTop));
    expect(html).toContain('aria-label="Thread runtime: Cursor"');
    expect(html).toContain("Native Cursor");
    expect(providerSvg("cursor")).toContain("M11.93 2");
    expect(html).toContain("M11.93 2");
    expect(html).not.toContain("pi-mark");
    const chat: Chat = { id: "cursor-thread", title: "Cursor thread", runtime: "cursor", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    reset({}, [chat]);
    const locked = markup(createElement(WorkspaceBelow, { chatId: chat.id, streaming: false }));
    expect(locked).toContain("Cursor");
    expect(locked).toContain("No Pi extensions");
    expect(locked).not.toContain('aria-haspopup="listbox"');
    useStore.setState((s) => ({ view: { ...s.view, runtime: "cursor" } }));
    expect(markup(createElement(Sidebar))).toContain('title="Native Cursor runtime"');
  });

  test("Permission picker lists the runtime's own modes, is thread-scoped and hidden for other runtimes", () => {
    reset();
    const modes = { modes: [{ id: "default", name: "Configured", description: "Cursor's own allowlist" }, { id: "mode:plan", name: "Plan" }, { id: "force", name: "Run everything", description: "Force allow commands" }], defaultMode: "default", status: "valid" as const, checkedAt: Date.now() };
    useStore.setState({ permissionModes: { "cursor||": modes } });
    const bar = () => markup(createElement(PermissionPicker, { dropUp: false }));
    expect(bar()).toContain('aria-label="Permissions: Configured"');
    useStore.getState().setPermission("force");
    expect(bar()).toContain('aria-label="Permissions: Run everything"');
    expect(bar()).toContain("permission-risky");
    useStore.getState().newChat();
    expect(useStore.getState().draftPermission).toBeUndefined();
    for (const runtime of ["pi", "durable", "fx"] as const) {
      useStore.getState().updateSettings({ threadRuntime: runtime });
      expect(bar()).toBe("");
    }
    // Legacy "Allow all tools" threads read as Run everything; picking Default clears both.
    const chats: Chat[] = [true, false].map((allowed, i) => ({ id: `permission-${i}`, title: "Cursor", runtime: "cursor", cursorAllowAllTools: allowed, createdAt: 0, updatedAt: 0, messages: [] }));
    reset({}, JSON.parse(JSON.stringify(chats)));
    useStore.setState({ permissionModes: { "cursor||": modes } });
    expect(markup(createElement(PermissionPicker, { dropUp: false, chatId: chats[0]!.id }))).toContain("Run everything");
    expect(markup(createElement(PermissionPicker, { dropUp: false, chatId: chats[1]!.id }))).toContain("Configured");
    useStore.getState().setPermission(undefined, chats[0]!.id);
    expect(useStore.getState().chats.every((c) => !c.cursorAllowAllTools && !c.permission)).toBe(true);
  });

  test("Permission choice is serialized, restored independently, and sent only while picked", async () => {
    reset();
    useStore.setState({ cursorModels: { "": listing(local) } });
    const posts: any[] = [];
    const saved = new Map<string, Chat>();
    globalThis.fetch = (async (url: any, init: any) => {
      const path = String(url);
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (path.startsWith("/api/chats/") && init?.method === "PUT") saved.set(body.id, body);
      if (path.endsWith("/api/workspaces")) return Response.json({ workspace: { projectId: "", projectName: "", cwd: "/tmp/cursor-ui" } });
      if (path.endsWith("/api/pi/chat")) { posts.push(body); return ndjson({ t: "text", v: "OK" }, { t: "end" }); }
      return Response.json({});
    }) as typeof fetch;
    useStore.getState().setPermission("force");
    expect(sendMessage("first", [])).toBe(true);
    await settled();
    const first = useStore.getState().chats[0]!;
    expect(posts.at(-1).permission).toBe("force");
    expect(posts.at(-1).cursorAllowAllTools).toBeUndefined();
    expect(saved.get(first.id)?.permission).toBe("force");
    expect(useStore.getState().draftPermission).toBeUndefined();
    // Reload from the serialized chat; a new thread never inherits the choice.
    useStore.getState().setChats([JSON.parse(JSON.stringify(saved.get(first.id)))]);
    useStore.getState().newChat();
    expect(sendMessage("independent", [])).toBe(true);
    await settled();
    const second = useStore.getState().chats.find((c) => c.id !== first.id)!;
    expect(posts.at(-1).permission).toBeUndefined();
    useStore.getState().selectChat(first.id);
    expect(sendMessage("still picked", [])).toBe(true);
    await settled();
    expect(posts.at(-1).permission).toBe("force");
    useStore.getState().setPermission("mode:plan", first.id);
    expect(sendMessage("plan", [])).toBe(true);
    await settled();
    expect(posts.at(-1).permission).toBe("mode:plan");
    useStore.getState().setPermission(undefined, first.id);
    expect(sendMessage("default", [])).toBe(true);
    await settled();
    expect(posts.at(-1).permission).toBeUndefined();
    expect(saved.get(first.id)?.permission).toBeUndefined();
    expect(useStore.getState().chats.find((c) => c.id === second.id)?.permission).toBeUndefined();
    // A stale field on a runtime without permission modes must not be sent.
    useStore.getState().upsertChat({ ...useStore.getState().chats.find((c) => c.id === first.id)!, runtime: "fx", permission: "force", cursorAllowAllTools: true });
    useStore.setState({ fxModels: { "": { ...listing(local), plan: "fx" } } });
    expect(sendMessage("other runtime", [])).toBe(true);
    await settled();
    expect(posts.at(-1).runtime).toBe("fx");
    expect(posts.at(-1).permission).toBeUndefined();
    expect(posts.at(-1).cursorAllowAllTools).toBeUndefined();
  });

  test("Cursor lists models directly on each device, retains cached data on errors", async () => {
    reset();
    const calls: string[] = [];
    globalThis.fetch = (async (url: any) => {
      calls.push(String(url));
      return Response.json({ models: [String(url).includes("/devices/") ? remote : local], defaultModel: String(url).includes("/devices/") ? remote.id : local.id, checkedAt: 123 });
    }) as typeof fetch;
    expect(deviceDetection(useStore.getState(), "mac", "cursor").cursor?.status).toBe("checking");
    await useStore.getState().loadCursorModels();
    await useStore.getState().loadCursorModels("mac", true);
    expect(calls).toEqual(["/api/cursor/models", "/api/devices/mac/api/cursor/models?fresh=1"]);
    expect(deviceDetection(useStore.getState(), "mac", "cursor").cursor?.models).toEqual([remote]);
    globalThis.fetch = (async () => Response.json({ error: "Sign in to Cursor" }, { status: 401 })) as unknown as typeof fetch;
    await useStore.getState().loadCursorModels("mac", true);
    const cached = useStore.getState().cursorModels.mac!;
    expect(cached.status).toBe("error");
    expect(cached.models).toEqual([remote]);
    expect(cached.defaultModel).toBe(remote.id);
    expect(cached.error).toContain("Sign in to Cursor");
  });

  test("native preferences persist separately per runtime and device; efforts follow metadata", () => {
    reset();
    const shared = model("shared");
    useStore.setState({ cursorModels: { "": { ...listing(local), models: [local, shared] }, mac: { ...listing(remote), models: [remote, shared] } } });
    useStore.getState().setSelection({ plan: "cursor", id: shared.id });
    expect(selectionFor(useStore.getState())).toEqual({ plan: "cursor", id: shared.id });
    useStore.getState().updateSettings({ workspace: { mode: "local", deviceId: "mac" } });
    expect(selectionFor(useStore.getState())).toEqual({ plan: "cursor", id: remote.id });
    useStore.getState().setSelection({ plan: "cursor", id: shared.id });
    useStore.getState().setSelection({ plan: "cursor", id: remote.id });
    useStore.getState().setEffort("high");
    expect(composerEffort(useStore.getState())).toBe("high");
    expect(markup(createElement(EffortPicker, { dropUp: false, deviceId: "mac" }))).toContain("Reasoning effort");
    const saved = JSON.parse(JSON.stringify(useStore.getState().settings));
    reset(saved);
    useStore.setState({ cursorModels: { "": { ...listing(local), models: [local, shared] }, mac: listing(remote) } });
    expect(selectionFor(useStore.getState())).toEqual({ plan: "cursor", id: remote.id });
    useStore.getState().updateSettings({ workspace: { mode: "local" } });
    expect(selectionFor(useStore.getState())).toEqual({ plan: "cursor", id: shared.id });
    useStore.getState().updateSettings({ threadRuntime: "codex" });
    expect(selectionFor(useStore.getState())).toBeUndefined();
    useStore.getState().updateSettings({ threadRuntime: "cursor" });
    useStore.setState({ cursorModels: { "": listing(model("fixed", [])) } });
    const fixed = markup(createElement(EffortPicker, { dropUp: false }));
    expect(fixed).toContain('aria-disabled="true"');
    expect(fixed).toContain("uses its default reasoning");
  });

  test("empty Cursor model UI never opens API-key setup", () => {
    reset();
    useStore.setState({ cursorModels: { "": { plan: "cursor", status: "valid", models: [] } } });
    expect(markup(createElement(ModelPicker, { dropUp: false }))).toContain("Set up Cursor");
    expect(sendMessage("hello", [])).toBe(false);
    expect(useStore.getState().settingsOpen).toBe(false);
  });

  test("Cursor sends runtime/model/metadata effort without API keys and resumes on its device", async () => {
    reset({ workspace: { mode: "local", deviceId: "mac" }, effort: "high" });
    useStore.setState({ cursorModels: { mac: listing(remote) } });
    const requests: { url: string; body?: any }[] = [];
    globalThis.fetch = (async (url: any, init: any) => {
      const path = String(url);
      requests.push({ url: path, body: init?.body ? JSON.parse(init.body) : undefined });
      if (path.endsWith("/api/workspaces")) return Response.json({ workspace: { projectId: "", projectName: "", cwd: "/tmp/cursor-ui" } });
      if (path.endsWith("/api/pi/chat")) return ndjson({ t: "text", v: "Cursor answer" }, { t: "end" });
      if (path.includes("/api/chat/runs/")) return ndjson({ t: "text", v: "Recovered Cursor answer" }, { t: "end" });
      return Response.json({});
    }) as typeof fetch;
    expect(sendMessage("hello", [])).toBe(true);
    await settled();
    let chat = useStore.getState().chats[0]!;
    expect(chat.runtime).toBe("cursor");
    expect(chat.messages.at(-1)?.content).toBe("Cursor answer");
    const post = requests.find((r) => r.url.endsWith("/api/pi/chat"))!;
    expect(post.url).toBe("/api/devices/mac/api/pi/chat");
    expect(post.body.runtime).toBe("cursor");
    expect(post.body.model).toBe(remote.id);
    expect(post.body.effort).toBe("high");
    expect(post.body.keys).toBeUndefined();
    expect(post.body.cursorAllowAllTools).toBeUndefined();
    expect(post.body.permission).toBeUndefined();
    expect(chat.permission).toBeUndefined();
    // Reconnect needs neither the model listing nor a fresh workspace/POST.
    const reply = chat.messages.at(-1)!;
    useStore.getState().patchMessage(chat.id, reply.id, { status: "streaming", stream: { ...reply.stream!, via: "cursor-ui", deviceId: "mac" } });
    useStore.setState({ cursorModels: {} });
    const before = requests.length;
    resumeReplies(chat.id);
    await settled();
    chat = useStore.getState().chats[0]!;
    expect(chat.messages.at(-1)?.content).toBe("Recovered Cursor answer");
    expect(requests.slice(before).filter((r) => r.url.includes("/api/chat/runs/"))).toHaveLength(1);
    expect(requests.slice(before).some((r) => r.url.endsWith("/api/pi/chat"))).toBe(false);
  });

  test("Cursor cannot rewind completed turns, run shell commands, or steer Pi", async () => {
    const chat: Chat = { id: "restricted", title: "Cursor", runtime: "cursor", createdAt: 0, updatedAt: 0, workspace: { projectId: "", projectName: "", cwd: "/tmp/cursor-ui" }, messages: [{ id: "a", role: "assistant", content: "Keep", createdAt: 0, status: "done", model: { plan: "cursor", id: local.id, name: local.name } }] };
    reset({}, [chat]);
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
    regenerate(chat.id, "a");
    expect(useStore.getState().chats[0]?.messages[0]?.content).toBe("Keep");
    await expect(runShell("!pwd", chat.id)).rejects.toThrow("Cursor threads");
    await steerQueued(chat.id, "missing");
    expect(calls).toBe(0);
  });
}
