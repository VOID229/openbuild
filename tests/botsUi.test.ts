import { expect, test } from "bun:test";

// Keep browser/store mocks isolated from the other suites.
test("bots mutations await acknowledgement, reconcile failures, serialize writes and load history", async () => {
  const script = `
    import { mock } from "bun:test";
    import { resolve } from "node:path";
    import assert from "node:assert/strict";
    mock.module(resolve("src/lib/store.ts"), () => ({ useStore: { getState: () => ({ settings: { profile: {} } }) } }));
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const { useBots } = await import(resolve("src/lib/bots/store.ts"));
    const c = { id: "chat", kind: "direct", botIds: ["bot"], createdAt: 1, updatedAt: 1, messages: [{ id: "latest", author: "me", text: "hello", at: 1 }], more: true };
    const snapshot = { bots: [], conversations: [c], settings: { sections: [] }, typing: {}, drafts: [], status: {} };
    useBots.setState({ conversations: [c] });
    const calls = [];
    let ack;
    globalThis.fetch = async (path, init) => {
      calls.push([path, init]);
      if (path === "/api/bots") return Response.json(snapshot);
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
      if (path === "/api/bots/stream") return new Response(new ReadableStream({ start(controller) {
        const events = [
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
    const { useBots } = await import(resolve("src/lib/bots/store.ts"));
    const group = { id: "group", kind: "group", name: "G", botIds: ["a", "b"], createdAt: 1, updatedAt: 30, more: true, messages: [
      { id: "m20", author: "me", text: "recent", at: 20 },
      { id: "m30", author: "a", text: "latest", at: 30 },
    ] };
    const snapshot = { bots: [], conversations: [group], settings: { sections: [] }, typing: {}, drafts: [], status: {} };
    globalThis.fetch = async (path) => {
      if (path === "/api/bots/stream") return new Response(new ReadableStream({ start(controller) {
        const events = [
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
    const KEY = "openchat-kv:openbuild-bots/cache:snapshot";
    const saved = new Map();
    globalThis.localStorage = { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v), removeItem: (k) => saved.delete(k) };
    const chat = (id, count) => ({ id, kind: "direct", botIds: ["bot"], createdAt: 1, updatedAt: 1, messages: Array.from({ length: count }, (_, i) => ({ id: id + i, author: "me", text: "", at: i })) });
    saved.set(KEY, JSON.stringify({ bots: [{ id: "bot" }], conversations: [chat("cached", 1)], sections: ["work"] }));
    const { preloadBots, useBots } = await import(resolve("src/lib/bots/store.ts"));
    const paths = [];
    let answer;
    globalThis.fetch = async (path) => {
      paths.push(path);
      await new Promise((r) => { answer = r; });
      return Response.json({ bots: [], conversations: [chat("fresh", 60)], settings: { sections: [] }, typing: {}, drafts: [], status: {} });
    };

    // The cached copy shows without the server, and isn't mistaken for the server's state.
    await preloadBots();
    assert.equal(useBots.getState().activeId, "cached");
    assert.deepEqual(useBots.getState().sections, ["work"]);
    assert.equal(useBots.getState().loaded, false);
    assert.equal(useBots.getState().connected, true);
    // Preloading holds no connection open.
    assert.deepEqual(paths, ["/api/bots"]);

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

test("composer clears only after ack and routine/memory actions do not fabricate bot events", async () => {
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  const details = await Bun.file("src/components/bots/BotDetails.tsx").text();
  expect(chat).toContain("const m = await useBots.getState().post");
  expect(chat.indexOf("if (!m) return;")).toBeLessThan(chat.indexOf('setText((current) =>'));
  expect(chat).toContain("sendingRef.current ||");
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

test("a started thread's activity line names the bot that started it", async () => {
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  expect(chat).toContain('m.event!.kind === "thread" && m.event!.text === "Started a thread" ? bots.find((x) => x.id === m.author)');
  expect(chat).toContain("{starter ? <><BotLink bot={starter} /> started a thread</> : <WithBotLinks text={eventText(m.event!)} bots={bots} />}");
});

test("older follow-up prompts read with the current wording", async () => {
  const { eventText } = await import("../shared/bots");
  expect(eventText({ text: "Wrote to a thread" })).toBe("Wrote a prompt");
  expect(eventText({ text: "Started a thread" })).toBe("Started a thread");
  const common = await Bun.file("src/components/bots/common.tsx").text();
  expect(common).toContain("[eventText(m.event), m.event.detail]");
});

test("a merge's pull request number and thread title are separate links", async () => {
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  expect(chat).toContain("<PullLink url={pullUrl!}>{ref.trimEnd()}</PullLink></span> {thread}");
  expect(chat).toContain("if (event.pullUrl) return event.pullUrl;");
});

test("thread links in a bot chat open the thread inside OpenBots", async () => {
  const chat = await Bun.file("src/components/bots/BotChat.tsx").text();
  expect(chat).toContain("useStore.getState().openThreadInBots(id);");
  expect(chat).not.toContain("useStore.getState().selectChat(id);");
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

test("computer settings require explicit host selection and explain isolation", async () => {
  const settings = await Bun.file("src/components/bots/BotAdvanced.tsx").text();
  expect(settings).toContain('label="Computer"');
  expect(settings).toContain(': "local:container"}');
  expect(settings).toContain('label: "Host (unisolated)"');
  expect(settings).toContain("Host access is unisolated");
  expect(settings).toContain('kind: value === "local:host" ? "host" : "container"');
  expect(settings).not.toContain("<select");
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
