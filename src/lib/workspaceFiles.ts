// The file tree and editor's side of server/workspaceFiles.ts: a folder at a time, a file's text,
// and saving it back, on the device the thread's folder is on.
import type { FileRead, TreeEntry } from "../../shared/types";
import { apiUrl, deviceName } from "./devices";
import type { TerminalFolder } from "./terminal";

type Folder = Pick<TerminalFolder, "deviceId" | "cwd">;

/** A failed request, with the server's reason and its code ("changed": the file changed on disk). */
export class FileError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * A failure the panel can explain. A paired device still on an older OpenBuild has none of these
 * routes, and answers "Not found": say that, rather than pass it on.
 */
function failed(res: Response, body: { error?: string; code?: string } | null, folder: Folder): FileError {
  if (res.status === 404) {
    const name = folder.deviceId ? (deviceName(folder.deviceId) ?? "that device") : "this server";
    return new FileError(`The OpenBuild on ${name} is older and doesn't have the file viewer yet. ${folder.deviceId ? "Update it there (openbuild update)" : "Restart it"} to pick up the update.`, "stale");
  }
  return new FileError(body?.error ?? `Request failed (HTTP ${res.status})`, body?.code);
}

async function json<T>(res: Response, folder: Folder): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw failed(res, body, folder);
  return body as T;
}

const query = (folder: Folder, params: Record<string, string>) => {
  const q = new URLSearchParams(params);
  if (folder.cwd) q.set("cwd", folder.cwd);
  return q.toString();
};

export const listDir = (folder: Folder, dir: string) =>
  fetch(apiUrl(folder.deviceId, `/api/workspaces/tree?${query(folder, { dir })}`)).then((r) => json<{ entries: TreeEntry[] }>(r, folder)).then((r) => r.entries);

/** A file's text; with `since` (the mtime already read), `unchanged` when it hasn't changed since. */
export const readFile = (folder: Folder, path: string, since?: number) =>
  fetch(apiUrl(folder.deviceId, `/api/workspaces/file?${query(folder, { path, ...(since !== undefined ? { since: String(since) } : {}) })}`)).then((r) =>
    json<FileRead | { unchanged: true }>(r, folder),
  );

/** Save; with `mtime`, refused (code "changed") when the file changed on disk since it was read. */
export const saveFile = (folder: Folder, path: string, text: string, mtime?: number) =>
  fetch(apiUrl(folder.deviceId, "/api/workspaces/file"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: folder.cwd, path, text, mtime }),
  }).then((r) => json<{ mtime: number; size: number }>(r, folder));

/** An image's address, to show it as it is. */
export const rawUrl = (folder: Folder, path: string, version?: number) =>
  apiUrl(folder.deviceId, `/api/workspaces/raw?${query(folder, { path, ...(version ? { v: String(version) } : {}) })}`);

/** Shown as a picture, not as text (an SVG opens as its source, to edit). */
export const isRaw = (path: string) => /\.(png|jpe?g|gif|webp|avif|ico|bmp)$/i.test(path);
