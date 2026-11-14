import { afterEach, expect, test } from "bun:test";
import { stopPreviews, PreviewSocket, createPreview, forwardPreview, localPreviewTarget, previewWebsocket } from "../server/preview";

const cleanup: (() => void)[] = [];
afterEach(() => { stopPreviews(); for (const stop of cleanup.splice(0)) stop(); });

type Remote = { urls: string[]; token: string; id?: string };

function devServer(host = "127.0.0.1", port = 0) {
  const upstream = Bun.serve({
    hostname: host, port,
    fetch(req, server) {
      if (req.headers.get("upgrade") === "websocket" && server.upgrade(req)) return;
      const url = new URL(req.url);
      if (url.pathname === "/redirect") return Response.redirect(new URL("/asset.js", req.url));
      if (url.pathname === "/to-localhost") return Response.redirect(`http://localhost:${server.port}/landed`);
      if (url.pathname === "/framed") return new Response("<p>hi</p>", { headers: { "content-type": "text/html", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'" } });
      if (url.pathname === "/unavailable") return new Response("dev server's own 503", { status: 503 });
      return Response.json({ path: url.pathname + url.search, cookie: req.headers.get("cookie"), authorization: req.headers.get("authorization"), method: req.method, origin: req.headers.get("origin") });
    },
    websocket: {
      message(ws, data) {
        if (data === "die") ws.terminate();
        else if (data === "bye") ws.close(4001, "done");
        else ws.send(data);
      },
    },
  });
  cleanup.push(() => upstream.stop(true));
  return upstream;
}

async function open(entry: string) {
  const response = await fetch(entry, { redirect: "manual" });
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { origin: new URL(entry).origin, cookie, response };
}

async function preview(remote?: Remote, host = "127.0.0.1") {
  const upstream = devServer(host);
  const entry = createPreview(new URL(`http://localhost:${upstream.port}/nested?q=1`), new URL("http://127.0.0.1:3100"), remote);
  return { ...(await open(entry)), upstream };
}

/** A paired device's OpenBuild: /api/config answers as `id`, and the relay route reaches its loopback. */
function device(id = "device-1") {
  const relay = Bun.serve({
    hostname: "127.0.0.1", port: 0, websocket: previewWebsocket,
    fetch(req, server) {
      if (req.headers.get("authorization") !== "Bearer device-secret") return new Response(null, { status: 403 });
      const url = new URL(req.url);
      if (url.pathname === "/api/config") return Response.json({ serverId: id });
      return forwardPreview(req, localPreviewTarget(url.pathname.split("/").at(-1)!, url.searchParams.get("path")!), server);
    },
  });
  cleanup.push(() => relay.stop(true));
  return relay;
}

const socketTo = (origin: string, cookie: string) => new PreviewSocket(origin.replace("http:", "ws:") + "/hmr", { headers: { cookie } });
function echo(socket: WebSocket, text: string) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error("WebSocket timed out")); }, 3000);
    socket.onopen = () => socket.send(text);
    socket.onmessage = event => { expect(event.data).toBe(text); clearTimeout(timeout); resolve(); };
    socket.onerror = () => { clearTimeout(timeout); reject(new Error("WebSocket failed")); };
  });
}
const closed = (socket: WebSocket) => new Promise<CloseEvent>(resolve => { socket.onclose = resolve; });
const page = { "sec-fetch-dest": "iframe", accept: "text/html" };

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

test("a redirect to localhost on the dev server's port stays in the preview", async () => {
  const { origin, cookie } = await preview();
  const redirect = await fetch(origin + "/to-localhost", { headers: { cookie }, redirect: "manual" });
  expect(redirect.headers.get("location")).toBe("/landed");
});

test("pages that refuse framing still show in the panel", async () => {
  const { origin, cookie } = await preview();
  const response = await fetch(origin + "/framed", { headers: { cookie, ...page } });
  expect(response.headers.get("x-frame-options")).toBeNull();
  expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
  // The page keeps its cookie while it's in use.
  expect(response.headers.get("set-cookie")).toStartWith(cookie);
});

test("every page of a dev server shares one preview origin", async () => {
  const upstream = devServer();
  const app = new URL("http://127.0.0.1:3100");
  const a = createPreview(new URL(`http://localhost:${upstream.port}/a`), app);
  const b = createPreview(new URL(`http://127.0.0.1:${upstream.port}/b?x=1#top`), app);
  expect(new URL(a).origin).toBe(new URL(b).origin);
  const { origin } = await open(b);
  expect((await fetch(b, { redirect: "manual" })).headers.get("location")).toBe(origin + "/b?x=1#top");
  // A different dev server, or the app reached at another address, is another origin.
  expect(new URL(createPreview(new URL(`http://localhost:${devServer().port}/`), app)).origin).not.toBe(new URL(a).origin);
  expect(new URL(createPreview(new URL(`http://localhost:${upstream.port}/`), new URL("http://localhost:3100"))).host).toStartWith("localhost:");
});

test("the entry only ever redirects within the preview", async () => {
  const upstream = devServer();
  const entry = createPreview(new URL(`http://localhost:${upstream.port}/`), new URL("http://127.0.0.1:3100"));
  const evil = entry.replace(/\?to=.*$/, "?to=" + encodeURIComponent("//evil.invalid/x"));
  expect((await fetch(evil, { redirect: "manual" })).headers.get("location")).toBe(new URL(entry).origin + "/x");
});

test("hot reload WebSockets forward messages, and a dev server that dies ends them abruptly", async () => {
  const { origin, cookie } = await preview();
  const socket = socketTo(origin, cookie);
  await echo(socket, "reload");
  const end = closed(socket);
  socket.send("die");
  // Not a clean close: an HMR client takes that as "server lost" and reloads once it's back.
  expect((await end).code).toBe(1006);
  const polite = socketTo(origin, cookie);
  await echo(polite, "hi");
  const politeEnd = closed(polite);
  polite.send("bye");
  expect(await politeEnd).toMatchObject({ code: 4001, reason: "done" });
});

test("a page asked for before its dev server is up waits for it, then loads", async () => {
  const port = devServer().port;
  stopPreviews();
  for (const stop of cleanup.splice(0)) stop();
  const entry = createPreview(new URL(`http://localhost:${port}/`), new URL("http://127.0.0.1:3100"));
  const { origin, cookie } = await open(entry);
  const waiting = await fetch(origin + "/", { headers: { cookie, ...page } });
  expect(waiting.status).toBe(502);
  expect(waiting.headers.get("content-type")).toContain("text/html");
  expect(await waiting.text()).toContain("Waiting for the dev server");
  // A script or fetch gets a plain answer, marked so the waiting page's own check can tell.
  const asset = await fetch(origin + "/main.js", { headers: { cookie } });
  expect(asset.status).toBe(502);
  expect(asset.headers.get("x-openbuild-preview-upstream")).toBe("1");
  devServer("127.0.0.1", port);
  expect(await (await fetch(origin + "/now", { headers: { cookie } })).json()).toMatchObject({ path: "/now" });
});

test("a page without the preview's cookie asks the panel for a fresh preview", async () => {
  const { origin } = await preview();
  const response = await fetch(origin + "/", { headers: page });
  expect(response.status).toBe(401);
  expect(await response.text()).toContain(`postMessage({openbuildPreview:"expired"}`);
});

test("paired previews relay HTTP and WebSockets through the device API", async () => {
  const relay = device();
  const { origin, cookie } = await preview({ urls: [relay.url.href], token: "device-secret", id: "device-1" });
  const response = await fetch(origin + "/remote?hello=yes", { headers: { cookie } });
  expect(await response.json()).toMatchObject({ path: "/remote?hello=yes", authorization: null });
  // The dev server's own errors are its own, not the device being unreachable.
  const unavailable = await fetch(origin + "/unavailable", { headers: { cookie } });
  expect(unavailable.status).toBe(503);
  expect(await unavailable.text()).toBe("dev server's own 503");
  const post = await fetch(origin + "/form", { method: "POST", body: "a=1", headers: { cookie, origin } });
  expect(await post.json()).toMatchObject({ method: "POST", origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) });
  await echo(socketTo(origin, cookie), "paired reload");
});

test("paired previews skip an address that stalls or reaches another OpenBuild, once, not on every request", async () => {
  const relay = device();
  let stalledHits = 0;
  const stalled = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => { stalledHits++; return new Promise<Response>(resolve => req.signal.addEventListener("abort", () => resolve(new Response()))); } });
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "Unknown device token" }, { status: 401, headers: { "x-openbuild-server": "someone-else" } }) });
  cleanup.push(() => { stalled.stop(true); other.stop(true); });
  const { origin, cookie } = await preview({ urls: [other.url.href, stalled.url.href, relay.url.href], token: "device-secret", id: "device-1" });
  const started = Date.now();
  for (let i = 0; i < 5; i++) expect(await (await fetch(origin + `/asset${i}.js`, { headers: { cookie } })).json()).toMatchObject({ path: `/asset${i}.js` });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(stalledHits).toBe(1);
  await echo(socketTo(origin, cookie), "found it");
});

test("a paired device whose dev server is down shows the waiting page, and an unreachable one says so", async () => {
  const relay = device();
  const free = devServer().port;
  for (const stop of cleanup.splice(-1)) stop();
  const entry = createPreview(new URL(`http://localhost:${free}/`), new URL("http://127.0.0.1:3100"), { urls: [relay.url.href], token: "device-secret", id: "device-1" });
  const { origin, cookie } = await open(entry);
  const waiting = await fetch(origin + "/", { headers: { cookie, ...page } });
  expect(waiting.status).toBe(502);
  expect(await waiting.text()).toContain("Waiting for the dev server");
  relay.stop(true);
  const gone = await fetch(origin + "/", { headers: { cookie, ...page } });
  expect(gone.status).toBe(502);
  expect(await gone.text()).toContain("Couldn't reach the paired device");
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

test("a preview listens on the address the app was reached on", async () => {
  const upstream = devServer();
  const entry = createPreview(new URL(`http://localhost:${upstream.port}/`), new URL("http://127.0.0.1:3100"), undefined, "127.0.0.1");
  const { origin, cookie } = await open(entry);
  expect((await fetch(origin + "/x", { headers: { cookie } })).status).toBe(200);
  // Not on every interface: the dev server's preview isn't exposed wider than the app is.
  const port = new URL(entry).port;
  const reached = await fetch(`http://127.0.0.2:${port}/x`).then(() => true, () => false);
  expect(reached).toBe(false);
});
