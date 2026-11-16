import { ATTACHMENT_CHUNK, MAX_ATTACHMENT_BYTES, MAX_IMAGE_DATA_URL, formatBytes, type StoredFile } from "../../shared/attachments";
import type { Attachment } from "../../shared/types";
import { uid } from "./id";
import { apiUrl } from "./devices";

export { formatBytes };

const TEXT_EXT =
  /\.(txt|md|markdown|mdx|csv|tsv|json|jsonl|ya?ml|toml|ini|env|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|proto|lua|r|dart|scala|vue|svelte|tex|log|conf|cfg|gitignore|dockerfile)$/i;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE_EDGE = 2048;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

/** JPEG qualities tried at each size, best first, before a picture is drawn smaller. */
const QUALITIES = [0.92, 0.85, 0.75, 0.6];

export class AttachmentError extends Error {}

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Whether a picture's data URL is short enough for a message to carry (server/bots/service.ts checks the same). */
export const fitsMessage = (dataUrl: string) => dataUrl.length <= MAX_IMAGE_DATA_URL;

/**
 * A picture as a data URL no longer than `limit`, so the server takes the message it goes in. One that
 * already fits, at 2048 px or less, is kept as it is (no re-encoding blur). Otherwise it's drawn at
 * 2048 px or less: a PNG stays a PNG if that fits (a screenshot's text compresses well losslessly),
 * else it becomes a JPEG at the highest quality that fits, and is drawn a quarter smaller until one does.
 * `still`: a GIF is always drawn (its first frame), for models that take no animation.
 */
export async function fitImage(file: Blob, { limit = MAX_IMAGE_DATA_URL, still = false } = {}): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new AttachmentError("Couldn't read that image.");
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const keep = longest <= MAX_IMAGE_EDGE && IMAGE_TYPES.includes(file.type) && !(still && file.type === "image/gif");
    // Base64 is 4 characters for every 3 bytes: a file that can't fit isn't read to find out.
    if (keep && Math.ceil(file.size / 3) * 4 < limit) {
      const original = await readAsDataUrl(file);
      if (original.length <= limit) return original;
    }
    const canvas = document.createElement("canvas");
    for (let edge = Math.min(MAX_IMAGE_EDGE, longest); ; edge = Math.floor(edge * 0.75)) {
      const k = edge / longest;
      // Sizing the canvas clears it and resets how it draws.
      canvas.width = Math.max(1, Math.round(bitmap.width * k));
      canvas.height = Math.max(1, Math.round(bitmap.height * k));
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (file.type === "image/png") {
        const png = canvas.toDataURL("image/png");
        if (png.length <= limit) return png;
      }
      // A JPEG has no transparency: what was see-through becomes white, not black.
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (const quality of QUALITIES) {
        const jpeg = canvas.toDataURL("image/jpeg", quality);
        if (jpeg.length <= limit) return jpeg;
      }
      if (edge <= 16) throw new AttachmentError("That image can't be made small enough to send.");
    }
  } finally {
    bitmap.close();
  }
}

/**
 * A picture already held as a data URL (from a stash, a saved draft, another device) fitted the same
 * way, when it's longer than `limit`. One that fits comes back as it is.
 */
export async function fitDataUrl(dataUrl: string, limit = MAX_IMAGE_DATA_URL): Promise<string> {
  if (dataUrl.length <= limit) return dataUrl;
  const head = /^data:(image\/[\w.+-]+);base64,/.exec(dataUrl);
  if (!head) throw new AttachmentError("That image is too large to send.");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const raw = atob(dataUrl.slice(head[0].length));
    bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  } catch {
    throw new AttachmentError("Couldn't read that image.");
  }
  return fitImage(new Blob([bytes], { type: head[1] }), { limit });
}

/**
 * A file that travels inside the message: a picture the model looks at, a PDF, or text inlined into
 * the prompt. Undefined for everything else (video, audio, archives, large or binary files), which
 * is held by the browser until its message is sent, then uploaded to the machine the agent runs on
 * (src/lib/localFiles.ts).
 */
export async function readAttachment(file: File): Promise<Attachment | undefined> {
  const base = { id: uid(), name: file.name || "pasted-image.png", size: file.size };
  if (IMAGE_TYPES.includes(file.type)) {
    const dataUrl = await fitImage(file, { still: true });
    return { ...base, mime: dataUrl.slice(5, dataUrl.indexOf(";")), dataUrl };
  }
  if (file.type === "application/pdf" && file.size <= MAX_PDF_BYTES) return { ...base, mime: file.type, dataUrl: await readAsDataUrl(file) };
  if ((file.type.startsWith("text/") || TEXT_EXT.test(file.name) || file.type === "application/json") && file.size <= MAX_TEXT_BYTES) {
    const text = await file.text();
    if (!text.includes("\u0000")) return { ...base, mime: file.type || "text/plain", dataUrl: "", text };
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send a file to a machine's disk in pieces, to `url` (…/api/attachments/<id>, or a bot workspace's
 * own route). A piece that fails is sent again, so a dropped connection costs one piece, not the file.
 */
export async function uploadFile(file: File, url: string, onProgress?: (sent: number) => void, signal?: AbortSignal): Promise<StoredFile> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`${file.name} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
  let offset = 0;
  let last: StoredFile | undefined;
  do {
    const piece = file.slice(offset, offset + ATTACHMENT_CHUNK);
    const q = new URLSearchParams({ name: file.name || "file", type: file.type, offset: String(offset), total: String(file.size) });
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let res: Response | undefined;
      try {
        res = await fetch(`${url}?${q}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: piece, signal });
      } catch (err) {
        if (signal?.aborted) throw err;
      }
      if (res?.ok) {
        last = (await res.json()) as StoredFile;
        break;
      }
      // The machine said no (too large, not allowed): asking again won't change it.
      const refused = res && res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      if (refused || attempt >= 3) {
        const why = res && ((await res.json().catch(() => undefined)) as { error?: string } | undefined)?.error;
        throw new AttachmentError(why ? `${file.name}: ${why}` : `Couldn't upload ${file.name}.`);
      }
      await sleep(600 * 2 ** attempt);
    }
    offset += piece.size;
    onProgress?.(offset);
  } while (offset < file.size);
  return last!;
}

/** Where a stored file is fetched from, to save it or play it. */
export const attachmentUrl = (a: Pick<Attachment, "id" | "deviceId">) => apiUrl(a.deviceId, `/api/attachments/${encodeURIComponent(a.id)}`);
