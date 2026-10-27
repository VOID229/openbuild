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

const { useStore } = await import("../src/lib/store");
const { WorkspaceTop, WorkspaceBelow } = await import("../src/components/Workspace");
const { Sidebar } = await import("../src/components/Sidebar");
const { sendMessage, regenerate } = await import("../src/lib/chat");
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

test("scratch threads offer a runtime picker, defaulting old settings to the Default runtime", () => {
  reset({ threadRuntime: undefined });
  const html = markup(createElement(WorkspaceTop));
  expect(html).toContain('aria-label="Thread runtime: Default"');
  expect(html).not.toContain("Local checkout");
  reset({ threadRuntime: "durable" });
  expect(markup(createElement(WorkspaceTop))).toContain('aria-label="Thread runtime: Durable"');
});

test("existing threads have a locked runtime label even before workspace preparation", () => {
  for (const runtime of [undefined, "pi", "durable"] as const) {
    reset({ threadRuntime: "durable" }, [thread(runtime)]);
    const html = markup(createElement(WorkspaceBelow, { chatId: "runtime-test", streaming: false }));
    expect(html).toContain(runtime === "durable" ? "Durable" : "Pi");
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

test("Durable regeneration cannot clear an existing turn", () => {
  const chat = thread("durable");
  chat.workspace = { projectId: "", projectName: "", cwd: "/tmp/runtime-ui" };
  chat.messages = [{ id: "a", role: "assistant", content: "Keep this answer", status: "error", error: "Turn failed", createdAt: 0, stream: { id: "run", via: "server" }, parts: [{ type: "text", text: "Keep this answer" }] }];
  reset({}, [chat]);
  const before = JSON.stringify(chat);
  regenerate(chat.id, "a");
  expect(JSON.stringify(useStore.getState().chats[0])).toBe(before);
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
