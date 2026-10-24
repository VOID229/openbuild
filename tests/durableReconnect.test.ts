import { expect, test } from "bun:test";

test("Durable reconnect outlasts the ordinary ten-minute resume deadline", async () => {
  const script = `
    import { strict as assert } from 'node:assert';
    globalThis.window = globalThis;
    globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
    globalThis.addEventListener = () => {};
    globalThis.removeEventListener = () => {};
    globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
    let time = 0, attempts = 0;
    Date.now = () => (time += 11 * 60_000);
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('/api/chat/runs/')) {
        if (++attempts === 1) return new Response(null, { status: 503 });
        return new Response('{"t":"text","v":"Recovered"}\\n{"t":"done"}\\n{"t":"end"}\\n');
      }
      return Response.json({ mode: 'local', convexUrl: null, serverId: 'server-1' });
    };
    const { streamChat } = await import('./src/lib/api.ts');
    const events = [];
    for await (const e of streamChat(undefined, { id: 'reply-0123456789abcdef', via: 'server-1' }, 0, new AbortController().signal, true)) events.push(e.t);
    assert.equal(attempts, 2);
    assert.deepEqual(events, ['reset', 'text', 'done']);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(err).toBe("");
  expect(code).toBe(0);
});
