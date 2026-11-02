import { test } from "bun:test";
import { scenario } from "./client-harness";

test("poll-discovered resumable replies acquire a running owner for steering and Stop", () => scenario(`
  let controller, steers = 0;
  transport = async url => {
    if (url === '/api/chat/runs/reply-0123456789abcdef') return new Response(new ReadableStream({ start(c) { controller = c; } }));
    if (url === '/api/pi/threads/discovered/steer') { steers++; return Response.json({ handled: true }); }
    if (url.endsWith('/stop')) return Response.json({ ok: true });
    throw new Error(url);
  };
  const discovered = { ...base, id: 'discovered', messages: [{ id: 'a', role: 'assistant', content: '', status: 'streaming', model: { plan: 'pi', id: model.id, name: 'Test' }, createdAt: 1, stream: { id: 'reply-0123456789abcdef', via: 'server-1' } }] };
  chat.adoptDiscoveredChats([discovered], new Map(useStore.getState().chats.map(c => [c.id, c])));
  await until(() => !!controller);
  queue.enqueue('discovered', { id: 'q', text: 'steer this discovered run', files: [] });
  await chat.steerQueued('discovered', 'q');
  assert.equal(steers, 1);
  chat.stopGeneration('discovered');
  await until(() => useStore.getState().chats.find(c => c.id === 'discovered').messages[0].status === 'stopped');
  // Exercise the actual App wiring too: a library-only fix must not leave polling on resumeShells.
  const source = await Bun.file('./src/App.tsx').text();
  assert.ok(source.includes('adoptDiscoveredChats(incoming, before)'));
`));

test("discovery does not overwrite edits made while the index request was in flight", () => scenario(`
  const before = new Map(useStore.getState().chats.map(c => [c.id, c]));
  useStore.getState().updateChat('c', { title: 'local edit' });
  chat.adoptDiscoveredChats([{ ...base, title: 'stale fetched title' }], before);
  assert.equal(current().title, 'local edit');
`));

test("a confirmed external completion releases queued follow-ups", () => scenario(`
  await queue.queuesReady;
  const observed = { ...base, messages: [{ id: 'a', role: 'assistant', content: 'working', model: { plan: 'pi', id: model.id, name: 'Test' }, createdAt: 1, status: 'streaming', stream: { id: '', via: 'external' } }] };
  useStore.setState({ chats: [observed] });
  queue.enqueue('c', { id: 'q', text: 'follow-up after terminal completion', files: [] });
  transport = async url => { assert.equal(url, '/api/pi/chat'); return response({ t: 'text', v: 'follow-up answer' }, { t: 'end' }); };
  chat.adoptDiscoveredChats([{ ...observed, messages: [{ ...observed.messages[0], status: 'done', stream: undefined }] }], new Map([['c', observed]]));
  await until(() => current().messages.length === 3 && current().messages.at(-1).status === 'done');
  assert.equal(current().messages[1].content, 'follow-up after terminal completion');
  assert.deepEqual(queue.queueOf('c'), []);
`));

test("external liveness expiry does not dispatch queued actions into a possibly still-running tool", () => scenario(`
  await queue.queuesReady;
  const observed = { ...base, messages: [{ id: 'a', role: 'assistant', content: 'working', createdAt: 1, status: 'streaming', stream: { id: '', via: 'external' } }] };
  useStore.setState({ chats: [observed] });
  queue.enqueue('c', { id: 'q', text: 'wait for a real completion', files: [] });
  chat.adoptDiscoveredChats([{ ...observed, messages: [{ ...observed.messages[0], status: 'stopped', stream: undefined }] }], new Map([['c', observed]]));
  assert.deepEqual(queue.queueOf('c').map(q => q.id), ['q']);
`));
