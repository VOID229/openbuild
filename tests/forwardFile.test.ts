import { afterAll, expect, test } from "bun:test";
import { forwardBody, HELD_FILE_BYTES } from "../server/forwardFile";

// A forwarded file reply: what a proxy's fetch hands it, with the device's headers.
const reply = (body: ReadableStream<Uint8Array> | Uint8Array | null, length: number, status = 206) =>
  new Response(body as BodyInit | null, { status, headers: { "accept-ranges": "bytes", "content-length": String(length), "content-range": `bytes 0-${length - 1}/${length}` } });

/** A body that sends `first`, then nothing more until it's cancelled, which it records. */
function stalling(first: Uint8Array) {
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(first);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

test("a held file comes through whole, with its length", async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(1000));
  // Sent in pieces, as a socket would.
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      for (let at = 0; at < bytes.length; at += 300) {
        c.enqueue(bytes.slice(at, at + 300));
        await Bun.sleep(5);
      }
      c.close();
    },
  });
  const out = await forwardBody(reply(body, bytes.length), new Headers({ "content-range": `bytes 0-999/1000` }));
  expect(out.status).toBe(206);
  expect(new Uint8Array(await out.arrayBuffer())).toEqual(bytes);
});

test("a device that stalls mid-file is cut off, and the proxy answers instead of hanging", async () => {
  const { body, state } = stalling(new Uint8Array(4));
  const started = Date.now();
  const out = await forwardBody(reply(body, 10), new Headers(), undefined, 100);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(out.status).toBe(504);
  expect(((await out.json()) as { error: string }).error).toContain("stopped sending");
  expect(state.cancelled).toBe(true);
});

test("the browser going away stops a held read and lets go of the device", async () => {
  const { body, state } = stalling(new Uint8Array(4));
  const browser = new AbortController();
  const answer = forwardBody(reply(body, 10), new Headers(), browser.signal, 60_000);
  await Bun.sleep(20);
  browser.abort();
  const started = Date.now();
  expect((await answer).status).toBe(504);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(state.cancelled).toBe(true);
});

test("a reply shorter or longer than its length isn't passed on as the file", async () => {
  const short = new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new Uint8Array(4)), c.close()) });
  expect((await forwardBody(reply(short, 10), new Headers())).status).toBe(504);
  const long = new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(new Uint8Array(12)), c.close()) });
  expect((await forwardBody(reply(long, 10), new Headers())).status).toBe(504);
});

test("one too big to hold streams on as it arrives, without waiting for its end", async () => {
  const { body } = stalling(new Uint8Array(4));
  const out = await forwardBody(reply(body, HELD_FILE_BYTES + 1), new Headers(), undefined, 100);
  expect(out.status).toBe(206);
  const reader = out.body!.getReader();
  expect((await reader.read()).value?.byteLength).toBe(4);
  await reader.cancel();
});

// Through a real server, as the proxies use it: the length always reaches the browser, and a
// stalled device gets an answer to the browser rather than an open request. The device is raw TCP:
// a Bun.serve one couldn't send a length with a body that stalls (forwardFile.ts).
const device = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    data(socket, data) {
      const stall = new TextDecoder().decode(data).startsWith("GET /stall ");
      const head = "HTTP/1.1 206 Partial Content\r\naccept-ranges: bytes\r\ncontent-range: bytes 0-9/10\r\ncontent-length: 10\r\n\r\n";
      // A stalled one sends 4 of its 10 bytes and then nothing, keeping the connection open.
      socket.write(Buffer.concat([Buffer.from(head), Buffer.alloc(stall ? 4 : 10, 7)]));
    },
  },
});
const proxy = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const res = await fetch(`http://127.0.0.1:${device.port}${new URL(req.url).pathname}`);
    return forwardBody(res, new Headers({ "content-range": res.headers.get("content-range")! }), req.signal, 200);
  },
});
afterAll(() => {
  proxy.stop(true);
  device.stop(true);
});

test("through a server, a held file always has its length, and a stall ends in an answer", async () => {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/file`);
    expect({ status: res.status, length: res.headers.get("content-length") }).toEqual({ status: 206, length: "10" });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(10).fill(7));
  }
  const stalled = await fetch(`http://127.0.0.1:${proxy.port}/stall`, { signal: AbortSignal.timeout(5000) });
  expect(stalled.status).toBe(504);
});
