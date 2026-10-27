import { expect, test } from "bun:test";

/** Run a client-side script in a child process with the app's browser globals stubbed. */
async function run(script: string) {
  const prelude = `
    import { strict as assert } from 'node:assert';
    globalThis.window = globalThis;
    globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
    globalThis.addEventListener = () => {};
    globalThis.removeEventListener = () => {};
    globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    // Only the chat request is interesting here; the app also asks for its config and state.
    const chat = async (answers) => async (url, init) => {
      if (String(url) !== '/api/pi/chat') return Response.json({ mode: 'local', convexUrl: null, serverId: 'server-1' });
      return answers(init);
    };
  `;
  const child = Bun.spawn([process.execPath, "-e", prelude + script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(err).toBe("");
  expect(code).toBe(0);
}

const answer = `new Response('{"t":"text","v":"Recovered"}\\n{"t":"done"}\\n{"t":"end"}\\n', { headers: { 'x-openchat-run': '1' } })`;
const durableStream = `{ id: 'reply-0123456789abcdef', via: 'server-1' }`;
const piRequest = `{ threadId: 'thread-[PHONE]', cwd: '/tmp', model: 'openai/gpt', effort: 'off', message: 'hi', prior: 0, stream: { id: 'reply-0123456789abcdef' } }`;

test("Durable reconnect outlasts the ordinary ten-minute resume deadline", async () => {
  await run(`
    let time = 0, attempts = 0;
    Date.now = () => (time += 11 * 60_000);
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('/api/chat/runs/')) {
        if (++attempts === 1) return new Response(null, { status: 503 });
        return ${answer};
      }
      return Response.json({ mode: 'local', convexUrl: null, serverId: 'server-1' });
    };
    const { streamChat } = await import('./src/lib/api.ts');
    const events = [];
    for await (const e of streamChat(undefined, ${durableStream}, 0, new AbortController().signal, true)) events.push(e.t);
    assert.equal(attempts, 2);
    assert.deepEqual(events, ['reset', 'text', 'done']);
  `);
});

test("a Durable turn posts again through a gateway error instead of failing", async () => {
  await run(`
    let posts = 0;
    globalThis.fetch = await chat(async () => {
      // A restart (or the proxy in front of it) answers 502 while the server is down.
      if (++posts === 1) return new Response('Bad Gateway', { status: 502 });
      return ${answer};
    });
    const { streamChat } = await import('./src/lib/api.ts');
    const events = [];
    for await (const e of streamChat(${piRequest}, ${durableStream}, 0, new AbortController().signal, true)) events.push(e.t);
    assert.equal(posts, 2);
    assert.deepEqual(events, ['text', 'done']);
  `);
});

test("an ordinary Pi turn probes its persisted run after a gateway error", async () => {
  await run(`
    let posts = 0, gets = 0;
    globalThis.fetch = async (url) => {
      if (String(url) === '/api/pi/chat') { posts++; return new Response('Bad Gateway', { status: 502 }); }
      if (String(url).startsWith('/api/chat/runs/')) { gets++; return ${answer}; }
      return Response.json({ mode: 'local', convexUrl: null, serverId: 'server-1' });
    };
    const { streamChat } = await import('./src/lib/api.ts');
    const events = [];
    for await (const e of streamChat(${piRequest}, ${durableStream}, 0, new AbortController().signal, false)) events.push(e);
    assert.equal(posts, 1);
    assert.equal(gets, 1);
    assert.deepEqual(events.map((e) => e.t), ['reset', 'text', 'done']);
  `);
});

test("Durable keeps retrying a request the server hasn't admitted yet", async () => {
  await run(`
    let time = 0, posts = 0;
    // Well past the ordinary 30s "couldn't reach the server" deadline.
    Date.now = () => (time += 60_000);
    globalThis.fetch = await chat(async () => (++posts < 3 ? new Response(null, { status: 503 }) : ${answer}));
    const { streamChat } = await import('./src/lib/api.ts');
    const events = [];
    for await (const e of streamChat(${piRequest}, ${durableStream}, 0, new AbortController().signal, true)) events.push(e.t);
    assert.equal(posts, 3);
    assert.deepEqual(events, ['text', 'done']);
  `);
});

test("a message sent while the Durable thread is busy waits for its turn", async () => {
  await run(`
    let posts = 0;
    globalThis.fetch = await chat(async () => {
      if (++posts < 3) return Response.json({ error: 'This durable thread is still working', code: 'busy' }, { status: 409 });
      return ${answer};
    });
    const { streamChat } = await import('./src/lib/api.ts');
    const events = [];
    for await (const e of streamChat(${piRequest}, ${durableStream}, 0, new AbortController().signal, true)) events.push(e);
    assert.equal(posts, 3);
    assert.deepEqual(events.map((e) => e.t), ['notice', 'text', 'done']);
    assert.match(events[0].message, /Waiting for this thread/);
  `);
});

test("a Durable error that retrying can't fix is reported, not retried", async () => {
  await run(`
    let posts = 0;
    globalThis.fetch = await chat(async () => {
      posts++;
      return Response.json({ error: 'Durable history rewinds/imports are not supported; start a new thread', code: 'unsupported' }, { status: 409 });
    });
    const { streamChat } = await import('./src/lib/api.ts');
    const events = [];
    for await (const e of streamChat(${piRequest}, ${durableStream}, 0, new AbortController().signal, true)) events.push(e);
    assert.equal(posts, 1);
    assert.deepEqual(events.map((e) => e.t), ['error']);
    assert.match(events[0].message, /rewinds/);
  `);
});
