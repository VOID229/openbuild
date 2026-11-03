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
    const snapshot = { bots: [], conversations: [c], settings: { sections: [], reactions: true }, typing: {}, drafts: [], status: {} };
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
    useBots.getState().addMemory("bot", "keep");
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(JSON.parse(requests.at(-1)[1].body).id);
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
      return Response.json({ bots: [], conversations: [chat("fresh", 60)], settings: { sections: [], reactions: true }, typing: {}, drafts: [], status: {} });
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
  expect(chat).toContain("Please remember this:");
  expect(chat).not.toContain('author: directBot.id, text: "", event:');
  expect(details).not.toContain('author: bot.id, text: "", event:');
});

test("computer settings require explicit host selection and explain isolation", async () => {
  const settings = await Bun.file("src/components/bots/BotSettings.tsx").text();
  expect(settings).toContain('label="Computer"');
  expect(settings).toContain(': "local:container"}');
  expect(settings).toContain('label: "Host · this server (unisolated)"');
  expect(settings).toContain("Host access is unisolated");
  expect(settings).toContain('kind: value === "local:host" ? "host" : "container"');
  expect(settings).not.toContain("<select");
});
