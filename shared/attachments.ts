/** Files kept on a machine's disk for a message (server/attachments.ts), as the browser and the server both see them. */

/** How much of a file goes in one request. Small enough for a proxy to hold and for a slow link to finish. */
export const ATTACHMENT_CHUNK = 4 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 4 * 1024 ** 3;

/** A file on a machine's disk. */
export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  /** Bytes received so far (all of them once it's attached to a message). */
  size: number;
  /** Where it is on that machine: what an agent there opens. */
  path: string;
}

export type FileKind = "image" | "audio" | "video" | "archive" | "text" | "file";

/** What a file is, for its icon and for whether it plays in place. */
export function fileKind(mime: string, name = ""): FileKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (/\.(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/i.test(name) || /(zip|x-tar|gzip|x-7z|rar|x-bzip|x-xz|zstd)/.test(mime)) return "archive";
  if (mime.startsWith("text/") || /\.(md|markdown|txt|log|csv|json|ya?ml|toml)$/i.test(name)) return "text";
  return "file";
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** How a prompt tells an agent about files waiting on its machine. */
export const attachedFileNote = (f: { name: string; mime: string; size: number }, path: string) =>
  `[Attached file "${f.name}" (${f.mime}, ${formatBytes(f.size)}) is saved at ${path}. Open it with your tools when you need it.]`;

/** A picture carried in the message itself, which can be shown and handed to a model. One kept on disk is a file like any other. */
export const isPicture = (a: { mime: string; dataUrl: string }) => a.mime.startsWith("image/") && a.dataUrl.startsWith("data:");
