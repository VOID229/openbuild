import { expect, test } from "bun:test";
import { requestUsage } from "../server/usage/remoteRequest";

test("an offline/slow device has one deadline across all addresses", async () => {
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch() {
    requests++;
    await Bun.sleep(150);
    return Response.json({ ok: true });
  } });
  try {
    const start = Date.now();
    await expect(requestUsage([server.url.href, server.url.href, server.url.href], "/usage", "test", 30))
      .rejects.toThrow("didn't answer in time");
    expect(Date.now() - start).toBeLessThan(120);
    expect(requests).toBe(1);
  } finally { server.stop(true); }
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
