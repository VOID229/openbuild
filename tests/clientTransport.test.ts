import { test } from "bun:test";
import { scenario } from "./client-harness";

test("Stop cancels a silent reader even when fetch ignores the abort signal", () => scenario(`
  let cancelled = false;
  transport = async url => {
    if (url.endsWith('/stop')) return Response.json({ ok: true });
    if (url === '/api/pi/chat') return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'x-openchat-run': '1' } });
    throw new Error(url);
  };
  chat.sendMessage('work', []);
  await tick();
  chat.stopGeneration('c');
  await until(() => current().messages[1].status === 'stopped' && cancelled);
`));

test("a stalled request has a bounded header wait, even on a broken transport", () => scenario(`
  const { fetchWithTimeout } = await import('./src/lib/abort.ts');
  let signal;
  transport = async (url, init) => { signal = init.signal; return new Promise(() => {}); };
  await assert.rejects(fetchWithTimeout('/offline-stalled', {}, 10), e => e.name === 'TimeoutError');
  assert.equal(signal.aborted, true);
`));

test("a silent stream is cancelled and reattached rather than hanging forever", () => scenario(`
  const nativeTimeout = setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 45000 || ms === 500 ? 5 : ms, ...args);
  console.warn = () => {};
  let attempts = 0, cancelled = false;
  transport = async url => {
    assert.ok(url.startsWith('/api/chat/runs/'));
    if (++attempts === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    return response({ t: 'text', v: 'Recovered' }, { t: 'end' });
  };
  const { streamChat } = await import('./src/lib/api.ts');
  const got = [];
  for await (const e of streamChat(undefined, { id: 'reply-0123456789abcdef', via: 'server-1' }, 0, new AbortController().signal)) got.push(e.t);
  assert.deepEqual(got, ['reset', 'reset', 'text']);
  assert.equal(attempts, 2);
  assert.equal(cancelled, true);
`));
