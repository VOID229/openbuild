import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { compressJson } from "../server/compress";

const big = { summaries: Array.from({ length: 2000 }, (_, i) => ({ id: `thread-${i}`, title: "A thread about the sidebar", messages: [] })) };
const request = (headers: Record<string, string> = { "accept-encoding": "gzip, deflate" }, method = "GET", host = "studio.tailnet.ts.net") =>
  new Request(`http://${host}/api/chats/summaries`, { method, headers });

test("large JSON goes gzipped to a browser across a network, with the handler's own headers kept", async () => {
  const res = await compressJson(request(), Response.json(big, { headers: { "x-openbuild-server": "srv", "cache-control": "no-store" } }));
  expect(res.headers.get("content-encoding")).toBe("gzip");
  expect(res.headers.get("vary")).toContain("accept-encoding");
  expect(res.headers.get("x-openbuild-server")).toBe("srv");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = new Uint8Array(await res.arrayBuffer());
  expect(body.byteLength).toBeLessThan(JSON.stringify(big).length / 5);
  expect(JSON.parse(gunzipSync(body).toString())).toEqual(big);
});

test("everything else passes through as it was", async () => {
  // This machine's own browser, a client that doesn't take gzip, and HEAD.
  for (const req of [request(undefined, "GET", "localhost:3100"), request(undefined, "GET", "127.0.0.1:3100"), request(undefined, "GET", "[::1]:3100"), request({}), request(undefined, "HEAD")]) {
    expect((await compressJson(req, Response.json(big))).headers.get("content-encoding")).toBeNull();
  }
  // A LAN or tailnet address is across a network.
  expect((await compressJson(request(undefined, "GET", "100.64.0.7:3100"), Response.json(big))).headers.get("content-encoding")).toBe("gzip");
  // Small answers, errors, and streams of events.
  const small = await compressJson(request(), Response.json({ ok: true }));
  expect(small.headers.get("content-encoding")).toBeNull();
  expect(await small.json()).toEqual({ ok: true });
  expect((await compressJson(request(), Response.json(big, { status: 500 }))).headers.get("content-encoding")).toBeNull();
  const ndjson = new Response("{}\n".repeat(10_000), { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
  expect(await compressJson(request(), ndjson)).toBe(ndjson);
  const events = new Response("data: {}\n\n".repeat(10_000), { headers: { "content-type": "text/event-stream" } });
  expect(await compressJson(request(), events)).toBe(events);
});
