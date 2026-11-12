import { test } from "bun:test";
import { scenario } from "./client-harness";

// A file attached in a thread is only held by the browser; it goes to the thread's machine when its
// message is actually sent, and the prompt then names where it is there.
const setup = `
  const { holdFile } = await import('./src/lib/localFiles.ts');
  const attach = (id, name) => { holdFile(id, new File([new Uint8Array(1000)], name, { type: 'video/mp4' })); return { id, name, mime: 'video/mp4', dataUrl: '', size: 1000, local: true }; };
  const calls = [];
  const put = (url) => { const u = new URL(url, 'http://x'); const id = u.pathname.split('/').pop(); return Response.json({ id, name: u.searchParams.get('name'), mime: 'video/mp4', size: 1000, path: '/data/attachments/' + id + '/' + u.searchParams.get('name') }); };
`;

test("sending uploads the held file first, and the prompt names its path on the machine", () => scenario(`
  ${setup}
  let posted;
  transport = async (url, init) => {
    calls.push(init?.method + ' ' + url.split('?')[0]);
    if (init?.method === 'PUT' && url.startsWith('/api/attachments/f1?')) return put(url);
    if (url === '/api/pi/chat') { posted = JSON.parse(init.body); return response({ t: 'text', v: 'ok' }, { t: 'end' }); }
    throw new Error(url);
  };
  chat.sendMessage('watch this', [attach('f1', 'talk.mp4')]);
  // The message is there at once, its file not yet anywhere else.
  assert.equal(current().messages[0].attachments[0].local, true);
  await until(() => current().messages[1]?.status === 'done');
  assert.deepEqual(calls, ['PUT /api/attachments/f1', 'POST /api/pi/chat']);
  assert.match(posted.message, /\\[Attached file "talk.mp4" \\(video\\/mp4, 1000 B\\) is saved at \\/data\\/attachments\\/f1\\/talk.mp4\\./);
  const [file] = current().messages[0].attachments;
  assert.equal(file.path, '/data/attachments/f1/talk.mp4');
  assert.equal(file.local, undefined);
`));

test("a queued message uploads nothing until its turn comes, so removing it leaves nothing behind", () => scenario(`
  ${setup}
  await queue.queuesReady;
  let controller; let posts = [];
  transport = async (url, init) => {
    calls.push(init?.method + ' ' + url.split('?')[0]);
    if (init?.method === 'PUT' && url.startsWith('/api/attachments/')) return put(url);
    if (url === '/api/pi/chat') {
      posts.push(JSON.parse(init.body));
      return posts.length === 1 ? new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { 'x-openchat-run': '1' } }) : response({ t: 'text', v: 'next' }, { t: 'end' });
    }
    throw new Error(url);
  };
  chat.sendMessage('first', []);
  await until(() => !!controller);
  queue.enqueue('c', { id: 'gone', text: 'never mind', files: [attach('f2', 'old.mp4')] });
  queue.enqueue('c', { id: 'kept', text: 'this one', files: [attach('f3', 'new.mp4')] });
  await Bun.sleep(30);
  queue.removeQueued('c', 'gone');
  assert.deepEqual(calls.filter(c => c.startsWith('PUT')), []);
  controller.enqueue(new TextEncoder().encode('{"t":"text","v":"done"}\\n{"t":"end"}\\n'));
  controller.close();
  await until(() => current().messages.length === 4 && current().messages[3].status === 'done');
  assert.deepEqual(calls.filter(c => c.startsWith('PUT')), ['PUT /api/attachments/f3']);
  assert.match(posts[1].message, /saved at \\/data\\/attachments\\/f3\\/new.mp4/);
`));

test("a file the machine won't take ends the turn with the reason; retrying uploads it again", () => scenario(`
  ${setup}
  let refuse = true; let posts = 0;
  transport = async (url, init) => {
    calls.push(init?.method + ' ' + url.split('?')[0]);
    if (init?.method === 'PUT') return refuse ? Response.json({ error: 'Files can be up to 4 GB.' }, { status: 413 }) : put(url);
    if (url === '/api/pi/chat') { posts++; return response({ t: 'text', v: 'ok' }, { t: 'end' }); }
    throw new Error(url);
  };
  chat.sendMessage('big one', [attach('f4', 'film.mp4')]);
  await until(() => current().messages[1]?.status === 'error');
  assert.match(current().messages[1].error, /film.mp4: Files can be up to 4 GB\\./);
  assert.equal(posts, 0);
  assert.equal(current().messages[0].attachments[0].local, true);
  refuse = false;
  chat.regenerate('c', current().messages[1].id);
  await until(() => current().messages.at(-1).status === 'done');
  assert.equal(posts, 1);
  assert.equal(current().messages[0].attachments[0].path, '/data/attachments/f4/film.mp4');
`));
