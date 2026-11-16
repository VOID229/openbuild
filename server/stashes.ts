// Composer stashes, kept on this server's disk.
//
// A stash used to live in the browser's IndexedDB, which belongs to one origin: opening the app at a
// LAN address and then at a Tailscale name showed two different stashes, and the first one's seemed
// gone. Here they're the same for every address, browser and device, and outlast restarts and
// updates. A stash leaves only when it's used or removed: that leaves a tombstone, so a browser still
// holding an old copy (offline, or at an address not opened since) can't bring it back.
//
// Two stashes: OpenBuild's composers ("threads") and OpenBots' own ("bots").
//
// A file that doesn't travel inside the stash (a video, an archive: what the composer holds in the
// browser until its message is sent) is uploaded here, to stash-files/, so any browser can send it.
// It's kept while a stash names it, and STASH_FILE_GRACE_MS after: a used stash's files are in a
// composer, waiting for their message to go.
import { readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { parseFileRef, stashHeldFiles } from "../shared/bots";
import type { Attachment } from "../shared/types";
import { isAttachmentId, receive, remove, serve, stored } from "./attachments";
import { dataDir } from "./paths";
import * as storage from "./storage";

type Api = <R extends Request, A extends unknown[]>(handler: (req: R, ...rest: A) => Response | Promise<Response>) => (req: R, ...rest: A) => Response | Promise<Response>;

export const STASH_STORES = ["threads", "bots"] as const;
export type StashStoreName = (typeof STASH_STORES)[number];
const isStore = (s: unknown): s is StashStoreName => STASH_STORES.includes(s as StashStoreName);

/** As long as the browser keeps a file nobody sent (src/lib/localFiles.ts). */
export const STASH_FILE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY = 6 * 60 * 60 * 1000;

export const stashFilesDir = () => join(dataDir(), "stash-files");

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export interface StashItem {
  id: string;
  text: string;
  files: Attachment[];
  createdAt: number;
}

const isFile = (f: unknown): f is Attachment => {
  const a = f as Attachment;
  return !!a && typeof a === "object" && typeof a.id === "string" && typeof a.name === "string" && typeof a.mime === "string" && typeof a.dataUrl === "string" && typeof a.size === "number";
};

export const isStashItem = (v: unknown): v is StashItem => {
  const s = v as StashItem;
  return !!s && typeof s === "object" && isAttachmentId(s.id) && typeof s.text === "string" && Number.isFinite(s.createdAt) && Array.isArray(s.files) && s.files.every(isFile);
};

/** What a stash says and carries, ids aside: two stashes alike in this are the same stash. */
export function fingerprint(item: Pick<StashItem, "text" | "files">): string {
  const files = item.files.map((f) => {
    const ref = parseFileRef(f.dataUrl);
    return [f.name, f.mime, f.size, ref ? `${ref.name}:${ref.size}` : f.dataUrl, f.text ?? null, f.path ?? null, f.deviceId ?? null, !!f.mention, !!(f.local || ref?.local)];
  });
  return Bun.hash(JSON.stringify([item.text, files])).toString(36);
}

/** The ids of the files a stash keeps in stash-files/. */
const heldFileIds = (files: Attachment[]) => stashHeldFiles(files).map((f) => f.id);

/** Keep a stash. Legacy ones (from a browser's own storage) are skipped when the store has one just like it. */
export function keepStash(store: StashStoreName, item: StashItem, legacy = false) {
  const clean: StashItem = { id: item.id, text: item.text, files: item.files, createdAt: item.createdAt };
  return storage.putStash({ id: item.id, store, data: JSON.stringify(clean), fingerprint: fingerprint(clean), createdAt: item.createdAt }, legacy);
}

/** Remove a stash, and start its files' grace period. */
export function dropStash(store: StashStoreName, id: string) {
  const [row] = storage.stashesById(store, [id]);
  storage.deleteStash(id, store);
  if (!row) return;
  const now = new Date();
  for (const fileId of heldFileIds((JSON.parse(row.data) as StashItem).files)) {
    try {
      utimesSync(join(stashFilesDir(), `${fileId}.json`), now, now);
    } catch {}
  }
}

/** Remove stashed files no stash has named for STASH_FILE_GRACE_MS. */
export function sweepStashFiles(now = Date.now()) {
  let names: string[];
  try {
    names = readdirSync(stashFilesDir());
  } catch {
    return;
  }
  const wanted = new Set<string>();
  for (const row of storage.allStashes()) {
    if (!row.data) continue;
    try {
      for (const id of heldFileIds((JSON.parse(row.data) as StashItem).files)) wanted.add(id);
    } catch {}
  }
  for (const name of names) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : name;
    if (!isAttachmentId(id) || wanted.has(id)) continue;
    let at = 0;
    try {
      at = statSync(join(stashFilesDir(), `${id}.json`)).mtimeMs;
    } catch {}
    if (now - at > STASH_FILE_GRACE_MS) remove(id, stashFilesDir());
  }
}

const hot = globalThis as { openbuildStashSweep?: ReturnType<typeof setInterval> };
export function startStashFileSweep() {
  if (hot.openbuildStashSweep) clearInterval(hot.openbuildStashSweep);
  sweepStashFiles();
  hot.openbuildStashSweep = setInterval(() => sweepStashFiles(), SWEEP_EVERY);
  hot.openbuildStashSweep.unref();
}

const storeOf = (req: Bun.BunRequest<"/api/stashes/:store"> | Bun.BunRequest<"/api/stashes/:store/fetch"> | Bun.BunRequest<"/api/stashes/:store/items/:id">) =>
  isStore(req.params.store) ? req.params.store : undefined;

export function stashRoutes(api: Api) {
  return {
    // The store's stashes, newest first, by id: a browser fetches only the ones it doesn't have.
    "/api/stashes/:store": {
      GET: api((req: Bun.BunRequest<"/api/stashes/:store">) => {
        const store = storeOf(req);
        return store ? Response.json({ ids: storage.stashIds(store) }) : bad("No such stash", 404);
      }),
    },
    "/api/stashes/:store/fetch": {
      POST: api(async (req: Bun.BunRequest<"/api/stashes/:store/fetch">) => {
        const store = storeOf(req);
        if (!store) return bad("No such stash", 404);
        const body = (await req.json().catch(() => undefined)) as { ids?: unknown } | undefined;
        if (!Array.isArray(body?.ids) || !body.ids.every((id) => typeof id === "string")) return bad("Expected { ids: string[] }");
        const rows = storage.stashesById(store, body.ids as string[]);
        return new Response(`{"items":[${rows.map((r) => r.data).join(",")}]}`, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }),
    },
    // Keep a stash (sent again after a lost answer, it's kept once). `legacy`: brought over from a
    // browser's own storage, and skipped when one just like it is here already.
    "/api/stashes/:store/items/:id": {
      PUT: api(async (req: Bun.BunRequest<"/api/stashes/:store/items/:id">) => {
        const store = storeOf(req);
        if (!store) return bad("No such stash", 404);
        const body = (await req.json().catch(() => undefined)) as { item?: unknown; legacy?: unknown } | undefined;
        if (!isStashItem(body?.item) || body.item.id !== req.params.id) return bad("Expected { item } whose id matches the URL");
        return Response.json({ result: keepStash(store, body.item, body.legacy === true) });
      }),
      DELETE: api((req: Bun.BunRequest<"/api/stashes/:store/items/:id">) => {
        const store = storeOf(req);
        if (!store || !isAttachmentId(req.params.id)) return bad("No such stash", 404);
        dropStash(store, req.params.id);
        return Response.json({ ok: true });
      }),
    },
    // A stashed file that waited in the browser, sent here in pieces like an attachment.
    "/api/stash-files/:id": {
      PUT: api((req: Bun.BunRequest<"/api/stash-files/:id">) => receive(req, req.params.id, stashFilesDir())),
      GET: api((req: Bun.BunRequest<"/api/stash-files/:id">) => serve(req, req.params.id, stashFilesDir())),
      HEAD: api((req: Bun.BunRequest<"/api/stash-files/:id">) => {
        const file = stored(req.params.id, stashFilesDir());
        return new Response(null, { status: file?.done ? 200 : 404, headers: file?.done ? { "content-length": String(file.size), "content-type": file.mime } : {} });
      }),
    },
  };
}
