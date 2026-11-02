import { expect, test } from "bun:test";
import { remoteRequest } from "../bin/remoteRequest";

test("status skips a stalled address, reports the working address and keeps the token", async () => {
  const stalled = Bun.serve({ port: 0, fetch: req => new Promise<Response>(resolve => {
    req.signal.addEventListener("abort", () => { resolve(new Response()); });
  }) });
  const working = Bun.serve({ port: 0, fetch: req => {
    expect(req.headers.get("authorization")).toBe("Bearer saved-token");
    return Response.json({ running: true });
  } });
  try {
    const start = Date.now();
    const answer = await remoteRequest({ urls: [stalled.url.origin, working.url.origin], token: "saved-token" }, "/api/remote/status", "GET");
    expect(answer.ok).toBe(true);
    expect(answer.base).toBe(working.url.origin);
    expect(Date.now() - start).toBeLessThan(1000);
  } finally { stalled.stop(true); working.stop(true); }
});

test("a revoked token is reported without discarding the pairing", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({}, { status: 401 }) });
  const device = { urls: [server.url.origin], token: "unchanged" };
  try {
    expect((await remoteRequest(device, "/api/remote/status", "GET")).status).toBe(401);
    expect(device.token).toBe("unchanged");
  } finally { server.stop(true); }
});
