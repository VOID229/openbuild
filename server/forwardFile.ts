// A file's reply passed on by a proxy (a paired device's, or OpenBots' workspace on another device).
//
// Bun.serve sends a Content-Length set on a streamed body only when the whole stream has already
// arrived by the time the response goes out; otherwise it answers chunked and drops the header.
// For anything larger than a few socket reads that's always, and on Bun 1.3.8 it's a race even for
// ten bytes. So a reply small enough to hold, no more than an upload piece (which a proxy already
// holds in full on the way up), is read whole and sent as bytes, and its length always goes along.
// A larger one streams; on a 206 its Content-Range still tells a player the file's size.
import { ATTACHMENT_CHUNK } from "../shared/attachments";

export const HELD_FILE_BYTES = ATTACHMENT_CHUNK;

/** The response to send for `res`, a forwarded reply, with `headers` (Content-Length isn't among them). */
export async function forwardBody(res: Response, headers: Headers): Promise<Response> {
  const init = { status: res.status, statusText: res.statusText, headers };
  // A file (never compressed on the way): its length lets a player seek and a download show progress.
  const length = res.headers.get("accept-ranges") ? res.headers.get("content-length") : null;
  if (length === null || !/^\d+$/.test(length)) return new Response(res.body, init);
  // A HEAD's answer has no body to measure: its header is all there is.
  if (!res.body) {
    headers.set("content-length", length);
    return new Response(null, init);
  }
  if (Number(length) > HELD_FILE_BYTES) return new Response(res.body, init);
  return new Response(await res.arrayBuffer(), init);
}
