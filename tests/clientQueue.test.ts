import { test } from "bun:test";
import { scenario } from "./client-harness";

test("queued actions and unacknowledged steering survive browser rehydration by id", () => scenario(`
  await queue.queuesReady;
  const item = { id: 'q', text: 'do not forget', files: [{ id: 'f', name: 'note.txt', text: 'evidence', mime: 'text/plain' }] };
  queue.enqueue('c', item);
  queue.stageSteer('c', item);
  await tick();
  const saved = [...ls.entries()].find(([k]) => k.includes('openchat-queue'))[1];
  queue.useQueue.setState({ queues: {}, steering: {} });
  // Restore the persisted browser copy, as if this were a new tab.
  const key = [...ls.keys()].find(k => k.includes('openchat-queue'));
  ls.set(key, saved);
  await queue.useQueue.persist.rehydrate();
  assert.deepEqual(queue.steeringOf('c'), [item]);
  queue.requeue('c', queue.steeringOf('c'));
  queue.requeue('c', [{ ...item }]);
  assert.deepEqual(queue.queueOf('c'), [item]);
  assert.deepEqual(queue.steeringOf('c'), []);
`));

test("late handled steering receipt is not repeated as a new turn", () => scenario(`
  await queue.queuesReady;
  let controller; let posts = 0;
  const steer = deferred();
  transport = async (url) => {
    if (url === '/api/pi/chat') { posts++; return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'x-openchat-run': '1' } }); }
    if (url.endsWith('/steer')) return steer.promise;
    throw new Error(url);
  };
  chat.sendMessage('first', []);
  await until(() => !!controller);
  queue.enqueue('c', { id: 'q', text: 'plugin action', files: [] });
  const steering = chat.steerQueued('c', 'q');
  controller.enqueue(new TextEncoder().encode('{"t":"text","v":"finished"}\\n{"t":"end"}\\n'));
  controller.close();
  await Bun.sleep(20);
  assert.equal(posts, 1);
  steer.resolve(Response.json({ handled: true }));
  await steering;
  await until(() => current().messages[1].status === 'done');
  assert.equal(posts, 1);
  assert.deepEqual(queue.queueOf('c'), []);
  assert.deepEqual(queue.steeringOf('c'), []);
`));

test("an error preserves queued actions instead of burning through them", () => scenario(`
  const reply = deferred(); let posts = 0;
  transport = async url => {
    if (url === '/api/pi/chat') { posts++; return reply.promise; }
    throw new Error(url);
  };
  chat.sendMessage('first', []);
  await until(() => posts === 1);
  queue.enqueue('c', { id: 'q', text: 'important follow-up', files: [] });
  reply.resolve(response({ t: 'error', message: 'Provider unavailable' }, { t: 'end' }));
  await until(() => current().messages[1].status === 'error');
  assert.equal(posts, 1);
  assert.deepEqual(queue.queueOf('c').map(q => q.id), ['q']);
`));

test("interrupt explicitly sends a queued message after stopping", () => scenario(`
  let posts = 0;
  transport = async url => {
    if (url.endsWith('/stop')) return Response.json({ ok: true });
    if (url === '/api/pi/chat') {
      posts++;
      return posts === 1 ? new Response(new ReadableStream({}), { headers: { 'x-openchat-run': '1' } }) : response({ t: 'text', v: 'next' }, { t: 'end' });
    }
    throw new Error(url);
  };
  chat.sendMessage('first', []);
  await until(() => posts === 1);
  queue.enqueue('c', { id: 'q', text: 'interrupt', files: [] });
  chat.interruptWith('c', 'q');
  await until(() => current().messages.length === 4 && current().messages[3].status === 'done');
  assert.equal(current().messages[1].status, 'stopped');
  assert.equal(posts, 2);
`));
