import { expect, test } from "bun:test";
import { spawnScript } from "./spawnScript";

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
  const { code, stdout, stderr } = await spawnScript(script);
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
  const { code, stdout, stderr } = await spawnScript(script);
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
  const { code, stdout, stderr } = await spawnScript(script);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(stdout.trim()).toBe("ok");
});

test("a bot's activity line names the bot that did it, by author id; the user's lines keep their wording", async () => {
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
});

test("the OpenBots switch happens at once, lands entrance motion, keeps looping motion, and fades the new panes in", async () => {
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
    let reduced = false;
    let snapshots = 0;
    Object.assign(globalThis, {
      CSSAnimation,
      CSSTransition,
      window: { matchMedia: () => ({ matches: reduced }) },
      document: {
        documentElement: { offsetWidth: 0, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } },
        getAnimations: () => [entrance, edge, loop, toast],
        // No snapshots of the page: the switch is a plain change plus a CSS fade.
        startViewTransition() { snapshots++; },
      },
    });
    const { crossfade } = await import(resolve("src/lib/ui.ts"));
    let updates = 0;
    crossfade(() => updates++);
    assert.equal(updates, 1);
    assert.equal(snapshots, 0);
    assert.deepEqual([entrance.finished, edge.finished, loop.finished, toast.finished], [true, true, false, false]);
    assert.ok(classes.has("world-enter"));
    // A second switch restarts the fade rather than cutting it short.
    await new Promise((r) => setTimeout(r, 150));
    crossfade(() => updates++);
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(classes.has("world-enter"));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!classes.has("world-enter"));
    reduced = true;
    entrance.finished = false;
    crossfade(() => updates++);
    assert.equal(updates, 3);
    assert.equal(entrance.finished, true);
    assert.ok(!classes.has("world-enter"));
  `;
  const { code, stdout, stderr } = await spawnScript(script);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
});

test("a model switch names the bot and its model, and the account only to tell two of a model apart", async () => {
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
