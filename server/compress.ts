// JSON from the API, gzipped for browsers across a network. The thread list's summaries, a thread's
// history and OpenBots' snapshot are megabytes of text; over Tailscale or a LAN that's most of a
// reload. Streams (replies, shells, server-sent events) aren't JSON and pass through untouched, and
// a browser on this machine (it asked for localhost) gets it as is, where compressing only costs
// time. The address it asked for, not the connection's: behind a reverse proxy on this machine
// (tailscale serve, Caddy) every connection is local, the browsers aren't.
import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);
/** Below this, compressing saves less than it costs. */
const MIN_BYTES = 8 * 1024;

const local = (host: string) => /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])(?::\d+)?$/i.test(host);

export async function compressJson(req: Request, res: Response): Promise<Response> {
  if (req.method === "HEAD" || res.status !== 200 || !res.body || res.headers.has("content-encoding")) return res;
  if (!res.headers.get("content-type")?.startsWith("application/json")) return res;
  if (!/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "") || local(new URL(req.url).host)) return res;
  const body = new Uint8Array(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  if (body.byteLength < MIN_BYTES) return new Response(body, { status: res.status, statusText: res.statusText, headers });
  // zlib's async API runs on the thread pool: the event loop keeps answering meanwhile.
  const compressed = await gzipAsync(body, { level: 4 });
  headers.set("content-encoding", "gzip");
  headers.append("vary", "accept-encoding");
  headers.delete("content-length");
  return new Response(new Uint8Array(compressed), { status: res.status, statusText: res.statusText, headers });
}
