import { ATTACHMENT_CHUNK, MAX_ATTACHMENT_BYTES, formatBytes, type StoredFile } from "../../shared/attachments";
import type { Attachment } from "../../shared/types";
import { uid } from "./chat";
import { apiUrl } from "./devices";

export { formatBytes };

const TEXT_EXT =
  /\.(txt|md|markdown|mdx|csv|tsv|json|jsonl|ya?ml|toml|ini|env|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|proto|lua|r|dart|scala|vue|svelte|tex|log|conf|cfg|gitignore|dockerfile)$/i;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_IMAGE_EDGE = 2048;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

async function downscale(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 3.5 * 1024 * 1024 && file.type !== "image/gif") {
    bitmap.close();
    return readAsDataUrl(file);
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  return canvas.toDataURL(type, 0.9);
}

export class AttachmentError extends Error {}

/**
 * A file that travels inside the message: a picture the model looks at, a PDF, or text inlined into
 * the prompt. Undefined for everything else (video, audio, archives, large or binary files), which
 * is held by the browser until its message is sent, then uploaded to the machine the agent runs on
 * (src/lib/localFiles.ts).
 */
export async function readAttachment(file: File): Promise<Attachment | undefined> {
  const base = { id: uid(), name: file.name || "pasted-image.png", size: file.size };
  if (IMAGE_TYPES.includes(file.type)) {
    const dataUrl = await downscale(file);
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
