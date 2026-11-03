import { afterEach, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { appWebsocket, type StreamSocketData } from "../server/streamTransport";
import { streamFetch } from "../src/lib/streamTransport";
import { streamPath } from "../shared/streamTransport";

const originalWindow = globalThis.window;
const NativeSocket = globalThis.WebSocket;
const servers: { stop(close?: boolean): unknown }[] = [];
afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.WebSocket = NativeSocket;
  for (const server of servers.splice(0)) server.stop(true);
});

function fixture() {
  const calls: { path: string; method: string; body: string }[] = [];
  const outputs = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const cancelled = new Set<string>();
  const sockets = new Set<ServerWebSocket<StreamSocketData>>();
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1", websocket: {
      ...appWebsocket,
      open(ws: ServerWebSocket<StreamSocketData>) { sockets.add(ws); },
      close(ws: ServerWebSocket<StreamSocketData>) { sockets.delete(ws); appWebsocket.close(ws); },
    },
    async fetch(req, server) {
      const path = new URL(req.url).pathname;
      const authorize = (r: Request) => r.headers.get("cookie") === "session=test" ? undefined : new Response(null, { status: 401 });
      if (path === "/api/stream") {
        const denied = authorize(req);
        if (denied) return denied;
        const data: StreamSocketData = { kind: "stream", request: req, base: server.url.origin, authorize, ctrl: new AbortController(), started: false };
        if (server.upgrade(req, { data })) return;
        return new Response(null, { status: 426 });
      }
      if (authorize(req)) return new Response(null, { status: 401 });
      calls.push({ path, method: req.method, body: await req.text() });
      if (path.endsWith("/missing")) return Response.json({ error: "missing" }, { status: 404 });
      if (path === "/api/pi/job") return new Response(null, { status: 204 });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { outputs.set(path, controller); controller.enqueue(new TextEncoder().encode("first\n")); },
        cancel() { cancelled.add(path); },
      }), { headers: { "content-type": "application/x-ndjson", "x-openchat-run": "1" } });
    },
  });
  servers.push(server);
  globalThis.window = { location: new URL(server.url) } as unknown as Window & typeof globalThis;
  class BrowserSocket extends NativeSocket {
    constructor(url: string | URL) { super(url, { headers: { cookie: "session=test" } } as unknown as string[]); }
  }
  globalThis.WebSocket = BrowserSocket;
  return { server, calls, outputs, cancelled, sockets };
}
const tick = () => Bun.sleep(10);
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  throw new Error("condition timed out");
}

test("more than six concurrent replies stream independently; HTTP control requests remain free", async () => {
  const f = fixture();
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => streamFetch(`/api/chat/runs/${i}`)));
  expect(responses.every(r => r.ok && r.headers.get("x-openchat-run") === "1")).toBe(true);
  const readers = responses.map(r => r.body!.getReader());
  for (const reader of readers) expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
  const control = await fetch(new URL("/api/pi/job", f.server.url), { headers: { cookie: "session=test" } });
  expect(control.status).toBe(204);
  for (const [path, output] of f.outputs) { output.enqueue(new TextEncoder().encode(`${path} ✓ שלום\n`)); output.close(); }
  const texts = await Promise.all(readers.map(async reader => { let text = ""; for (;;) { const r = await reader.read(); if (r.done) return text; text += new TextDecoder().decode(r.value); } }));
  expect(texts).toEqual(Array.from({ length: 12 }, (_, i) => `/api/chat/runs/${i} ✓ שלום\n`));
});

test("POST admission is sent once, paired paths and response errors retain HTTP semantics", async () => {
  const f = fixture();
  const path = "/api/devices/device/api/pi/chat";
  const res = await streamFetch(path, { method: "POST", body: JSON.stringify({ prompt: "once" }) });
  f.outputs.get(path)!.close();
  await res.text();
  expect(f.calls).toEqual([{ path, method: "POST", body: '{"prompt":"once"}' }]);
  const missing = await streamFetch("/api/chat/runs/missing");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "missing" });
  expect((await streamFetch("/api/pi/job")).status).toBe(204);
});

test("cancelling one watcher releases its upstream without cancelling other watchers", async () => {
  const f = fixture();
  const a = await streamFetch("/api/chat/runs/a");
  const b = await streamFetch("/api/pi/shells/b");
  await a.body!.cancel();
  await until(() => f.cancelled.has("/api/chat/runs/a"));
  expect(f.cancelled.has("/api/pi/shells/b")).toBe(false);
  f.outputs.get("/api/pi/shells/b")!.close();
  expect(await b.text()).toBe("first\n");
});

test("abort works before headers and after headers; socket loss never silently reposts admission", async () => {
  const f = fixture();
  const ctrl = new AbortController();
  const res = await streamFetch("/api/chat", { method: "POST", body: "{}", signal: ctrl.signal });
  ctrl.abort();
  await expect(res.text()).rejects.toThrow();
  await until(() => f.cancelled.has("/api/chat"));
  const second = await streamFetch("/api/pi/chat", { method: "POST", body: "{}" });
  // Drop the actual transport. Erroring an HTTP response controller can look like
  // clean EOF in Bun, so it does not reliably simulate a lost WebSocket.
  for (const socket of f.sockets) socket.terminate();
  await expect(second.text()).rejects.toThrow("Stream disconnected");
  expect(f.calls.filter(c => c.path === "/api/pi/chat")).toHaveLength(1);
  const aborted = new AbortController(); aborted.abort();
  await expect(streamFetch("/api/chat", { method: "POST", signal: aborted.signal })).rejects.toThrow();
});

test("stream routing excludes external hosts, control actions, traversal and arbitrary endpoints", () => {
  for (const path of ["//evil/api/chat", "https://evil/api/chat", "/api/pi/chat/../providers", "/api/stream", "/api/auth/login", "/api/chat/runs/x/stop", "/api/devices/d/api/keys", "/api/pi/threads/x/shell#x"]) {
    expect(streamPath(path, "GET") || streamPath(path, "POST")).toBe(false);
  }
  expect(streamPath("/api/devices/d/api/terminals/x", "GET")).toBe(true);
  expect(streamPath("/api/pi/threads/x/shell", "POST")).toBe(true);
});

test("older servers fall back before sending any socket request", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("legacy") });
  servers.push(server);
  globalThis.window = { location: new URL(server.url) } as unknown as Window & typeof globalThis;
  const res = await streamFetch("/api/chat/runs/old");
  expect(await res.text()).toBe("legacy");
});

test("large replay with split UTF-8 stays complete while a stalled watcher does not block controls", async () => {
  const f = fixture();
  const res = await streamFetch("/api/chat/runs/large");
  const text = "🙂שלום".repeat(600_000);
  const bytes = new TextEncoder().encode(text);
  // Split inside the first multi-byte character, then send a replay larger than the buffer.
  f.outputs.get("/api/chat/runs/large")!.enqueue(bytes.subarray(0, 1));
  f.outputs.get("/api/chat/runs/large")!.enqueue(bytes.subarray(1));
  f.outputs.get("/api/chat/runs/large")!.close();
  await tick();
  const control = await fetch(new URL("/api/pi/job", f.server.url), { headers: { cookie: "session=test" } });
  expect(control.status).toBe(204);
  expect(await res.text()).toBe("first\n" + text);
});
