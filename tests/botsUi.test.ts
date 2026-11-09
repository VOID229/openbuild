import { expect, test } from "bun:test";

// Keep browser/store mocks isolated from the other suites.
test("bots mutations await acknowledgement, reconcile failures, serialize writes and load history", async () => {
  const script = `
    import { mock } from "bun:test";
    import { resolve } from "node:path";
    import assert from "node:assert/strict";
    mock.module(resolve("src/lib/store.ts"), () => ({ useStore: { getState: () => ({ settings: { profile: {} } }) } }));
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const { useBots, enterWorkspace } = await import(resolve("src/lib/bots/store.ts"));
    const { useWorkspace } = await import(resolve("src/lib/bots/workspace.ts"));
    useWorkspace.setState({ localId: "srv", localName: "Studio" });
    enterWorkspace("srv");
    const c = { id: "chat", kind: "direct", botIds: ["bot"], createdAt: 1, updatedAt: 1, messages: [{ id: "latest", author: "me", text: "hello", at: 1 }], more: true };
    const snapshot = { bots: [], conversations: [c], settings: { sections: [] }, typing: {}, drafts: [], status: {} };
    useBots.setState({ conversations: [c] });
    const calls = [];
    let ack;
    globalThis.fetch = async (path, init) => {
      calls.push([path, init]);
      if (path === "/api/workspace/to/srv/api/bots") return Response.json(snapshot, { headers: { "x-openbuild-server": "srv" } });
      return new Promise((r) => { ack = r; });
    };
    const first = useBots.getState().post("chat", { author: "me", text: "retain me" });
    let settled = false;
    first.then(() => settled = true);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(settled, false);
    assert.equal(useBots.getState().pending, 1);
    ack(new Response("forbidden", { status: 403 }));
    assert.equal(await first, undefined);
    assert.equal(useBots.getState().conversations[0].messages.length, 1);
    assert.match(useBots.getState().error, /not confirmed.*forbidden/);
    assert.equal(useBots.getState().pending, 0);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.equal(await useBots.getState().post("chat", { author: "me", text: "offline" }), undefined);
    assert.equal(useBots.getState().conversations[0].messages.length, 1);
    assert.match(useBots.getState().error, /offline/);
    const requests = [];
    const resolvers = [];
    globalThis.fetch = async (path, init) => {
      requests.push([path, init]);
      return new Promise((r) => resolvers.push(r));
    };
    const a = useBots.getState().post("chat", { author: "me", text: "one" });
    const b = useBots.getState().post("chat", { author: "me", text: "two" });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(requests.length, 1);
    resolvers[0](Response.json({ ok: true }));
    assert.equal((await a).text, "one");
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(requests.length, 2);
    resolvers[1](Response.json({ ok: true }));
    assert.equal((await b).text, "two");
    globalThis.fetch = async (path, init) => {
      requests.push([path, init]);
      if (path.includes("beforeId")) return Response.json({ messages: [{ id: "old", author: "me", text: "old", at: 0 }, c.messages[0]], more: false });
      return Response.json({ ok: true });
    };
    await useBots.getState().loadOlder("chat");
    assert.ok(requests.at(-1)[0].endsWith("?beforeId=latest"));
    assert.deepEqual(useBots.getState().conversations[0].messages.map((m) => m.id).slice(0, 2), ["old", "latest"]);
    assert.equal(useBots.getState().conversations[0].more, false);
    useBots.getState().updateConversation("chat", { section: undefined, pinnedAt: undefined });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(JSON.parse(requests.at(-1)[1].body), { section: null, pinnedAt: null });
    globalThis.fetch = async (path) => {
      if (path === "/api/workspace/to/srv/api/bots/stream") return new Response(new ReadableStream({ start(controller) {
        const events = [
          { t: "hello", workspace: "srv" },
          { t: "snapshot", ...snapshot },
          { t: "message", conversationId: "chat", message: { id: "confirmed-after-snapshot", author: "me", text: "saved", at: 2 } },
          { t: "status", botId: "bot", status: { state: "error", conversationId: "chat", error: "provider failed" } },
        ];
        controller.enqueue(new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join("\\n") + "\\n"));
      } }));
      return Response.json({ ok: true });
    };
    useBots.getState().ensureSeeded();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(useBots.getState().status.bot.error, "provider failed");
    globalThis.fetch = async () => { throw new Error("offline again"); };
    await useBots.getState().post("chat", { author: "me", text: "not saved" });
    assert.deepEqual(useBots.getState().conversations[0].messages.map((m) => m.id), ["latest", "confirmed-after-snapshot"]);
    console.log("ok");
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(stdout.trim()).toBe("ok");
});

test("an update to a message from before the loaded ones doesn't land at the bottom of the chat", async () => {
  const script = `
    import { mock } from "bun:test";
    import { resolve } from "node:path";
    import assert from "node:assert/strict";
    mock.module(resolve("src/lib/store.ts"), () => ({ useStore: { getState: () => ({ settings: { profile: {} } }) } }));
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const { useBots, enterWorkspace } = await import(resolve("src/lib/bots/store.ts"));
    const { useWorkspace } = await import(resolve("src/lib/bots/workspace.ts"));
    useWorkspace.setState({ localId: "srv", localName: "Studio" });
    enterWorkspace("srv");
    const group = { id: "group", kind: "group", name: "G", botIds: ["a", "b"], createdAt: 1, updatedAt: 30, more: true, messages: [
      { id: "m20", author: "me", text: "recent", at: 20 },
      { id: "m30", author: "a", text: "latest", at: 30 },
    ] };
    const snapshot = { bots: [], conversations: [group], settings: { sections: [] }, typing: {}, drafts: [], status: {} };
    globalThis.fetch = async (path) => {
      if (path === "/api/workspace/to/srv/api/bots/stream") return new Response(new ReadableStream({ start(controller) {
        const events = [
          { t: "hello", workspace: "srv" },
          { t: "snapshot", ...snapshot },
          // Waking on @all, a bot marks an early prompt seen and votes on an old, closed poll.
          { t: "message", conversationId: "group", message: { id: "m1", author: "me", text: "early prompt", at: 1, seenBy: ["b"] } },
          { t: "message", conversationId: "group", message: { id: "m5", author: "a", text: "", at: 5, poll: { question: "Old?", options: [] } } },
          { t: "message", conversationId: "group", message: { id: "m25", author: "b", text: "in between", at: 25 } },
          { t: "message", conversationId: "group", message: { id: "m40", author: "b", text: "new", at: 40 } },
        ];
        controller.enqueue(new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join("\\n") + "\\n"));
      } }));
      return Response.json({ ok: true });
    };
    useBots.getState().ensureSeeded();
    await new Promise((r) => setTimeout(r, 10));
    const c = useBots.getState().conversations[0];
    assert.deepEqual(c.messages.map((m) => m.id), ["m20", "m25", "m30", "m40"]);
    assert.equal(c.updatedAt, 40);
    console.log("ok");
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(stdout.trim()).toBe("ok");
});

test("bots paint from the cache, then the server's snapshot replaces it and is cached in turn", async () => {
  const script = `
    import { mock } from "bun:test";
    import { resolve } from "node:path";
    import assert from "node:assert/strict";
    mock.module(resolve("src/lib/store.ts"), () => ({ useStore: { getState: () => ({ settings: { profile: {} } }) } }));
    const KEY = "openchat-kv:openbuild-bots/cache:snapshot:srv";
    const saved = new Map();
    globalThis.localStorage = { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k) };
    const chat = (id, count) => ({ id, kind: "direct", botIds: ["bot"], createdAt: 1, updatedAt: 1, messages: Array.from({ length: count }, (_, i) => ({ id: id + i, author: "me", text: "", at: i })) });
    saved.set(KEY, JSON.stringify({ bots: [{ id: "bot" }], conversations: [chat("cached", 1)], sections: ["work"] }));
    const { preloadBots, useBots } = await import(resolve("src/lib/bots/store.ts"));
    const { useWorkspace } = await import(resolve("src/lib/bots/workspace.ts"));
    useWorkspace.setState({ localId: "srv", localName: "Studio" });
    const paths = [];
    let answer;
    globalThis.fetch = async (path) => {
      paths.push(path);
      await new Promise((r) => { answer = r; });
      return Response.json({ bots: [], conversations: [chat("fresh", 60)], settings: { sections: [] }, typing: {}, drafts: [], status: {} }, { headers: { "x-openbuild-server": "srv" } });
    };

    // The cached copy shows without the server, and isn't mistaken for the server's state.
    await preloadBots();
    assert.equal(useBots.getState().activeId, "cached");
    assert.deepEqual(useBots.getState().sections, ["work"]);
    assert.equal(useBots.getState().loaded, false);
    assert.equal(useBots.getState().connected, true);
    // Preloading holds no connection open.
    assert.deepEqual(paths, ["/api/workspace/to/srv/api/bots"]);

    answer();
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(useBots.getState().loaded, true);
    assert.equal(useBots.getState().activeId, "fresh");
    assert.equal(useBots.getState().conversations[0].messages.length, 60);
    const cached = JSON.parse(saved.get(KEY));
    assert.equal(cached.conversations[0].messages.length, 50);
    assert.equal(cached.conversations[0].more, true);

    // A preload that loses the race to newer state, or the cache, must not put older state back.
    const late = preloadBots();
    await late;
    assert.equal(useBots.getState().activeId, "fresh");
    useBots.setState({ conversations: [chat("newer", 1)], activeId: "newer" });
    answer();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(useBots.getState().activeId, "newer");
    console.log("ok");
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(stdout.trim()).toBe("ok");
});

// The composer clearing at once, and a failed send coming back, are tested in a real Chrome (botComposerSend.test.ts).
test("routine/memory actions do not fabricate bot events", async () => {
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  const details = await Bun.file("src/components/bots/BotDetails.tsx").text();
  // The overflow menu is gone, so the "ask it to remember" shortcut went with it.
  expect(chat).not.toContain("Please remember this:");
  expect(chat).not.toContain('author: directBot.id, text: "", event:');
  expect(details).not.toContain('author: bot.id, text: "", event:');
});

test("thread activity details are titles, so bot names inside them don't become bot links", async () => {
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  expect(chat).toContain('m.event!.threadId || m.event!.kind === "thread" ? <EventThread event={m.event!} /> : eventBot');
  expect(chat).toContain("id ? <ThreadLink id={id}>{title}</ThreadLink> : <>{title}</>");
});

test("a bot's activity line names the bot that did it, by author id; the user's lines keep their wording", async () => {
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  expect(chat).toContain('const author = m.author === "me" ? undefined : bots.find((x) => x.id === m.author);');
  expect(chat).toContain("const authored = author && !namesBot(eventText(m.event!), bots) ? authoredEventText(m.event!) : undefined;");
  expect(chat).toContain("{authored ? <><BotLink bot={author!} /> {authored}</> : messaged ? <MessageActivity event={m.event!} other={messaged} /> : switcher ? <><BotLink bot={switcher} /> switched to {switchedTo}</> : changed ? <><BotLink bot={eventBot!} />'s {changed}</> : <WithBotLinks text={eventText(m.event!)} bots={bots} />}");
  const { authoredEventText } = await import("../shared/bots");
  expect(authoredEventText({ kind: "thread", text: "Merged a pull request" })).toBe("merged a pull request");
  expect(authoredEventText({ kind: "thread", text: "Wrote a prompt" })).toBe("wrote a prompt in");
  expect(authoredEventText({ kind: "routine", text: "Routine", detail: "Standup · 9:00" })).toBe("set a routine");
  expect(authoredEventText({ kind: "routine", text: "Routine", detail: "Standup" })).toBe("ran a routine");
  expect(authoredEventText({ kind: "error", text: "PR checks failed" })).toBe("PR checks failed");
  for (const kind of ["message", "model", "poll"]) expect(authoredEventText({ kind, text: "Anything" })).toBeUndefined();
  expect(authoredEventText({ kind: "error", text: "Paused" })).toBeUndefined();
});

test("older follow-up prompts read with the current wording", async () => {
  const { eventText } = await import("../shared/bots");
  expect(eventText({ text: "Wrote to a thread" })).toBe("Wrote a prompt in");
  expect(eventText({ text: "Wrote a prompt" })).toBe("Wrote a prompt in");
  expect(eventText({ text: "Wrote a prompt in" })).toBe("Wrote a prompt in");
  expect(eventText({ text: "Started a thread" })).toBe("Started a thread");
  const common = await Bun.file("src/components/bots/common.tsx").text();
  expect(common).toContain("[eventText(m.event), detail && m.event.kind === \"model\" ? `(${accountName(detail)})` : detail]");
});

test("a message between bots links to the side chat and to the other bot", async () => {
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  expect(chat).toContain('m.event!.kind === "message" && m.event!.conversationId ? eventBot : undefined');
  expect(chat).toContain("<ConversationLink id={event.conversationId!}>");
});

test("a merge's pull request number and thread title are separate links", async () => {
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  expect(chat).toContain("<PullLink url={pullUrl!}>{ref.trimEnd()}</PullLink> {thread}");
  // Following it doesn't also toggle the activity line open.
  expect(chat).toContain('rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}');
  expect(chat).toContain("if (event.pullUrl) return event.pullUrl;");
});

test("thread links in a bot chat open the thread inside OpenBots", async () => {
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  expect(chat).toContain("useStore.getState().openThreadInBots(id);");
  expect(chat).not.toContain("useStore.getState().selectChat(id);");
});

test("a thread open inside OpenBots has a button under Back that opens it out to OpenBuild in place", async () => {
  const app = await Bun.file("src/App.tsx").text();
  const sidebar = await Bun.file("src/components/Sidebar.tsx").text();
  expect(app).toMatch(/label="Back to chat"[\s\S]*?label="Open in OpenBuild" tooltipSide="right" onClick=\{expandBotsThread\}/);
  // Same pane on both sides, so the thread isn't remounted: only the sidebars swap.
  expect(app).toContain('<Activity mode={botsOpen && !botsThread ? "hidden" : "visible"}>');
  expect(sidebar).toMatch(/export function expandBotsThread\(\) \{\n  crossfade\(\(\) => \{\n    const st = useStore.getState\(\);\n    st.setBotsOpen\(false\);/);
});

test("Apps sits in the OpenBots sidebar's footer, just left of the way back to OpenBuild, not at its top", async () => {
  const sidebar = await Bun.file("src/components/bots/BotsSidebar.tsx").text();
  const open = sidebar.slice(sidebar.indexOf("export function BotsSidebar"));
  const top = open.slice(open.indexOf('<div className="brand-row">'), open.indexOf('<div className="history-wrap">'));
  const footer = open.slice(open.indexOf('<div className="settings-row">'));
  expect(top).not.toContain('kind: "apps"');
  // Another device's workspace has no apps to manage from here, so it's left out there.
  expect(footer).toMatch(/<\/button>\s*\{\/\*[^}]*\*\/\}\s*\{!remote && \(\s*<IconButton label="Marketplace" tooltipSide="top" className="bots-apps-btn" onClick=\{\(\) => setDialog\(\{ kind: "apps" \}\)\}>\s*<Store size=\{19\} \/>\s*<\/IconButton>\s*\)\}\s*<BotsToggle \/>/);
  // The rail keeps it in its foot, beside the same toggle.
  expect(sidebar).toMatch(/<IconButton label="Marketplace" tooltipSide="right" className="bots-rail-btn"[\s\S]*?<\/IconButton>\s*\)\}\s*<BotsToggle \/>/);
  // A phone's bigger targets cover it too.
  const mobile = await Bun.file("src/mobile.css").text();
  expect(mobile).toMatch(/\.bots-sidebar \.bots-apps-btn \{\s*width: 44px;\s*height: 44px;/);
});

test("memory stays out of sight, and routines are the bots' to write: people can only see, pause and delete", async () => {
  const details = await Bun.file("src/components/bots/BotDetails.tsx").text();
  const store = await Bun.file("src/lib/bots/store.ts").text();
  const settings = await Bun.file("src/components/bots/BotSettings.tsx").text();
  const routes = await Bun.file("server/bots/routes.ts").text();
  for (const name of ["addMemory", "removeMemory", "addRoutine"]) {
    expect(details).not.toContain(name);
    expect(store).not.toContain(name);
  }
  expect(details).not.toMatch(/memory/i);
  expect(settings).not.toContain("<Memory");
  expect(settings).not.toContain("bot.memory");
  expect(details).not.toContain("<form");
  expect(details).toContain('r.enabled ? "Working" : "Paused"');
  expect(details).toContain("<textarea");
  expect(routes).not.toContain("/api/bots/:id/memory");
  expect(routes).not.toContain('"/api/bots/:id/routines":');
  expect(routes).toContain('"/api/bots/:id/routines/:routineId"');
});

test("resetting says reset, and lively bots, pointer tracking and reactions are always on", async () => {
  const settings = await Bun.file("src/components/bots/BotSettings.tsx").text();
  const store = await Bun.file("src/lib/bots/store.ts").text();
  const agent = await Bun.file("server/bots/agent.ts").text();
  expect(settings).toContain("action={<><RotateCcw size={14} /> Reset</>}");
  for (const label of ["Lively bots", "Eyes follow the pointer", "Reactions from bots"]) expect(settings).not.toContain(label);
  expect(store).not.toContain("setPrefs");
  expect(agent).not.toContain("Reactions are turned off");
});

test("bot settings only list machines, and each machine's isolation is chosen with its device", async () => {
  const settings = await Bun.file("src/components/bots/BotAdvanced.tsx").text();
  const devices = await Bun.file("src/components/DeviceSettings.tsx").text();
  // No choice of one machine or isolation per bot: a read-only list that opens Settings → Devices.
  expect(settings).not.toContain('label="Runs on"');
  expect(settings).not.toContain('label="Isolation"');
  expect(settings).not.toContain("computer: {");
  expect(settings).toContain("showDevice(target.device)");
  // Isolation is per machine, a container unless host is chosen, and host says it's unisolated and asks first.
  expect(devices).toContain('host: "Host (unisolated)"');
  expect(devices).toContain("Host is unisolated");
  expect(devices).toContain("Run bots unisolated on");
  expect(settings + devices).not.toContain("<select");
});

test("the OpenBots switch lands entrance motion, keeps looping motion and outlasts a skipped switch", async () => {
  const script = `
    import { resolve } from "node:path";
    import assert from "node:assert/strict";
    const inApp = { closest: () => ({}) };
    const outside = { closest: () => null };
    class CSSAnimation {
      finished = false;
      constructor(target, iterations) { this.effect = { target, getComputedTiming: () => ({ iterations }) }; }
      finish() { this.finished = true; }
    }
    class CSSTransition extends CSSAnimation {}
    const entrance = new CSSAnimation(inApp, 1);
    const edge = new CSSTransition(inApp, 1);
    const loop = new CSSAnimation(inApp, Infinity);
    const toast = new CSSAnimation(outside, 1);
    const classes = new Set();
    const finishes = [];
    let reduced = false;
    Object.assign(globalThis, {
      CSSAnimation,
      CSSTransition,
      window: { matchMedia: () => ({ matches: reduced }) },
      document: {
        documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } },
        getAnimations: () => [entrance, edge, loop, toast],
        startViewTransition(update) {
          update();
          return { ready: Promise.resolve(), finished: new Promise((r) => finishes.push(r)) };
        },
      },
    });
    const { crossfade } = await import(resolve("src/lib/ui.ts"));
    let updates = 0;
    crossfade(() => updates++);
    assert.equal(updates, 1);
    assert.deepEqual([entrance.finished, edge.finished, loop.finished, toast.finished], [true, true, false, false]);
    assert.ok(classes.has("world-switch"));
    crossfade(() => updates++);
    finishes[0]();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(classes.has("world-switch"), "a skipped switch must not end the one that replaced it");
    finishes[1]();
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!classes.has("world-switch"));
    reduced = true;
    entrance.finished = false;
    crossfade(() => updates++);
    assert.equal(updates, 3);
    assert.equal(entrance.finished, true);
    assert.ok(!classes.has("world-switch"));
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
});

test("a long thread doesn't slow the OpenBots switch: messages out of view skip rendering and keep their height", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.messages-inner > \.msg \{[^}]*content-visibility: auto;[^}]*contain-intrinsic-size: auto \d+px;/);
});

test("a model switch names the bot and its model, and the account only to tell two of a model apart", async () => {
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  expect(chat).toContain('const switcher = m.event!.kind === "model" ? bots.find((x) => x.id === m.author) : undefined;');
  expect(chat).toContain("<BotLink bot={switcher} /> switched to {switchedTo}");
  const { eventDetail, eventText } = await import("../shared/bots");
  // Lines saved before said where in the chain the model sat, and always named its provider.
  expect(eventText({ kind: "model", text: "Switched to fallback model GPT 6.1 Sol" })).toBe("Switched to GPT 6.1 Sol");
  expect(eventText({ kind: "model", text: "Switched to first priority model Grok 4.7" })).toBe("Switched to Grok 4.7");
  expect(eventText({ kind: "model", text: "Switched to #12 priority model Grok 4.7" })).toBe("Switched to Grok 4.7");
  expect(eventDetail({ kind: "model", text: "Switched to fallback model GPT 6.1 Sol", detail: "openai-codex" })).toBeUndefined();
  expect(eventDetail({ kind: "model", text: "Switched to GPT 6.1 Sol", detail: "openai-codex-2" })).toBe("openai-codex-2");
  expect(eventDetail({ kind: "model", text: "Switched to Grok 4.7" })).toBeUndefined();
  const { accountName } = await import("../src/lib/models");
  expect(accountName("openai-codex-2")).toBe("Codex 2");
  expect(accountName("openai-codex")).toBe("Codex");
  expect(accountName("glm-local")).toBe("Glm Local");
});

test("a bot's fallback models are listed in order in both settings layouts, each tagged with its account", async () => {
  const advanced = await Bun.file("src/components/bots/BotAdvanced.tsx").text();
  expect(advanced.match(/<BotFallbacks\n\s*bot=\{bot\}\n\s*header=/g)?.length).toBe(2);
  expect(advanced).toContain('<BotModelSelect label={`Fallback model ${i + 1}`} value={model} account');
  expect(advanced).toContain('label="Try earlier"');
  expect(advanced).toContain("providerName(account ? (m.provider ?? m.id.split(\"/\")[0]!) : providerOf(m))");
});

test("Settings → Bots lists the default fallbacks, which every bot follows until it lists its own or has none", async () => {
  const advanced = await Bun.file("src/components/bots/BotAdvanced.tsx").text();
  const settings = await Bun.file("src/components/bots/BotSettings.tsx").text();
  expect(settings).toMatch(/label="Default model"[^\n]*\n\s*<\/div>\n\s*<DefaultFallbacks \/>/);
  expect(advanced).toContain("<FallbackList list={list} onChange={useBots.getState().setDefaultFallbackModels} />");
  // Three states per bot, read back from what's saved: the defaults (also a legacy empty list), its own list, or none.
  expect(advanced).toContain('{ value: "inherit", label: "Default fallbacks" }');
  expect(advanced).toContain('{ value: "own", label: "Its own list" }');
  expect(advanced).toContain('{ value: "none", label: "No fallback" }');
  expect(advanced).toContain("const saved = fallbackMode(bot);");
  expect(advanced).toContain('if (next === "none") updateBot(bot.id, { noFallbacks: true });');
  expect(advanced).toContain('else if (next === "inherit") updateBot(bot.id, { noFallbacks: false, fallbackModels: [] });');
  // No wording left that says a bot with its own model skips the defaults.
  expect(advanced).not.toContain("keeps its own fallbacks");
  expect(advanced).not.toMatch(/bot\.model \|\| bot\.fallbackModels/);
  expect(advanced).toContain("Every bot uses these, on Default or on a model of its own, unless it lists its own or is set to No fallback.");
  const store = await Bun.file("src/lib/bots/store.ts").text();
  expect(store).toContain('void send("PATCH", "/api/bots/settings", { defaultFallbackModels });');
});

test("the unset model option sits under the search, set off from the provider lists, with its resolved model, logo and muted tag", async () => {
  const advanced = await Bun.file("src/components/bots/BotAdvanced.tsx").text();
  const menu = await Bun.file("src/components/ModelSelect.tsx").text();
  // It's ModelMenu's leading option, not a row squeezed in above the search.
  expect(advanced).not.toMatch(/\{unset && \(\s*<button[^]*?<ModelMenu/);
  expect(advanced).toMatch(/leading=\{\s*unset && \(\s*<button[^>]*aria-selected=\{!value\}[^]*?<BrandIcon id=\{fallback\} \/>[^]*?<span className="menu-item-hint">\{unset\}<\/span>/);
  const search = menu.indexOf('placeholder="Search models or providers…"');
  const leading = menu.indexOf("{leading && !query.trim() && (");
  expect(search).toBeGreaterThan(0);
  expect(leading).toBeGreaterThan(search);
  expect(menu.slice(leading, menu.indexOf("{groups.map", leading))).toContain('<div className="menu-sep" role="separator" />');
});

test("a long thread list doesn't slow the OpenBots switch: rows out of view skip rendering, keeping a focus ring", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.history-row \{[^}]*content-visibility: auto;[^}]*contain-intrinsic-size: auto \d+px;[^}]*overflow-clip-margin: \d+px;/);
});

test("a bot's effort sits next to its model in both settings layouts, limited to what its model takes", async () => {
  const advanced = await Bun.file("src/components/bots/BotAdvanced.tsx").text();
  // Settings → Bots and the details panel's Advanced tab: right after the model.
  expect(advanced.match(/<BotModelSelect label="Model"[^\n]*\n\s*<\/div>\n\s*<div className="setting-row">\n\s*<div className="setting-(text|label)"[^]*?<BotEffortSelect bot=\{bot\}/g)?.length).toBe(2);
  // Empty is the default, sent as empty so the server clears it; the levels are the model's own.
  expect(advanced).toContain('[{ value: "", label: "Default" }, ...efforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] ?? e }))]');
  expect(advanced).toContain("const modelId = bot.model || defaultModel || listing?.defaultModel;");
  expect(advanced).toContain("onChange={(effort) => useBots.getState().updateBot(bot.id, { effort })}");
  expect(advanced).toContain('" · uses nearest"');
});
