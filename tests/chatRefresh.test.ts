import { expect, test } from "bun:test";
import { createChatRefresh } from "../server/chatRefresh";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("startup is bounded, while discovery continues and polls share its result", async () => {
  const gate = deferred();
  let calls = 0;
  let done = false;
  const refresh = createChatRefresh(async () => {
    calls++;
    await gate.promise;
    done = true;
  }, () => {});
  await refresh(5);
  expect(calls).toBe(1);
  expect(done).toBe(false);
  let polled = false;
  const poll = refresh().then(() => { polled = true; });
  await refresh(5);
  expect(calls).toBe(1);
  expect(polled).toBe(false);
  gate.resolve();
  await poll;
  expect(done).toBe(true);
  await refresh();
  expect(calls).toBe(2);
});

test("fast refreshes complete before startup returns", async () => {
  let done = false;
  const refresh = createChatRefresh(async () => { done = true; }, () => {});
  await refresh(100);
  expect(done).toBe(true);
});

test("background errors are handled and the next request retries", async () => {
  const gate = deferred();
  const errors: unknown[] = [];
  let calls = 0;
  const refresh = createChatRefresh(async () => {
    calls++;
    await gate.promise;
    throw new Error("worker unavailable");
  }, (error) => { errors.push(error); });
  await refresh(5);
  const poll = refresh();
  gate.resolve();
  await poll;
  expect(errors).toHaveLength(1);
  await refresh();
  expect(calls).toBe(2);
  expect(errors).toHaveLength(2);
});

test("chat preload and retry share a request, failures retry, later polls request fresh discovery", async () => {
  // Isolate browser globals and module state from the rest of the suite.
  const script = `
    import "fake-indexeddb/auto";
    import { strict as assert } from "node:assert";
    const urls = [];
    let fail = true;
    globalThis.fetch = async (url) => {
      if (url === "/api/config") return Response.json({ mode: "local" });
      urls.push(url);
      if (fail) return new Response("unavailable", { status: 503 });
      return Response.json({ index: [] });
    };
    const { loadChats } = await import("./src/lib/db.ts");
    const first = loadChats();
    assert.equal(loadChats(), first);
    await assert.rejects(first);
    fail = false;
    assert.deepEqual(await loadChats(), []);
    assert.deepEqual(await loadChats(), []);
    assert.deepEqual(urls, ["/api/chats?index&startup", "/api/chats?index&startup", "/api/chats?index"]);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: `${import.meta.dir}/..`, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${out}\n${err}`);
  expect(code).toBe(0);
});
