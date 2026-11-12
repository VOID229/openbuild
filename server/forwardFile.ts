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
/**
 * How long a held reply may go without a byte. The proxies' own deadlines end when the headers
 * arrive; a device that stalls mid-file would otherwise leave the request open with nothing sent.
 * Per read, not for the whole file, so a slow link that keeps sending still gets there.
 */
export const HELD_IDLE_MS = 15_000;

/**
 * The response to send for `res`, a forwarded reply, with `headers` (Content-Length isn't among
 * them). `gone` is the browser's request going away, which stops a held read too.
 */
export async function forwardBody(res: Response, headers: Headers, gone?: AbortSignal, idleMs = HELD_IDLE_MS): Promise<Response> {
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
  const bytes = await hold(res.body, Number(length), idleMs, gone);
  if (!bytes) return Response.json({ error: "The device stopped sending the file." }, { status: 504 });
  return new Response(bytes, init);
}

/** Exactly `size` bytes of `body`, or nothing if it stalls, ends early, runs over or is called off. */
async function hold(body: ReadableStream<Uint8Array>, size: number, idleMs: number, gone?: AbortSignal): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = body.getReader();
  const stop = () => void reader.cancel().catch(() => {});
  const fail = () => {
    stop();
    return undefined;
  };
  if (gone?.aborted) return fail();
  gone?.addEventListener("abort", stop, { once: true });
  const bytes = new Uint8Array(size);
  let at = 0;
  try {
    for (;;) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([reader.read(), new Promise<undefined>((resolve) => (idle = setTimeout(() => resolve(undefined), idleMs)))]).finally(() => clearTimeout(idle));
      if (!next || gone?.aborted) return fail();
      if (next.done) return at === size ? bytes : undefined;
      if (at + next.value.byteLength > size) return fail();
      bytes.set(next.value, at);
      at += next.value.byteLength;
    }
  } catch {
    return undefined;
  } finally {
    gone?.removeEventListener("abort", stop);
  }
}
