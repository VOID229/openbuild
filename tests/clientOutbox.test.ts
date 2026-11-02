import { expect, test } from "bun:test";

test("outbox acknowledgement cannot delete a newer IndexedDB write", async () => {
  const script = `
    import 'fake-indexeddb/auto';
    import { strict as assert } from 'node:assert';
    const { createStore, set, get, delIf } = await import('./src/lib/kv.ts');
    const store = createStore('offline-outbox-regression', 'ops');
    await set('c', { seq: 1 }, store);
    const acknowledged = await get('c', store);
    // A newer local edit lands after the acknowledgement read, before its deletion.
    const newer = set('c', { seq: 2 }, store);
    await delIf('c', current => current?.seq === acknowledged.seq, store);
    await newer;
    assert.deepEqual(await get('c', store), { seq: 2 });
    await delIf('c', current => current?.seq === 2, store);
    assert.equal(await get('c', store), undefined);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
});
