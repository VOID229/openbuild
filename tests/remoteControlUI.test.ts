import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelInfo } from "../shared/types";
import type { Chat, Settings } from "../src/lib/types";

if (process.env.OPENBUILD_REMOTE_CONTROL_UI_CHILD !== "1") {
  test("Remote Control frontend (isolated browser)", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, OPENBUILD_REMOTE_CONTROL_UI_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
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
    if (String(url) === "/api/config") return Response.json({ mode: "local", serverId: "remote-control-ui" });
    return Response.json({});
  }) as typeof fetch;
  const { config } = await import("../src/lib/runtime");
  await config;
  const { useStore } = await import("../src/lib/store");
  const { RemoteControlPicker } = await import("../src/components/Pickers");
  const { sendMessage } = await import("../src/lib/chat");
  const { codexDaemon } = await import("../src/lib/pi");
  const base = useStore.getState().settings;
  const model = (runtime: string): ModelInfo => ({ id: `${runtime}/one`, name: "One", protocol: "chat", input: ["text"], reasoning: { efforts: ["low", "high"], mode: "effort", toggle: false } });
  const listing = (plan: "claude" | "cursor") => ({ "": { plan, status: "valid" as const, models: [model(plan)], defaultModel: `${plan}/one`, checkedAt: Date.now() } });
  function reset(settings: Partial<Settings> = {}, chats: Chat[] = []) {
    useStore.setState({ settings: { ...base, threadRuntime: "claude", workspace: { mode: "local" }, naming: { enabled: false, models: [] }, ...settings }, chats, activeChatId: undefined, permissionModes: {}, selections: {}, projects: [], settingsOpen: false, draftRemoteControl: false, claudeModels: listing("claude"), cursorModels: listing("cursor") });
  }
  function markup(element: Parameters<typeof renderToStaticMarkup>[0]) {
    const initial = useStore.getInitialState();
    const saved = { ...initial };
    Object.assign(initial, useStore.getState());
    try { return renderToStaticMarkup(element); }
    finally { Object.assign(initial, saved); }
  }
  const pill = (chatId?: string) => markup(createElement(RemoteControlPicker, { dropUp: false, chatId }));
  const ndjson = (...events: unknown[]) => new Response(events.map((ev) => JSON.stringify(ev)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson", "x-openchat-run": "1" } });
  async function settled() {
    for (let i = 0; i < 100; i++) {
      if (!useStore.getState().chats.some((c) => c.messages.some((m) => m.status === "streaming"))) return;
      await Bun.sleep(10);
    }
    throw new Error("reply never settled");
  }

  test("each harness gets its own Remote Control control, not one generic toggle", () => {
    reset();
    expect(pill()).toContain("Remote off");
    useStore.getState().setDraftRemoteControl(true);
    expect(pill()).toContain("Remote on");
    // Codex and Cursor can't be switched per thread: the pill says where it's set instead.
    useStore.getState().updateSettings({ threadRuntime: "codex" });
    expect(pill()).toContain("Remote · machine");
    expect(pill()).toContain('aria-haspopup="dialog"');
    useStore.getState().updateSettings({ threadRuntime: "cursor" });
    expect(pill()).toContain("Remote · account");
    for (const runtime of ["pi", "durable", "fx", "opencode"] as const) {
      useStore.getState().updateSettings({ threadRuntime: runtime });
      expect(pill()).toBe("");
    }
    // An existing thread shows only a Claude Code opt-in it started with.
    const chats: Chat[] = [
      { id: "on", title: "On", runtime: "claude", remoteControl: true, createdAt: 0, updatedAt: 0, messages: [] },
      { id: "off", title: "Off", runtime: "claude", createdAt: 0, updatedAt: 0, messages: [] },
      { id: "codex", title: "Codex", runtime: "codex", createdAt: 0, updatedAt: 0, messages: [] },
    ];
    reset({}, chats);
    expect(pill("on")).toContain("Remote on");
    expect(pill("on")).not.toContain("<button");
    expect(pill("off")).toBe("");
    expect(pill("codex")).toBe("");
  });

  test("the opt-in is saved on the thread it started, sent every turn, and off for the next thread", async () => {
    reset();
    const posts: any[] = [];
    const saved = new Map<string, Chat>();
    globalThis.fetch = (async (url: any, init: any) => {
      const path = String(url);
      const body = init?.body ? JSON.parse(init.body) : undefined;
      if (path.startsWith("/api/chats/") && init?.method === "PUT") saved.set(body.id, body);
      if (path.endsWith("/api/workspaces")) return Response.json({ workspace: { projectId: "", projectName: "", cwd: "/tmp/remote-control-ui" } });
      if (path.endsWith("/api/pi/chat")) { posts.push(body); return ndjson({ t: "text", v: "OK" }, { t: "end" }); }
      return Response.json({});
    }) as typeof fetch;
    // Default off: nothing is sent.
    expect(sendMessage("plain", [])).toBe(true);
    await settled();
    const plain = useStore.getState().chats[0]!;
    expect(posts.at(-1).runtime).toBe("claude");
    expect(posts.at(-1).remoteControl).toBeUndefined();
    expect(plain.remoteControl).toBeUndefined();

    useStore.getState().newChat();
    useStore.getState().setDraftRemoteControl(true);
    expect(sendMessage("remote", [])).toBe(true);
    await settled();
    const remote = useStore.getState().chats.find((c) => c.id !== plain.id)!;
    expect(posts.at(-1).remoteControl).toBe(true);
    expect(remote.remoteControl).toBe(true);
    const { saveChatBeforeRun } = await import("../src/lib/db");
    await saveChatBeforeRun(remote);
    expect(saved.get(remote.id)?.remoteControl).toBe(true);
    // Used up by that thread: the composer is back to off.
    expect(useStore.getState().draftRemoteControl).toBe(false);
    expect(sendMessage("follow-up", [], remote.id)).toBe(true);
    await settled();
    expect(posts.at(-1)).toMatchObject({ threadId: remote.id, remoteControl: true });

    useStore.getState().newChat();
    expect(sendMessage("next", [])).toBe(true);
    await settled();
    expect(posts.at(-1).remoteControl).toBeUndefined();

    // A draft opt-in left on doesn't leak into a harness without a per-thread switch.
    useStore.getState().newChat();
    useStore.getState().setDraftRemoteControl(true);
    useStore.getState().updateSettings({ threadRuntime: "cursor" });
    expect(sendMessage("cursor", [])).toBe(true);
    await settled();
    expect(posts.at(-1).runtime).toBe("cursor");
    expect(posts.at(-1).remoteControl).toBeUndefined();
    expect(useStore.getState().chats.find((c) => c.runtime === "cursor")?.remoteControl).toBeUndefined();
  });

  test("starting over clears a draft opt-in", () => {
    reset();
    useStore.getState().setDraftRemoteControl(true);
    useStore.getState().newChat();
    expect(useStore.getState().draftRemoteControl).toBe(false);
  });

  test("the Codex pill asks the device for its daemon, never a thread", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: any) => { urls.push(String(url)); return Response.json({ installed: true, status: "running", checkedAt: 1 }); }) as typeof fetch;
    expect(await codexDaemon()).toMatchObject({ status: "running" });
    expect(urls).toEqual(["/api/codex/status/remote-control"]);
  });
}
