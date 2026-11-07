import { expect, test } from "bun:test";

// A stream that stops delivering without closing (a network change, a phone waking from sleep) used
// to leave the bot's work and reply unseen until a reload. Isolated: it fakes the browser's clock,
// timers, page and fetch.
test("a silent OpenBots stream reconnects by itself and brings back the bot's work and reply", async () => {
  const script = `
    import { mock } from "bun:test";
    import { resolve } from "node:path";
    import assert from "node:assert/strict";
    mock.module(resolve("src/lib/store.ts"), () => ({ useStore: { getState: () => ({ settings: { profile: {} } }) } }));
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const page = new EventTarget();
    page.visibilityState = "visible";
    globalThis.document = page;
    let skew = 0;
    const realNow = Date.now;
    Date.now = () => realNow() + skew;
    const watchdogs = new Set();
    const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
    globalThis.setInterval = (fn, ms) => { const id = realSetInterval(() => {}, 1 << 30); watchdogs.add(fn); id.fn = fn; return id; };
    globalThis.clearInterval = (id) => { watchdogs.delete(id?.fn); realClearInterval(id); };
    const tick = () => [...watchdogs].forEach((fn) => fn());
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    const { useBots, STREAM_SILENCE, enterWorkspace } = await import(resolve("src/lib/bots/store.ts"));
    const { useWorkspace } = await import(resolve("src/lib/bots/workspace.ts"));
    useWorkspace.setState({ localId: "srv", localName: "Studio" });
    enterWorkspace("srv");
    const question = { id: "q", author: "me", text: "can you check vercel?", at: 1 };
    const reply = { id: "r", author: "bot", text: "Vercel access works.", at: 2 };
    const chat = (messages) => ({ id: "chat", kind: "direct", botIds: ["bot"], createdAt: 1, updatedAt: 1, messages });
    const snapshot = (over) => ({ t: "snapshot", bots: [], conversations: [chat([question])], settings: { sections: [] }, typing: {}, drafts: [], status: {}, ...over });
    const enc = new TextEncoder();
    const streams = [];
    globalThis.fetch = async (path, init) => {
      if (path !== "/api/workspace/to/srv/api/bots/stream") return Response.json({ ok: true });
      let controller;
      const body = new ReadableStream({ start(c) { controller = c; } });
      const s = { signal: init?.signal, send: (e) => controller.enqueue(enc.encode(JSON.stringify(e) + "\\n")) };
      streams.push(s);
      s.send({ t: "hello", workspace: "srv" });
      // A half-open connection: the abort doesn't reach the body either, so only the store's own bound ends it.
      s.send(streams.length === 1 ? snapshot() : streams.length === 2
        ? snapshot({ typing: { chat: ["bot"] }, status: { bot: { state: "working", conversationId: "chat", activity: "Using Vercel" } } })
        : snapshot({ conversations: [chat([question, reply])] }));
      return new Response(body);
    };

    useBots.getState().ensureSeeded();
    useBots.getState().select("chat");
    await wait(10);
    assert.equal(streams.length, 1);
    assert.equal(useBots.getState().loaded, true);

    // Pings keep a quiet chat's connection: no reconnect while they arrive.
    for (let i = 0; i < 4; i++) {
      skew += 20_000;
      streams[0].send({ t: "ping" });
      await wait(5);
      tick();
    }
    await wait(10);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].signal.aborted, false);

    // The bot starts working while the connection has gone silent. In the foreground, the watchdog
    // notices, and the next snapshot shows its busy status and typing in the chat and the sidebar.
    skew += STREAM_SILENCE + 1;
    tick();
    assert.equal(streams[0].signal.aborted, true);
    await wait(10);
    assert.equal(useBots.getState().connected, false);
    await wait(500);
    assert.equal(streams.length, 2);
    assert.equal(useBots.getState().connected, true);
    assert.equal(useBots.getState().status.bot.activity, "Using Vercel");
    assert.deepEqual(useBots.getState().typing.chat, ["bot"]);

    // Live events on the new connection still arrive: the tool status after it writes.
    streams[1].send({ t: "status", botId: "bot", status: { state: "working", conversationId: "chat", activity: "Reading logs", quiet: true } });
    await wait(5);
    assert.equal(useBots.getState().status.bot.activity, "Reading logs");

    // The page sleeps through the reply (no timers run) and wakes: it reconnects at once rather than
    // waiting for the watchdog, and the reply is there with nothing left busy.
    skew += 10 * 60_000;
    page.dispatchEvent(new Event("visibilitychange"));
    assert.equal(streams[1].signal.aborted, true);
    await wait(550);
    assert.equal(streams.length, 3);
    const state = useBots.getState();
    assert.deepEqual(state.conversations[0].messages.map((m) => m.id), ["q", "r"]);
    assert.deepEqual(state.status, {});
    assert.deepEqual(state.typing, {});
    assert.equal(state.connected, true);
    // Only the live connection is left listening.
    assert.equal(watchdogs.size, 1);
    console.log("ok");
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(stdout.trim()).toBe("ok");
});
