import { afterEach, expect, test } from "bun:test";
import { stopPreviews, PreviewSocket, createPreview, forwardPreview, localPreviewTarget, previewWebsocket } from "../server/preview";

const cleanup: (() => void)[] = [];
afterEach(() => { stopPreviews(); for (const stop of cleanup.splice(0)) stop(); });

async function preview(remote?: { urls: string[]; token: string }, host = "127.0.0.1") {
  const upstream = Bun.serve({
    hostname: host, port: 0,
    fetch(req, server) {
      if (req.headers.get("upgrade") === "websocket" && server.upgrade(req)) return;
      const url = new URL(req.url);
      if (url.pathname === "/redirect") return Response.redirect(new URL("/asset.js", req.url));
      return Response.json({ path: url.pathname + url.search, cookie: req.headers.get("cookie"), authorization: req.headers.get("authorization"), method: req.method, body: null });
    },
    websocket: { message(ws, data) { ws.send(data); } },
  });
  cleanup.push(() => upstream.stop(true));
  const entry = createPreview(new URL(`http://localhost:${upstream.port}/nested?q=1`), new URL("http://127.0.0.1:3100"), remote);
  const response = await fetch(entry, { redirect: "manual" });
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { origin: new URL(entry).origin, cookie, upstream, response };
}

test("loopback preview preserves root assets, queries and redirects without leaking app credentials", async () => {
  const { origin, cookie, response } = await preview();
  expect(response.headers.get("location")).toBe(origin + "/nested?q=1");
  expect((await fetch(origin + "/asset.js")).status).toBe(401);
  const result = await fetch(origin + "/asset.js?x=2", { headers: { cookie: `${cookie}; openbuild_session=secret`, authorization: "Bearer secret" } });
  expect(await result.json()).toMatchObject({ path: "/asset.js?x=2", cookie: null, authorization: null });
  const redirect = await fetch(origin + "/redirect", { headers: { cookie }, redirect: "manual" });
  expect(redirect.headers.get("location")).toBe("/asset.js");
  expect((await fetch(origin + "/", { headers: { cookie, origin: "http://evil.invalid" } })).status).toBe(403);
});

test("hot reload WebSockets forward messages", async () => {
  const { origin, cookie } = await preview();
  await new Promise<void>((resolve, reject) => {
    const socket = new PreviewSocket(origin.replace("http:", "ws:") + "/hmr", { headers: { cookie } });
    const timeout = setTimeout(() => { socket.close(); reject(new Error("WebSocket timed out")); }, 3000);
    socket.onopen = () => socket.send("reload");
    socket.onmessage = event => { expect(event.data).toBe("reload"); clearTimeout(timeout); socket.close(); resolve(); };
    socket.onerror = () => { clearTimeout(timeout); reject(new Error("WebSocket failed")); };
  });
});

test("paired previews relay HTTP and WebSockets through the device API", async () => {
  const relay = Bun.serve({
    hostname: "127.0.0.1", port: 0, websocket: previewWebsocket,
    fetch(req, server) {
      if (req.headers.get("authorization") !== "Bearer device-secret") return new Response(null, { status: 403 });
      const url = new URL(req.url);
      return forwardPreview(req, localPreviewTarget(url.pathname.split("/").at(-1)!, url.searchParams.get("path")!), server);
    },
  });
  cleanup.push(() => relay.stop(true));
  const { origin, cookie } = await preview({ urls: [relay.url.href], token: "device-secret" });
  const response = await fetch(origin + "/remote?hello=yes", { headers: { cookie } });
  expect(await response.json()).toMatchObject({ path: "/remote?hello=yes", authorization: null });
  await new Promise<void>((resolve, reject) => {
    const socket = new PreviewSocket(origin.replace("http:", "ws:") + "/hmr", { headers: { cookie } });
    const timeout = setTimeout(() => { socket.close(); reject(new Error("Relay timed out")); }, 3000);
    socket.onopen = () => socket.send("paired reload");
    socket.onmessage = event => { expect(event.data).toBe("paired reload"); clearTimeout(timeout); socket.close(); resolve(); };
    socket.onerror = () => { clearTimeout(timeout); reject(new Error("Relay failed")); };
  });
});

test("targets cannot escape loopback and unsupported schemes fail clearly", () => {
  expect(localPreviewTarget("4321", "//evil.invalid/path").hostname).toBe("127.0.0.1");
  expect(() => localPreviewTarget("65536", "/")).toThrow();
  expect(() => createPreview(new URL("http://example.com"), new URL("http://localhost:3100"))).toThrow();
  expect(() => createPreview(new URL("http://localhost:4321"), new URL("https://app.example.com"))).toThrow("HTTPS");
});

test("IPv6-only loopback dev servers work too", async () => {
  const { origin, cookie } = await preview(undefined, "::1");
  const response = await fetch(origin + "/ipv6", { headers: { cookie } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ path: "/ipv6" });
});
