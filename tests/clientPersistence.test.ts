import { test } from "bun:test";
import { scenario } from "./client-harness";

test("loading remote-device replies before device discovery does not mark them stopped", () => scenario(`
  const remote = { ...base, id: 'remote', messages: [{ id: 'a', role: 'assistant', model: { plan: 'pi', id: model.id, name: 'Test' }, status: 'streaming', content: 'partial', createdAt: 1, stream: { id: 'remote-reply-0123456789', via: 'remote-server', deviceId: 'paired-device' } }] };
  let attached = false;
  transport = async url => {
    if (url.startsWith('/api/chats?summaries')) return Response.json({ chats: [remote] });
    assert.equal(url, '/api/devices/paired-device/api/chat/runs/remote-reply-0123456789');
    attached = true;
    return response({ t: 'text', v: 'remote completed' }, { t: 'end' });
  };
  const { loadChats } = await import('./src/lib/db.ts');
  const loaded = await loadChats();
  assert.equal(loaded[0].messages[0].status, 'streaming');
  useStore.setState({ chats: loaded });
  chat.resumeReplies();
  await until(() => useStore.getState().chats[0].messages[0].status === 'done');
  assert.equal(attached, true);
  assert.equal(useStore.getState().chats[0].messages[0].content, 'remote completed');
`));

test("settings PUTs are serialized so a slow older write cannot land last", () => scenario(`
  transportState = true;
  const first = deferred(); const values = [];
  transport = async (url, init) => {
    assert.equal(url, '/api/state');
    values.push(JSON.parse(init.body).state);
    if (values.length === 1) return first.promise;
    return Response.json({ ok: true });
  };
  const { serverStorage } = await import('./src/lib/stateStorage.ts');
  serverStorage.setItem('openchat', 'first');
  await until(() => values.length === 1);
  serverStorage.setItem('openchat', 'second');
  await Bun.sleep(300);
  assert.deepEqual(values, ['first']);
  first.resolve(Response.json({ ok: true }));
  await until(() => values.length === 2);
  assert.deepEqual(values, ['first', 'second']);
`));

test("failed cloud download is not recorded as applied and can be retried", () => scenario(`
  const { SyncEngine } = await import('./src/lib/cloud/sync.ts');
  const { seal } = await import('./src/lib/cloud/crypto.ts');
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const record = await seal(key, 'chat:remote', { ...base, id: 'remote', title: 'retried download' });
  let downloads = 0;
  transport = async url => {
    assert.equal(url, 'https://offline.invalid/record');
    if (++downloads === 1) return new Response(null, { status: 503 });
    return new Response(record.data);
  };
  const engine = new SyncEngine({}, 'offline-test', key);
  engine.state = { cursor: 0, known: {}, dirty: [], initialized: true };
  const row = { key: 'chat:remote', seq: 1, deleted: false, iv: record.iv, url: 'https://offline.invalid/record' };
  await assert.rejects(engine.applyRecord(row));
  assert.equal(engine.state.known['chat:remote'], undefined);
  await engine.applyRecord(row);
  assert.equal(downloads, 2);
  assert.equal(engine.state.known['chat:remote'], 1);
  assert.equal(useStore.getState().chats.find(c => c.id === 'remote').title, 'retried download');
`));

test("cloud merge does not replace a regenerated run with the older finished attempt", () => scenario(`
  const { mergeChats } = await import('./src/lib/cloud/sync.ts');
  const assistant = { id: 'a', role: 'assistant', content: 'old answer', status: 'done', createdAt: 1, startedAt: 1, stream: { id: 'old-attempt-0123456789', via: 'server-1' } };
  const old = { ...base, messages: [assistant] };
  const retry = { ...base, messages: [{ ...assistant, content: '', status: 'streaming', startedAt: 2, stream: { id: 'new-attempt-0123456789', via: 'server-1' } }] };
  assert.equal(mergeChats(retry, old).messages[0].status, 'streaming');
  assert.equal(mergeChats(old, retry).messages[0].status, 'streaming');
  const finished = { ...retry, messages: [{ ...retry.messages[0], content: 'new answer', status: 'done' }] };
  assert.equal(mergeChats(retry, finished).messages[0].content, 'new answer');
`));
