// Secret storage for API keys. Keys live in the OS keychain (macOS Keychain, Windows Credential
// Manager, libsecret on Linux) via Bun.secrets, one entry per scope (a plan or a search provider)
// holding that scope's ordered key list. They never leave the server: the browser only ever sees
// opaque entry ids.
//
// When no keychain is available (headless Linux, containers) it falls back to a 0600 file in the
// user's config directory, and `backend()` says so, so the UI can warn about it.
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PLANS, SEARCH_PROVIDERS } from "../shared/types";

const SERVICE = "openchat";

export type KeyScope = string;
export interface VaultEntry {
  id: string;
  secret: string;
}
/** One slot of an ordered key list: keep an existing entry, or store a new secret. */
export type KeyEdit = { id: string } | { secret: string };
export type VaultBackend = "keychain" | "file";

/** Scopes that hold secrets: every plan, and every search provider that takes a key (not an instance URL). */
export const isScope = (s: unknown): s is KeyScope =>
  typeof s === "string" && (s in PLANS || (s in SEARCH_PROVIDERS && SEARCH_PROVIDERS[s as keyof typeof SEARCH_PROVIDERS].credential === "key"));
export const scopes = (): KeyScope[] => [...Object.keys(PLANS), ...Object.values(SEARCH_PROVIDERS).filter((p) => p.credential === "key").map((p) => p.id)];

const filePath = () => process.env.OPENCHAT_SECRETS_FILE || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "openchat", "secrets.json");

let chosen: Promise<VaultBackend> | undefined;
function pickBackend(): Promise<VaultBackend> {
  return (chosen ??= (async () => {
    if (process.env.OPENCHAT_SECRETS === "file") return "file";
    try {
      // A read is enough to find out whether a keychain service is reachable.
      await Bun.secrets.get({ service: SERVICE, name: "probe" });
      return "keychain";
    } catch (err) {
      console.warn(`[vault] OS keychain unavailable (${(err as Error).message}); falling back to ${filePath()}`);
      return "file";
    }
  })());
}

export const backend = () => pickBackend();

async function readFileStore(): Promise<Record<string, VaultEntry[]>> {
  try {
    return JSON.parse(await readFile(filePath(), "utf8"));
  } catch {
    return {};
  }
}

async function writeFileStore(all: Record<string, VaultEntry[]>) {
  const path = filePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(all), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

async function load(scope: KeyScope): Promise<VaultEntry[]> {
  const raw = (await pickBackend()) === "keychain" ? await Bun.secrets.get({ service: SERVICE, name: scope }) : JSON.stringify((await readFileStore())[scope] ?? []);
  try {
    const list = JSON.parse(raw ?? "[]");
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === "string" && typeof e.secret === "string") : [];
  } catch {
    return [];
  }
}

async function store(scope: KeyScope, list: VaultEntry[]) {
  if ((await pickBackend()) === "keychain") {
    if (list.length) await Bun.secrets.set({ service: SERVICE, name: scope, value: JSON.stringify(list) });
    else await Bun.secrets.delete({ service: SERVICE, name: scope });
    return;
  }
  const all = await readFileStore();
  if (list.length) all[scope] = list;
  else delete all[scope];
  await writeFileStore(all);
}

// Read-modify-write cycles are serialised so concurrent edits can't clobber each other.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

/** Entry ids per scope, in priority order. Secrets are never included. */
export async function listIds(): Promise<Record<KeyScope, string[]>> {
  const out: Record<KeyScope, string[]> = {};
  for (const scope of scopes()) {
    const ids = (await load(scope)).map((e) => e.id);
    if (ids.length) out[scope] = ids;
  }
  return out;
}

/** The secrets for a scope in priority order (server-side use only). */
export const secrets = async (scope: KeyScope): Promise<string[]> => (await load(scope)).map((e) => e.secret);

/** One stored secret by entry id (server-side use only). */
export async function secretById(scope: KeyScope, id: string): Promise<string | undefined> {
  return (await load(scope)).find((e) => e.id === id)?.secret;
}

/**
 * Replace a scope's ordered key list. Existing entries are kept by id, new secrets get a fresh id
 * (an identical secret reuses its id), and anything not mentioned is dropped. Returns the new ids.
 */
export function setKeys(scope: KeyScope, edits: KeyEdit[]): Promise<string[]> {
  return serial(async () => {
    const current = await load(scope);
    const next: VaultEntry[] = [];
    for (const edit of edits) {
      let entry: VaultEntry | undefined;
      if ("id" in edit) {
        entry = current.find((e) => e.id === edit.id);
        if (!entry) throw new Error("Unknown key");
      } else {
        const secret = edit.secret.trim();
        entry = current.find((e) => e.secret === secret) ?? { id: crypto.randomUUID().replace(/-/g, "").slice(0, 12), secret };
      }
      if (!next.some((e) => e.id === entry.id)) next.push(entry);
    }
    await store(scope, next);
    return next.map((e) => e.id);
  });
}
