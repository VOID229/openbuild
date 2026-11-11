import { expect, test } from "bun:test";
import { requestUsage } from "../server/usage/remoteRequest";

test("an offline/slow device has one deadline across all addresses", async () => {
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch() {
    requests++;
    await Bun.sleep(2000);
    return Response.json({ ok: true });
  } });
  try {
    const start = Date.now();
    await expect(requestUsage([server.url.href, server.url.href, server.url.href], "/usage", "test", 30))
      .rejects.toThrow("didn't answer in time");
    expect(Date.now() - start).toBeLessThan(1500);
    expect(requests).toBe(1);
  } finally { server.stop(true); }
});

test("a deadline timer firing before the wall clock reaches it doesn't start another address", async () => {
  // Bun 1.3.8 can fire the timeout a fraction early by Date.now(); freeze the clock to make that certain.
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch() {
    requests++;
    await Bun.sleep(150);
    return Response.json({ ok: true });
  } });
  const now = Date.now;
  const frozen = now();
  Date.now = () => frozen;
  try {
    await expect(requestUsage([server.url.href, server.url.href, server.url.href], "/usage", "test", 30))
      .rejects.toThrow("didn't answer in time");
    expect(requests).toBe(1);
  } finally {
    Date.now = now;
    server.stop(true);
  }
});

test("timeout also covers a response whose body never finishes", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); } }));
  } });
  try {
    await expect(requestUsage([server.url.href], "/usage", "test", 30)).rejects.toThrow("didn't answer in time");
  } finally { server.stop(true); }
});

test("tries another address after an immediate HTTP failure", async () => {
  let calls = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    calls++;
    expect(req.headers.get("authorization")).toBe("Bearer test");
    return calls === 1 ? new Response(null, { status: 503 }) : Response.json({ ok: true });
  } });
  try {
    expect(await requestUsage<{ ok: boolean }>([server.url.href, server.url.href], "/usage", "test")).toEqual({ ok: true });
    expect(calls).toBe(2);
  } finally { server.stop(true); }
});

test("a revoked pairing says so instead of trying every address", async () => {
  let calls = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    calls++;
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  } });
  try {
    await expect(requestUsage([server.url.href, server.url.href], "/usage", "test")).rejects.toThrow("no longer accepts this pairing");
    expect(calls).toBe(1);
  } finally { server.stop(true); }
});
