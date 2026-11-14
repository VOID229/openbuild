// One isolated origin per previewed dev server. Only this listener is exposed, never the dev server.
// Paired-device requests travel through its authenticated OpenBuild API, including WebSockets.
//
// A preview is a listener on a port of its own (a different origin from the app, so a dev page
// can't reach the app's API or cookies), on the address the app itself was reached on. One listener
// serves every page of a dev server (`localhost:5173/`, `/about`, …): it lives while it's in use
// and stops after LIFETIME without a request or an open socket.
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";

// DOM typings omit Bun's server-side connection headers.
export const PreviewSocket = WebSocket as unknown as { new(url: string | URL, options: Bun.WebSocketOptions): WebSocket };

/** Says a device's relay answered 502 because its dev server is down, not because the device is unreachable. */
const UPSTREAM_DOWN = "x-openbuild-preview-upstream";
/**
 * Says the page's request had an Origin, across the relay: the device then gives the dev server its
 * own loopback origin, as a local preview does (CSRF checks such as SvelteKit's refuse a POST without one).
 */
const HAD_ORIGIN = "x-openbuild-preview-origin";
/** Same as devices.SERVER_HEADER: which OpenBuild answered. Not imported, so this module stays free of the data directory. */
const SERVER_HEADER = "x-openbuild-server";

type Bridge = { upstream: WebSocket | Promise<WebSocket | undefined>; pending: (string | Buffer)[]; session?: Session };
// Close codes a peer can't send (they only describe how a socket ended), and the reserved ones.
const sendable = (code: number) => code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);

function bridge(ws: ServerWebSocket<Bridge>, upstream: WebSocket) {
  ws.data.upstream = upstream;
  upstream.onmessage = (event) => ws.send(event.data);
  // A dev server that went away (killed, restarting) ends its socket abruptly: end ours the same
  // way, so the page's HMR client sees a lost connection and reloads once the server is back.
  upstream.onclose = (event) => (sendable(event.code) ? ws.close(event.code, event.reason) : ws.terminate());
  upstream.onerror = () => ws.terminate();
  const flush = () => { for (const data of ws.data.pending.splice(0)) upstream.send(typeof data === "string" ? data : new Uint8Array(data)); };
  if (upstream.readyState > WebSocket.OPEN) ws.terminate();
  else if (upstream.readyState === WebSocket.OPEN) flush();
  else upstream.onopen = flush;
}

export const previewWebsocket = {
  open(ws: ServerWebSocket<Bridge>) {
    if (ws.data.session) ws.data.session.sockets++;
    const upstream = ws.data.upstream;
    if (!(upstream instanceof Promise)) return bridge(ws, upstream);
    void upstream.then((socket) => {
      if (!socket) return ws.terminate();
      if (ws.readyState > 1) return socket.close();
      bridge(ws, socket);
    });
  },
  message(ws: ServerWebSocket<Bridge>, data: string | Buffer) {
    const upstream = ws.data.upstream;
    if (!(upstream instanceof Promise) && upstream.readyState === WebSocket.OPEN) upstream.send(typeof data === "string" ? data : new Uint8Array(data));
    else if (ws.data.pending.length < 128) ws.data.pending.push(data);
    else ws.close(1013, "Preview busy");
  },
  close(ws: ServerWebSocket<Bridge>) {
    const session = ws.data.session;
    if (session) { session.sockets--; session.seen = Date.now(); }
    const upstream = ws.data.upstream;
    if (upstream instanceof Promise) void upstream.then((socket) => socket?.close());
    else upstream.close();
  },
};

export function localPreviewTarget(port: string, path: string): URL {
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) throw new Error("Invalid preview port");
  const url = new URL(`http://127.0.0.1:${port}`);
  // Assigning pathname instead of resolving a URL prevents //host escapes.
  const input = new URL(path, "http://preview.invalid");
  url.pathname = input.pathname;
  url.search = input.search;
  return url;
}

function cleanHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const key of ["host", "cookie", "authorization", "proxy-authorization", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "content-length", "origin", "referer", HAD_ORIGIN]) out.delete(key);
  return out;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
const isLoopback = (host: string) => LOOPBACK.has(host) || host.endsWith(".localhost");

/** Which loopback family each dev server port answered on last, so each request doesn't probe again. */
const loopbacks = new Map<number, string>();
async function loopbackAddress(port: number, fresh = false): Promise<string> {
  const known = loopbacks.get(port);
  if (known && !fresh) return known;
  // Probe both loopback families: Node-based dev servers often bind only ::1.
  const host = await Promise.any(["127.0.0.1", "::1"].map(host => new Promise<string>((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000, () => socket.destroy(new Error("Preview connection timed out")));
    socket.once("connect", () => { socket.destroy(); resolve(host); });
    socket.once("error", reject);
  })));
  loopbacks.set(port, host);
  return host;
}

/** A navigation (the frame's page itself), as opposed to a script, stylesheet or fetch from it. */
const isPage = (req: Request) => {
  const dest = req.headers.get("sec-fetch-dest");
  if (dest) return dest === "iframe" || dest === "document" || dest === "frame";
  return req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
};

const page = (title: string, body: string, script = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><title>${title}</title>
<style>html{font:13px/1.5 system-ui,sans-serif;color:#666;background:#fff}@media(prefers-color-scheme:dark){html{color:#999;background:#161616}}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;box-sizing:border-box}p{margin:4px 0;max-width:340px}b{font-weight:500;color:CanvasText}.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin-right:8px;vertical-align:middle;animation:p 1.2s ease-in-out infinite}@keyframes p{50%{opacity:.25}}</style></head>
<body><div>${body}</div>${script && `<script>${script}</script>`}</body></html>`;

/**
 * The frame's page while the dev server isn't answering (not started yet, restarting, crashed): it
 * checks again every second or so and loads the page as soon as the server is up, so a preview
 * opened a moment early doesn't stay on an error.
 */
function waiting(req: Request, message: string): Response {
  if (!isPage(req)) return new Response(message, { status: 502, headers: { [UPSTREAM_DOWN]: "1" } });
  const script = `let wait=800;const tick=()=>fetch(location.href,{cache:"no-store",credentials:"same-origin"}).then(r=>{if(r.headers.get("${UPSTREAM_DOWN}"))throw 0;location.reload()}).catch(()=>{wait=Math.min(wait*1.5,5000);setTimeout(tick,wait)});setTimeout(tick,wait);`;
  return new Response(page("Waiting for the dev server", `<p><span class="dot"></span><b>Waiting for the dev server…</b></p><p>${message}</p>`, script), {
    status: 502,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", [UPSTREAM_DOWN]: "1" },
  });
}
const DOWN = "Nothing is answering on the project's localhost port yet. This page loads as soon as it does.";

/** Lets the page frame through the preview: its origin is already isolated, and only OpenBuild can open it. */
function frameable(headers: Headers) {
  headers.delete("x-frame-options");
  const csp = headers.get("content-security-policy");
  if (csp) {
    const rest = csp.split(";").filter(d => !/^\s*frame-ancestors\b/i.test(d)).join(";").trim();
    if (rest) headers.set("content-security-policy", rest);
    else headers.delete("content-security-policy");
  }
}

/**
 * Send a preview's request on to `target`: the dev server on loopback, or (with `token`) a paired
 * device's relay route. `body`, when given, replaces the request's own (kept for another attempt).
 */
export async function forwardPreview(req: Request, target: URL, server: Bun.Server<Bridge>, { token, body, session }: { token?: string; body?: ArrayBuffer | null; session?: Session } = {}): Promise<Response | undefined> {
  const port = Number(target.port || 80);
  if (!token) {
    try {
      const address = await loopbackAddress(port);
      target.hostname = address === "::1" ? "[::1]" : address;
    } catch { return waiting(req, DOWN); }
  }
  const headers = cleanHeaders(req.headers);
  const origin = req.headers.has("origin") || req.headers.has(HAD_ORIGIN);
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
    if (origin) headers.set(HAD_ORIGIN, "1");
  }
  // Dev servers validate Host and Origin. They see a loopback origin, not the LAN client.
  else if (origin) headers.set("origin", target.origin);
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const protocols = req.headers.get("sec-websocket-protocol")?.split(",").map(p => p.trim());
    headers.delete("sec-websocket-protocol");
    const upstream = new PreviewSocket(target, { headers: Object.fromEntries(headers), protocols });
    upstream.binaryType = "arraybuffer";
    if (server.upgrade(req, { data: { upstream, pending: [], session } })) return;
    upstream.close();
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
  server.timeout(req, 0);
  const send = () => fetch(target, {
    method: req.method, headers, body: body === undefined ? req.body : body, redirect: "manual", signal: req.signal,
    // Bun otherwise decompresses while retaining the upstream encoding header.
    decompress: false,
  });
  let response: Response;
  try {
    response = await send();
  } catch (err) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    if (token) throw err;
    // The dev server moved between loopback families (restarted on ::1), or went down.
    try {
      const address = await loopbackAddress(port, true);
      target.hostname = address === "::1" ? "[::1]" : address;
      if (body === undefined && req.body) throw err;
      response = await send();
    } catch {
      loopbacks.delete(port);
      return waiting(req, DOWN);
    }
  }
  const out = new Headers(response.headers);
  for (const name of ["set-cookie", "connection", "transfer-encoding"]) out.delete(name);
  const location = out.get("location");
  if (location) {
    const next = new URL(location, target);
    // localhost, 127.0.0.1 and ::1 on the dev server's port are all the dev server.
    const same = next.origin === target.origin || (!token && /^https?:$/.test(next.protocol) && isLoopback(next.hostname) && (next.port || "80") === String(port));
    if (same) out.set("location", next.pathname + next.search + next.hash);
  }
  frameable(out);
  out.set("referrer-policy", "no-referrer");
  return new Response(response.body, { status: response.status, headers: out });
}

type Remote = { urls: string[]; token: string; id?: string; serverId?: string };
type Session = { server: Bun.Server<Bridge>; seen: number; sockets: number; secret: string; origin: string; key: string };
const sessions = new Map<string, Session>();
/** How long a preview nobody uses stays open. */
const LIFETIME = 8 * 60 * 60 * 1000;
let sweeper: ReturnType<typeof setInterval> | undefined;
function sweep() {
  for (const [key, session] of sessions) {
    if (session.sockets > 0 || Date.now() - session.seen < LIFETIME) continue;
    session.server.stop(true);
    sessions.delete(key);
  }
  if (!sessions.size && sweeper) { clearInterval(sweeper); sweeper = undefined; }
}

/**
 * The paired device's address that answers, first: each request of a page would otherwise wait for
 * an address that doesn't (a LAN address away from home) before trying the next.
 */
const preferred = new Map<string, string>();
const answeredByOther = (res: Response, remote: Remote) => {
  const answered = res.headers.get(SERVER_HEADER);
  return !!answered && !!(remote.serverId ?? remote.id) && answered !== (remote.serverId ?? remote.id);
};
/** The first saved address that answers as this device, asked all at once. */
async function reachable(remote: Remote): Promise<string | undefined> {
  const known = preferred.get(remote.token);
  if (known) return known;
  const found = await Promise.any(remote.urls.map(async (base) => {
    const res = await fetch(new URL("/api/config", base), { headers: { authorization: `Bearer ${remote.token}` }, signal: AbortSignal.timeout(4000) });
    void res.body?.cancel().catch(() => {});
    if (!res.ok || answeredByOther(res, remote)) throw new Error("Not this device");
    return base;
  })).catch(() => undefined);
  if (found) preferred.set(remote.token, found);
  return found;
}
const relayTarget = (base: string, port: string, path: string) => {
  const target = new URL(`/api/preview/relay/${port}`, base);
  target.searchParams.set("path", path);
  return target;
};

async function relay(req: Request, remote: Remote, port: string, path: string, server: Bun.Server<Bridge>, session: Session): Promise<Response | undefined> {
  const unreachable = () => new Response("Couldn't reach the paired device. Check that it's on and OpenBuild is running there.", { status: 502 });
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    // The socket is accepted at once and joined to the device's once its address is known.
    const upstream = reachable(remote).then((base) => {
      if (!base) return undefined;
      const target = relayTarget(base, port, path);
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      const headers = cleanHeaders(req.headers);
      headers.set("authorization", `Bearer ${remote.token}`);
      if (req.headers.has("origin")) headers.set(HAD_ORIGIN, "1");
      const protocols = req.headers.get("sec-websocket-protocol")?.split(",").map(p => p.trim());
      headers.delete("sec-websocket-protocol");
      const socket = new PreviewSocket(target, { headers: Object.fromEntries(headers), protocols });
      socket.binaryType = "arraybuffer";
      socket.addEventListener("error", () => preferred.delete(remote.token), { once: true });
      return socket;
    });
    if (server.upgrade(req, { data: { upstream, pending: [], session } })) return;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
  // Kept, so the request can go to another address if the first one fails.
  const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
  const tried = new Set<string>();
  for (let attempt = 0; attempt < remote.urls.length + 1; attempt++) {
    const base = await reachable(remote);
    if (!base || tried.has(base)) break;
    tried.add(base);
    try {
      const result = (await forwardPreview(req, relayTarget(base, port, path), server, { token: remote.token, body }))!;
      // The device answered, whatever the dev server's own status. Another OpenBuild at this
      // address (a reassigned IP) didn't.
      if (!answeredByOther(result, remote)) {
        preferred.set(remote.token, base);
        if (!result.headers.has(UPSTREAM_DOWN)) return result;
        await result.body?.cancel();
        return waiting(req, DOWN);
      }
      await result.body?.cancel();
    } catch {
      if (req.signal.aborted) return new Response(null, { status: 499 });
    }
    preferred.delete(remote.token);
  }
  return isPage(req) ? new Response(page("Paired device unreachable", "<p><b>Couldn't reach the paired device.</b></p><p>Check that it's on and OpenBuild is running there, then reload.</p>"), { status: 502, headers: { "content-type": "text/html; charset=utf-8" } }) : unreachable();
}

/** The expired-preview page: it asks the panel showing it for a fresh preview. */
const expired = (req: Request) => {
  if (!isPage(req)) return new Response("Preview expired. Reload it from OpenBuild.", { status: 401 });
  return new Response(page("Preview expired", "<p><b>This preview has expired.</b></p><p>Reload it from OpenBuild.</p>", `parent!==window&&parent.postMessage({openbuildPreview:"expired"},"*")`), {
    status: 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
};

/**
 * A preview of a localhost URL, as an address that opens it: on `app`'s host (the address the
 * browser reached OpenBuild at), bound to `bind` (the address that request arrived on).
 */
export function createPreview(url: URL, app: URL, remote?: Remote, bind?: string): string {
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) throw new Error("Preview requires an HTTP localhost URL");
  const port = url.port || "80";
  localPreviewTarget(port, "/");
  if (app.protocol !== "http:") throw new Error("Localhost previews currently require HTTP access to OpenBuild. HTTPS needs a separate TLS preview route.");
  sweep();
  const hostname = bind ?? ((process.env.HOST || "127.0.0.1").split(",").some(h => !["localhost", "127.0.0.1", "::1", "[::1]"].includes(h.trim())) ? "0.0.0.0" : "127.0.0.1");
  const key = `${hostname}|${app.origin}|${port}|${remote?.token ?? "local"}`;
  const to = url.pathname + url.search + url.hash;
  const entry = (session: Session) => `${session.origin}/__openbuild_preview/${session.secret}?to=${encodeURIComponent(to)}`;
  const existing = sessions.get(key);
  if (existing) {
    existing.seen = Date.now();
    return entry(existing);
  }
  if (sessions.size >= 32) throw new Error("Too many open previews. Try again after older previews expire.");
  const secret = randomBytes(32).toString("hex");
  let publicUrl: URL;
  let cookie: string;
  let session: Session;
  const grant = () => `${cookie}=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${LIFETIME / 1000}`;
  const listener = Bun.serve<Bridge>({
    hostname,
    port: 0,
    websocket: previewWebsocket,
    async fetch(req, server) {
      const incoming = new URL(req.url);
      const host = req.headers.get("host");
      if (host !== publicUrl.host) return new Response("Forbidden", { status: 403 });
      if (incoming.pathname === `/__openbuild_preview/${secret}`) {
        session.seen = Date.now();
        // Only a path on the dev server, never another host.
        const next = new URL(incoming.searchParams.get("to") || "/", "http://preview.invalid");
        return new Response(null, { status: 302, headers: {
          location: publicUrl.origin + next.pathname + next.search + next.hash,
          "set-cookie": grant(),
          "referrer-policy": "no-referrer", "cache-control": "no-store",
        } });
      }
      if (!(req.headers.get("cookie") || "").split(";").some(c => c.trim() === `${cookie}=${secret}`)) return expired(req);
      const origin = req.headers.get("origin");
      if (origin && origin !== publicUrl.origin) return new Response("Forbidden", { status: 403 });
      session.seen = Date.now();
      const path = incoming.pathname + incoming.search;
      const result = remote ? await relay(req, remote, port, path, server, session) : await forwardPreview(req, localPreviewTarget(port, path), server, { session });
      // A page in use keeps its cookie as long as the preview lives.
      if (result && isPage(req)) result.headers.append("set-cookie", grant());
      return result;
    },
  });
  publicUrl = new URL(app.origin);
  publicUrl.port = String(listener.port);
  cookie = `openbuild_preview_${listener.port}`;
  session = { server: listener, seen: Date.now(), sockets: 0, secret, origin: publicUrl.origin, key };
  sessions.set(key, session);
  sweeper ??= setInterval(sweep, 10 * 60 * 1000);
  sweeper.unref?.();
  return entry(session);
}

export function stopPreviews(): void {
  for (const session of sessions.values()) session.server.stop(true);
  sessions.clear();
  preferred.clear();
  loopbacks.clear();
  if (sweeper) { clearInterval(sweeper); sweeper = undefined; }
}
