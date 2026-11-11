import { expect } from "bun:test";

/** Fresh browser modules and fake transport per scenario. Never contacts a service or user DB. */
export async function scenario(body: string) {
  const child = Bun.spawn([process.execPath, "-e", `
    import { strict as assert } from 'node:assert';
    const ls = new Map();
    globalThis.window = globalThis;
    globalThis.innerWidth = 1280;
    globalThis.document = { addEventListener() {}, removeEventListener() {}, hidden: true, visibilityState: 'visible' };
    globalThis.addEventListener = globalThis.removeEventListener = () => {};
    globalThis.localStorage = { getItem: k => ls.get(k) ?? null, setItem: (k,v) => ls.set(k,v), removeItem: k => ls.delete(k), key: i => [...ls.keys()][i], get length() { return ls.size; } };
    const tick = () => Bun.sleep(5);
    const until = async (fn) => { for (let n = 0; n < 100 && !fn(); n++) await tick(); assert.ok(fn(), 'condition timed out'); };
    const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
    const response = (...events) => new Response(events.map(e => JSON.stringify(e) + '\\n').join(''), { headers: { 'x-openchat-run': '1' } });
    let transport = async (url, init) => { throw new Error('Unexpected request: ' + url); };
    let transportState = false;
    globalThis.fetch = async (url, init) => {
      if (url === '/api/config') return Response.json({ mode: 'local', convexUrl: null, serverId: 'server-1' });
      if (url === '/api/state' && init?.method !== 'PUT') return Response.json({ state: null });
      if (url === '/api/state' && !transportState) return Response.json({ ok: true });
      if (String(url).startsWith('/api/chats/') && init?.method === 'PUT') return Response.json({ v: 'saved' });
      return transport(String(url), init);
    };
    const { config } = await import('./src/lib/runtime.ts'); await config;
    const { useStore } = await import('./src/lib/store.ts');
    await useStore.persist.rehydrate();
    const chat = await import('./src/lib/chat.ts');
    const queue = await import('./src/lib/queue.ts');
    const model = { id: 'test/model', name: 'Test', input: ['text'], reasoning: { efforts: ['medium'] } };
    const base = { id: 'c', title: 'test', createdAt: 1, updatedAt: 1, runtime: 'pi', workspace: { cwd: '/offline', mode: 'scratch' }, messages: [] };
    useStore.setState({ chats: [base], activeChatId: 'c', detection: { pi: { plan: 'pi', status: 'valid', models: [model] } }, settings: { ...useStore.getState().settings, selection: { plan: 'pi', id: model.id }, naming: { enabled: false, models: [] } } });
    const current = () => useStore.getState().chats.find(c => c.id === 'c');
    ${body}
    process.exit(0);
  `], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
}
