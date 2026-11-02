import { test } from "bun:test";
import { scenario } from "./client-harness";

test("Stop during workspace preparation finishes locally and never admits a late turn", () => scenario(`
  useStore.setState({ chats: [{ ...base, workspace: undefined }] });
  const workspace = deferred(); let posts = 0;
  transport = async (url) => {
    if (url === '/api/workspaces') return workspace.promise;
    if (url.endsWith('/stop')) return Response.json({ ok: true });
    if (url === '/api/pi/chat') { posts++; return response({ t: 'text', v: 'Too late' }, { t: 'end' }); }
    throw new Error(url);
  };
  assert.ok(chat.sendMessage('do work', []));
  chat.stopGeneration('c');
  await until(() => current().messages.at(-1).status === 'stopped');
  workspace.resolve(Response.json({ workspace: base.workspace }));
  await Bun.sleep(25);
  assert.equal(posts, 0);
`));

test("Stop does not silently start the next queued action", () => scenario(`
  const reply = deferred(); let posts = 0;
  transport = async (url) => {
    if (url.endsWith('/stop')) return Response.json({ ok: true });
    if (url === '/api/pi/chat') { posts++; return reply.promise; }
    throw new Error(url);
  };
  chat.sendMessage('first', []);
  queue.enqueue('c', { id: 'q', text: 'next action', files: [] });
  chat.stopGeneration('c');
  reply.resolve(response({ t: 'end' }));
  await until(() => current().messages[1].status === 'stopped');
  assert.equal(posts, 1);
  assert.deepEqual(queue.queueOf('c').map(q => q.id), ['q']);
  assert.equal(current().messages.length, 2);
`));

test("a late animation flush cannot erase a remotely completed resumed answer", () => scenario(`
  let controller;
  transport = async url => {
    if (url.startsWith('/api/chat/runs/')) return new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('{"t":"text","v":"partial"}\\n')); } }));
    throw new Error(url);
  };
  useStore.setState({ chats: [{ ...base, messages: [{ id: 'a', role: 'assistant', content: '', model: { plan: 'pi', id: model.id, name: 'Test' }, status: 'streaming', stream: { id: 'reply-0123456789abcdef', via: 'server-1' }, createdAt: 1 }] }] });
  chat.resumeReplies();
  await until(() => !!controller);
  useStore.getState().patchMessage('c', 'a', { content: 'complete answer from writer', status: 'done' });
  await Bun.sleep(130);
  assert.equal(current().messages[0].content, 'complete answer from writer');
  controller.close();
`));

test("reconnect stops retrying an identical assistant one-liner without forward progress", () => scenario(`
  let attempts = 0, clock = 0;
  const now = Date.now;
  Date.now = () => clock;
  const nativeTimeout = setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms <= 5000 ? 0 : ms, ...args);
  console.warn = () => {};
  transport = async url => {
    assert.ok(url.startsWith('/api/chat/runs/'));
    attempts++; clock += 11 * 60_000;
    return response({ t: 'text', v: "I'll investigate." }); // EOF without end; same replay every time.
  };
  const { streamChat } = await import('./src/lib/api.ts');
  let error;
  for await (const ev of streamChat(undefined, { id: 'reply-0123456789abcdef', via: 'server-1' }, 0, new AbortController().signal)) {
    if (ev.t === 'error') error = ev.message;
    assert.ok(attempts < 5, 'replayed text incorrectly renewed retry deadline');
  }
  assert.match(error, /Lost the connection/);
  Date.now = now;
`));

test("Stop works for a persisted streaming message before its watcher attaches", () => scenario(`
  let stops = 0;
  transport = async url => { assert.ok(url.endsWith('/stop')); stops++; return Response.json({ ok: true }); };
  useStore.setState({ chats: [{ ...base, messages: [{ id: 'a', role: 'assistant', content: 'partial', model: { plan: 'pi', id: model.id }, status: 'streaming', stream: { id: 'reply-0123456789abcdef', via: 'server-1' }, createdAt: 1 }] }] });
  chat.stopGeneration('c');
  assert.equal(current().messages[0].status, 'stopped');
  assert.equal(stops, 1);
`));

test("an existing local workspace is not rerouted by the new-thread project selection", () => scenario(`
  useStore.setState({ projects: [{ id: 'remote::project', deviceId: 'remote-device' }], settings: { ...useStore.getState().settings, workspace: { ...useStore.getState().settings.workspace, projectId: 'remote::project' } } });
  const urls = [];
  transport = async url => { urls.push(url); return response({ t: 'text', v: 'local' }, { t: 'end' }); };
  chat.sendMessage('continue this local thread', []);
  await until(() => current().messages[1].status !== 'streaming');
  assert.deepEqual(urls, ['/api/pi/chat']);
`));

test("a new send cannot orphan a running reply", () => scenario(`
  const pending = deferred(); let posts = 0;
  transport = async url => {
    if (url === '/api/pi/chat') { posts++; return pending.promise; }
    if (url.endsWith('/stop')) return Response.json({ ok: true });
    throw new Error(url);
  };
  chat.sendMessage('first', []);
  assert.equal(chat.sendMessage('second', []), false);
  assert.equal(current().messages.length, 2);
  chat.stopGeneration('c');
`));

