// Files attached to a message that can't travel inside it: a video, a song, an archive, a large log.
//
// The browser sends one in pieces (PUT /api/attachments/<id>?offset=…), so nothing here or in a proxy
// on the way holds more than a piece in memory, and a piece that failed is simply sent again. Each
// file is kept on the machine whose agent will read it, in a folder of its own under the data
// directory, and the prompt names that path. A paired device has the same routes, reached through
// /api/devices/<id>/…. The browser uploads when the message is sent, so it knows which machine that is.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync, ftruncateSync } from "node:fs";
import { extname, join } from "node:path";
import { ATTACHMENT_CHUNK, MAX_ATTACHMENT_BYTES, type StoredFile } from "../shared/attachments";
import { dataDir } from "./paths";

type Api = <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) => (req: R, ...rest: A) => Response | Promise<Response>;
export class AttachmentError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// Not from handlers.ts: the bots' service loads this file, and shouldn't load the chat proxy with it.
const bad = (error: string, status = 400) => Response.json({ error }, { status });

const root = () => join(dataDir(), "attachments");
export const isAttachmentId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{6,64}$/.test(id);

/** A name safe to use as one path segment, keeping what the user called the file. */
export function safeName(name: string): string {
  const base = name.normalize("NFC").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/^\.+/, "").trim().slice(0, 180);
  return base || "file";
}

const TYPES: Record<string, string> = {
  ".md": "text/markdown", ".txt": "text/plain", ".log": "text/plain", ".csv": "text/csv", ".json": "application/json", ".pdf": "application/pdf",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".heic": "image/heic", ".svg": "image/svg+xml",
  ".zip": "application/zip", ".gz": "application/gzip", ".tgz": "application/gzip", ".tar": "application/x-tar", ".7z": "application/x-7z-compressed", ".rar": "application/vnd.rar",
};

/** The browser's type for the file when it gave a plausible one, or one from the name. */
export const mimeOf = (name: string, given?: string | null) =>
  given && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(given) && given.length < 128 ? given.toLowerCase() : TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";

interface Meta {
  name: string;
  mime: string;
  total: number;
}

const metaPath = (id: string) => join(root(), `${id}.json`);
const filePath = (id: string, name: string) => join(root(), id, name);

function readMeta(id: string): Meta | undefined {
  try {
    const m = JSON.parse(readFileSync(metaPath(id), "utf8"));
    return typeof m?.name === "string" && typeof m.total === "number" ? m : undefined;
  } catch {
    return undefined;
  }
}

/** A stored file as it is now. `done` once every byte the sender promised is here. */
export function stored(id: string): (StoredFile & { done: boolean }) | undefined {
  if (!isAttachmentId(id)) return undefined;
  const meta = readMeta(id);
  if (!meta) return undefined;
  const path = filePath(id, meta.name);
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return undefined;
  }
  return { id, name: meta.name, mime: meta.mime, size, path, done: size === meta.total };
}

/**
 * Add a piece of a file at `offset`. A piece sent again (its answer was lost) lands where it did the
 * first time: whatever was kept from `offset` on is replaced, so a retry never doubles anything.
 */
export function writeChunk(id: string, at: { name: string; mime?: string | null; offset: number; total: number }, bytes: Uint8Array): StoredFile & { done: boolean } {
  if (!isAttachmentId(id)) throw new AttachmentError("Bad file id.");
  const { offset, total } = at;
  if (!Number.isSafeInteger(total) || total < 0) throw new AttachmentError("Bad file size.");
  if (total > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`Files can be up to ${MAX_ATTACHMENT_BYTES / 1024 ** 3} GB.`, 413);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + bytes.byteLength > total) throw new AttachmentError("That piece doesn't fit the file.");
  if (bytes.byteLength > ATTACHMENT_CHUNK * 2) throw new AttachmentError("That piece is too large.", 413);
  let meta = readMeta(id);
  if (!meta) {
    if (offset !== 0) throw new AttachmentError("That file's upload has to start over.", 409);
    const name = safeName(at.name);
    meta = { name, mime: mimeOf(name, at.mime), total };
    mkdirSync(join(root(), id), { recursive: true, mode: 0o700 });
    writeFileSync(filePath(id, name), "");
    writeFileSync(metaPath(id), JSON.stringify(meta), { mode: 0o600 });
  } else if (meta.total !== total) throw new AttachmentError("That id already holds another file.", 409);
  const path = filePath(id, meta.name);
  const have = existsSync(path) ? statSync(path).size : 0;
  if (offset > have) throw new AttachmentError("A piece before this one is missing.", 409);
  const fd = openSync(path, "r+");
  try {
    if (offset < have) ftruncateSync(fd, offset);
    let written = 0;
    while (written < bytes.byteLength) written += writeSync(fd, bytes, written, bytes.byteLength - written, offset + written);
  } finally {
    closeSync(fd);
  }
  const size = offset + bytes.byteLength;
  return { id, name: meta.name, mime: meta.mime, size, path, done: size === total };
}

export function remove(id: string) {
  if (!isAttachmentId(id)) return;
  rmSync(join(root(), id), { recursive: true, force: true });
  rmSync(metaPath(id), { force: true });
}

/** Types a browser may show in place. Everything else is only ever downloaded. */
const INLINE = /^(audio\/|video\/|image\/(png|jpeg|gif|webp|avif)$|application\/pdf$|text\/plain$)/;

/** The file itself, whole or the range asked for (a player seeking through a video). */
export function serve(req: Request, id: string): Response {
  const file = stored(id);
  if (!file?.done) return bad("No such file", 404);
  const inline = INLINE.test(file.mime);
  const headers: Record<string, string> = {
    "content-type": inline ? file.mime : "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    // Media, a PDF or plain text is shown by the browser's own viewer and can't script this origin.
    // Anything else is saved, and never run as a page even if something opens it in place.
    ...(inline ? {} : { "content-security-policy": "default-src 'none'; sandbox" }),
  };
  const blob = Bun.file(file.path);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range && (range[1] || range[2]) && file.size > 0) {
    // "500-" from there on, "-500" the last 500 bytes.
    const start = range[1] ? Number(range[1]) : Math.max(0, file.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
    if (start > end || start >= file.size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${file.size}` } });
    return new Response(blob.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${file.size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(blob, { headers: { ...headers, "content-length": String(file.size) } });
}

/** A PUT of one piece: where it goes is in the query, the bytes are the body. */
export async function receive(req: Request, id: string): Promise<Response> {
  return receiveBytes(req.url, id, new Uint8Array(await req.arrayBuffer()));
}

/** The same with the body already read: it's written before this returns, with nothing awaited. */
export function receiveBytes(url: string, id: string, bytes: Uint8Array): Response {
  const q = new URL(url).searchParams;
  try {
    return Response.json(writeChunk(id, { name: q.get("name") ?? "", mime: q.get("type"), offset: Number(q.get("offset") ?? 0), total: Number(q.get("total") ?? NaN) }, bytes));
  } catch (err) {
    if (err instanceof AttachmentError) return bad(err.message, err.status);
    throw err;
  }
}

export function attachmentRoutes(api: Api) {
  return {
    "/api/attachments/:id": {
      PUT: api((req: Bun.BunRequest<"/api/attachments/:id">) => receive(req, req.params.id)),
      GET: api((req: Bun.BunRequest<"/api/attachments/:id">) => serve(req, req.params.id)),
      DELETE: api((req: Bun.BunRequest<"/api/attachments/:id">) => {
        remove(req.params.id);
        return Response.json({ ok: true });
      }),
    },
  };
}
