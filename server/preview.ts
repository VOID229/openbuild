// One isolated origin per preview. Only this listener is exposed, never the dev server.
// Paired-device requests travel through its authenticated OpenBuild API, including WebSockets.
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";

// DOM typings omit Bun's server-side connection headers.
export const PreviewSocket = WebSocket as unknown as { new(url: string | URL, options: Bun.WebSocketOptions): WebSocket };

type Bridge = { upstream: WebSocket; pending: (string | Buffer)[] };
export const previewWebsocket = {
  open(ws: ServerWebSocket<Bridge>) {
    const upstream = ws.data.upstream;
    upstream.onmessage = (event) => ws.send(event.data);
    upstream.onclose = () => ws.close();
    upstream.onerror = () => ws.close(1011, "Preview disconnected");
    upstream.onopen = () => { for (const data of ws.data.pending.splice(0)) upstream.send(typeof data === "string" ? data : new Uint8Array(data)); };
  },
  message(ws: ServerWebSocket<Bridge>, data: string | Buffer) {
    if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(typeof data === "string" ? data : new Uint8Array(data));
    else if (ws.data.pending.length < 128) ws.data.pending.push(data);
    else ws.close(1013, "Preview busy");
  },
  close(ws: ServerWebSocket<Bridge>) { ws.data.upstream.close(); },
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
  for (const key of ["host", "cookie", "authorization", "proxy-authorization", "connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "content-length", "origin", "referer"]) out.delete(key);
  return out;
}

async function loopbackAddress(port: number): Promise<string> {
  // Probe both loopback families: Node-based dev servers often bind only ::1.
  return Promise.any(["127.0.0.1", "::1"].map(host => new Promise<string>((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000, () => socket.destroy(new Error("Preview connection timed out")));
    socket.once("connect", () => { socket.destroy(); resolve(host); });
    socket.once("error", reject);
  })));
}

export async function forwardPreview(req: Request, target: URL, server: Bun.Server<Bridge>, token?: string): Promise<Response | undefined> {
  if (!token) {
    try {
      const address = await loopbackAddress(Number(target.port || 80));
      target.hostname = address === "::1" ? "[::1]" : address;
    } catch { return new Response("Couldn't connect to the project's localhost server. Check that it is running.", { status: 502 }); }
  }
  const headers = cleanHeaders(req.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  // Dev servers validate Host and Origin. They see a loopback origin, not the LAN client.
  if (!token && req.headers.has("origin")) headers.set("origin", target.origin);
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const protocols = req.headers.get("sec-websocket-protocol")?.split(",").map(p => p.trim());
    headers.delete("sec-websocket-protocol");
    const upstream = new PreviewSocket(target, { headers: Object.fromEntries(headers), protocols });
    upstream.binaryType = "arraybuffer";
    if (server.upgrade(req, { data: { upstream, pending: [] } })) return;
    upstream.close();
    return new Response("WebSocket upgrade failed", { status: 400 });
  }
  try {
    server.timeout(req, 0);
    const response = await fetch(target, {
      method: req.method, headers, body: req.body, redirect: "manual", signal: req.signal,
      // Bun otherwise decompresses while retaining the upstream encoding header.
      decompress: false,
    });
    const out = new Headers(response.headers);
    for (const name of ["set-cookie", "connection", "transfer-encoding"]) out.delete(name);
    const location = out.get("location");
    if (location) {
      const next = new URL(location, target);
      if (next.origin === target.origin) out.set("location", next.pathname + next.search + next.hash);
    }
    out.set("referrer-policy", "no-referrer");
    return new Response(response.body, { status: response.status, headers: out });
  } catch {
    return new Response("Couldn't connect to the project's localhost server. Check that it is running.", { status: 502 });
  }
}

type Remote = { urls: string[]; token: string };
const sessions = new Map<string, { server: Bun.Server<Bridge>; expires: number; url: string; key: string }>();
const LIFETIME = 8 * 60 * 60 * 1000;

export function createPreview(url: URL, app: URL, remote?: Remote): string {
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname)) throw new Error("Preview requires an HTTP localhost URL");
  const port = url.port || "80";
  localPreviewTarget(port, "/");
  if (app.protocol !== "http:") throw new Error("Localhost previews currently require HTTP access to OpenBuild. HTTPS needs a separate TLS preview route.");
  for (const [key, session] of sessions) if (session.expires < Date.now()) { session.server.stop(true); sessions.delete(key); }
  const key = `${app.origin}:${url.href}:${remote?.token ?? "local"}`;
  for (const session of sessions.values()) if (session.key === key) return session.url;
  if (sessions.size >= 32) throw new Error("Too many open previews. Try again after older previews expire.");
  const secret = randomBytes(32).toString("hex");
  let publicUrl: URL;
  let cookie: string;
  const listener = Bun.serve<Bridge>({
    hostname: (process.env.HOST || "127.0.0.1").split(",").some(h => !["localhost", "127.0.0.1", "::1", "[::1]"].includes(h.trim())) ? "0.0.0.0" : "127.0.0.1",
    port: 0,
    websocket: previewWebsocket,
    async fetch(req, server) {
      const incoming = new URL(req.url);
      const host = req.headers.get("host");
      if (host !== publicUrl.host) return new Response("Forbidden", { status: 403 });
      if (incoming.pathname === `/__openbuild_preview/${secret}`) {
        return new Response(null, { status: 302, headers: {
          location: publicUrl.origin + url.pathname + url.search + url.hash,
          "set-cookie": `${cookie}=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${LIFETIME / 1000}`,
          "referrer-policy": "no-referrer", "cache-control": "no-store",
        } });
      }
      if (Date.now() > sessions.get(secret)!.expires || !(req.headers.get("cookie") || "").split(";").some(c => c.trim() === `${cookie}=${secret}`)) return new Response("Preview expired. Reload it from OpenBuild.", { status: 401 });
      const origin = req.headers.get("origin");
      if (origin && origin !== publicUrl.origin) return new Response("Forbidden", { status: 403 });
      const path = incoming.pathname + incoming.search;
      if (!remote) return forwardPreview(req, localPreviewTarget(port, path), server);
      for (const base of remote.urls) {
        const target = new URL(`/api/preview/relay/${port}`, base);
        target.searchParams.set("path", path);
        try {
          const result = await forwardPreview(req, target, server, remote.token);
          if (!result || result.status < 500) return result;
          await result.body?.cancel();
        } catch { /* Try the device's next address. */ }
      }
      return new Response("Couldn't reach the paired device's preview.", { status: 502 });
    },
  });
  publicUrl = new URL(app.origin);
  publicUrl.port = String(listener.port);
  cookie = `openbuild_preview_${listener.port}`;
  const entry = new URL(`/__openbuild_preview/${secret}`, publicUrl).href;
  sessions.set(secret, { server: listener, expires: Date.now() + LIFETIME, url: entry, key });
  setTimeout(() => { listener.stop(true); sessions.delete(secret); }, LIFETIME).unref();
  return entry;
}

export function stopPreviews(): void {
  for (const session of sessions.values()) session.server.stop(true);
  sessions.clear();
}
