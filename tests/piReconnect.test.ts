import { expect, test } from "bun:test";
import { canSyncChat, readChatProjection } from "../src/lib/chatSync";
import type { Chat } from "../src/lib/types";

async function run(script: string) {
  const prelude = `
    import { strict as assert } from 'node:assert';
    globalThis.window = globalThis;
    globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
    globalThis.addEventListener = () => {};
    globalThis.removeEventListener = () => {};
    const storage = new Map();
    globalThis.localStorage = { getItem(k) { return storage.get(k) ?? null; }, setItem(k,v) { storage.set(k,v); }, removeItem(k) { storage.delete(k); }, get length() { return storage.size; }, key(i) { return [...storage.keys()][i] ?? null; } };
    const timeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => timeout(fn, Math.min(ms, 5), ...args);
    const config = () => Response.json({ mode: 'local', convexUrl: null, serverId: 'server-1' });
    const answer = () => new Response('{"t":"text","v":"Offline result"}\\n{"t":"done"}\\n{"t":"end"}\\n', { headers: { 'x-openchat-run': '1' } });
    const stream = { id: 'reply-0123456789abcdef', via: 'server-1' };
    const request = { threadId: 'thread-1', cwd: '/tmp', model: 'openai/gpt', effort: 'off', message: 'hi', prior: 0 };
  `;
  const child = Bun.spawn([process.execPath, "-e", prelude + script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(err).toBe("");
  expect(code).toBe(0);
}

test("Pi replay after restart survives a long outage without reposting", async () => {
  await run(`
    let gets = 0, time = 0;
    Date.now = () => (time += 11 * 60_000);
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('/api/chat/runs/')) {
        assert.notEqual(init?.method, 'POST');
        if (++gets < 3) return new Response(null, { status: 503 });
        return answer();
      }
      return config();
    };
    const { streamChat } = await import('./src/lib/api.ts');
    const events = [];
    for await (const e of streamChat(undefined, stream, 0, new AbortController().signal, true)) events.push(e);
    assert.equal(gets, 3);
    assert.deepEqual(events.map(e => e.t), ['reset', 'text', 'done']);
    assert.equal(events[1].v, 'Offline result');
  `);
});

test("Pi admission retries only after its lost request is confirmed absent and keeps the same id", async () => {
  await run(`
    const calls = [], ids = [];
    globalThis.fetch = async (url, init) => {
      if (String(url) === '/api/pi/chat') {
        calls.push('POST'); ids.push(JSON.parse(init.body).stream.id);
        return ids.length === 1 ? new Response(null, { status: 503 }) : answer();
      }
      if (String(url).startsWith('/api/chat/runs/')) {
        calls.push('GET');
        return new Response(null, { status: calls.filter(c => c === 'GET').length === 1 ? 503 : 404 });
      }
      return config();
    };
    const { streamChat } = await import('./src/lib/api.ts');
    const events = [];
    for await (const e of streamChat(request, stream, 0, new AbortController().signal)) events.push(e.t);
    assert.deepEqual(calls, ['POST', 'GET', 'GET', 'POST']);
    assert.deepEqual(ids, [stream.id, stream.id]);
    assert.deepEqual(events, ['text', 'done']);
  `);
});

test("Pi busy is not mistaken for admission of this request", async () => {
  await run(`
    let posts = 0, gets = 0;
    globalThis.fetch = async (url) => {
      if (String(url) === '/api/pi/chat') return ++posts === 1 ? Response.json({ code: 'busy' }, { status: 409 }) : answer();
      if (String(url).startsWith('/api/chat/runs/')) { gets++; throw new Error('must not attach to another run'); }
      return config();
    };
    const { streamChat } = await import('./src/lib/api.ts');
    const events = [];
    for await (const e of streamChat(request, stream, 0, new AbortController().signal)) events.push(e.t);
    assert.equal(posts, 2); assert.equal(gets, 0);
    assert.deepEqual(events, ['notice', 'text', 'done']);
  `);
});

test("a resumed Pi run missing from storage is reported without starting new work", async () => {
  await run(`
    let gets = 0;
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('/api/chat/runs/')) { gets++; assert.notEqual(init?.method, 'POST'); return new Response(null, { status: 404 }); }
      return config();
    };
    const { streamChat } = await import('./src/lib/api.ts');
    const events = [];
    for await (const e of streamChat(undefined, stream, 0, new AbortController().signal, true)) events.push(e);
    assert.equal(gets, 1); assert.equal(events.length, 1); assert.equal(events[0].t, 'error');
  `);
});

const chat = (status: "streaming" | "done" | "error" | "stopped", run = "run-1"): Chat => ({
  id: "thread-1", title: "Thread", createdAt: 1, updatedAt: 2, unread: status !== "streaming",
  messages: [{ id: "assistant-1", role: "assistant", content: status === "streaming" ? "Partial" : "Offline result", createdAt: 1, status, stream: { id: run, via: "server-1" } }],
});

test("polling accepts terminal projections of the same run so sidebar working/unread state settles", () => {
  for (const status of ["done", "error", "stopped"] as const) {
    const completed = chat(status);
    expect(canSyncChat(chat("streaming"), completed)).toBe(true);
    expect(completed.unread).toBe(true);
  }
  expect(canSyncChat(chat("streaming"), chat("streaming"))).toBe(false);
  expect(canSyncChat(chat("streaming"), chat("done", "previous-run"))).toBe(false);
  const removed = { ...chat("done"), messages: [] };
  expect(canSyncChat(chat("streaming"), removed)).toBe(false);
  expect(canSyncChat(chat("done"), chat("streaming", "new-run"))).toBe(true);
});

test("a visible active thread consumes projected unread state; background threads retain it", () => {
  const completed = chat("done");
  const read = readChatProjection(completed, completed.id);
  expect(read.unread).toBe(false);
  expect(read.messages).toBe(completed.messages);
  expect(readChatProjection(completed, "another-thread")).toBe(completed);
  expect(readChatProjection(completed, undefined)).toBe(completed);
  expect(completed.unread).toBe(true);
});

test("terminal projection cancels only the stale listener and cannot be overwritten by a queued flush", async () => {
  await run(`
    const frames = []; globalThis.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
    globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    let attached = false, stops = 0, aborted = false;
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/stop')) { stops++; return Response.json({}); }
      if (String(url).startsWith('/api/chat/runs/')) {
        attached = true;
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('{"t":"text","v":"Stale partial"}\\n'));
          init.signal.addEventListener('abort', () => { aborted = true; controller.error(new DOMException('Aborted', 'AbortError')); });
        } }));
      }
      return config();
    };
    const { config: runtimeConfig } = await import('./src/lib/runtime.ts'); await runtimeConfig;
    const { useStore } = await import('./src/lib/store.ts');
    const { resumeReplies } = await import('./src/lib/chat.ts');
    const saved = { id: 'thread-1', title: 'Thread', runtime: 'pi', createdAt: 1, updatedAt: 2, messages: [{ id: 'a', role: 'assistant', model: { plan: 'pi', id: 'openai/gpt' }, content: '', createdAt: 1, status: 'streaming', stream }] };
    useStore.setState({ chats: [saved] }); resumeReplies();
    while (!frames.length) await new Promise(resolve => timeout(resolve, 1));
    assert.equal(attached, true);
    useStore.setState({ chats: [{ ...saved, unread: true, messages: [{ ...saved.messages[0], status: 'done', content: 'Final offline output', parts: [{ type: 'text', text: 'Final offline output' }] }] }] });
    resumeReplies();
    await new Promise(resolve => timeout(resolve, 10));
    for (const frame of frames) frame();
    const result = useStore.getState().chats[0];
    assert.equal(result.messages[0].content, 'Final offline output');
    assert.equal(result.messages[0].status, 'done');
    assert.equal(result.unread, true);
    assert.equal(aborted, true); assert.equal(stops, 0);
  `);
});

test("Pi admission barrier waits for server ack and caches the canonical projected body", async () => {
  await run(`
    let acknowledge, puts = 0, detailReads = 0;
    const saved = { id: 'thread-1', title: 'Thread', createdAt: 1, updatedAt: 2, messages: [{ id: 'a', role: 'assistant', content: '', createdAt: 1, status: 'streaming', stream }] };
    const canonical = { ...saved, messages: [{ ...saved.messages[0], status: 'done', content: 'Offline result' }] };
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'PUT') { puts++; await new Promise(resolve => { acknowledge = resolve; }); return Response.json({ v: 'canonical-v', chat: canonical }); }
      if (String(url) === '/api/chats?index') return Response.json({ index: [{ id: saved.id, v: 'canonical-v' }] });
      if (String(url) === '/api/chats/fetch') { detailReads++; throw new Error('canonical response should already be cached'); }
      return config();
    };
    const { saveChatBeforeRun, loadChats } = await import('./src/lib/db.ts');
    const { config: runtimeConfig } = await import('./src/lib/runtime.ts'); await runtimeConfig;
    let admitted = false;
    const saving = saveChatBeforeRun(saved).then(() => { admitted = true; });
    while (!acknowledge) await new Promise(resolve => timeout(resolve, 1));
    assert.equal(admitted, false);
    acknowledge(); await saving;
    assert.equal(admitted, true); assert.equal(puts, 1);
    const chats = await loadChats();
    assert.equal(chats[0].messages[0].status, 'done');
    assert.equal(chats[0].messages[0].content, 'Offline result');
    assert.equal(detailReads, 0);
  `);
});

test("Pi admission barrier does not admit a deleted thread just because its outbox drained", async () => {
  await run(`
    globalThis.fetch = async (url, init) => init?.method === 'PUT' ? new Response(null, { status: 410 }) : config();
    const { saveChatBeforeRun } = await import('./src/lib/db.ts');
    const { config: runtimeConfig } = await import('./src/lib/runtime.ts'); await runtimeConfig;
    await assert.rejects(saveChatBeforeRun({ id: 'thread-1', title: 'Thread', createdAt: 1, updatedAt: 2, messages: [] }), /Couldn't save this thread/);
  `);
});

test("Pi admission barrier rejects offline storage without admitting work", async () => {
  await run(`
    globalThis.fetch = async (url, init) => init?.method === 'PUT' ? new Response(null, { status: 503 }) : config();
    const { saveChatBeforeRun } = await import('./src/lib/db.ts');
    const { config: runtimeConfig } = await import('./src/lib/runtime.ts'); await runtimeConfig;
    await assert.rejects(saveChatBeforeRun({ id: 'thread-1', title: 'Thread', createdAt: 1, updatedAt: 2, messages: [] }), /Couldn't save this thread/);
    process.exit(0);
  `);
});
