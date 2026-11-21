// The bots' model listing this browser last saw, so a reload names a bot's model from the first frame
// (useBotModels, ./models.ts). Only a copy to look at: the server's answer replaces it. It's one
// server's own (its Pi, its extensions and sign-ins decide the models), so a copy kept from another
// server at this address goes once /api/config names this one (claimBotModels, from workspace.ts).
// It also keeps the names of models an earlier listing had and the latest doesn't, so a bot left on one
// still reads by its name (rememberedModelName), not its raw id.
// No imports beyond types: nothing here asks the server anything.
import type { PiModels } from "../pi";

const KEY = "openbuild:bot-models:v1";
/** How many names of models no longer listed are kept, the newest first. */
const NAMES_MAX = 200;

interface Saved {
  /** The id of the server the listing came from; unset when /api/config hadn't answered yet. */
  owner?: string;
  listing: PiModels;
  /** Names of models an earlier listing had and this one doesn't, by id. */
  names?: Record<string, string>;
}

/** This server's id, once /api/config has said: a listing saved from now on is its own. */
let owner: string | undefined;
/** Every model name this browser knows, the kept listing's and the remembered ones; read from storage on first use. */
let names: Map<string, string> | undefined;
const forgotten = new Set<() => void>();

const storage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

const isListing = (v: unknown): v is PiModels =>
  !!v && Array.isArray((v as PiModels).models) && (v as PiModels).models.every((m) => typeof m?.id === "string" && typeof m.name === "string");

function read(): Saved | undefined {
  try {
    const saved = JSON.parse(storage()?.getItem(KEY) ?? "null") as Saved | null;
    if (saved && isListing(saved.listing) && (saved.owner === undefined || typeof saved.owner === "string")) {
      // Names that can't be read are dropped on their own: the listing still stands.
      const kept = saved.names && typeof saved.names === "object" ? Object.entries(saved.names).filter(([, n]) => typeof n === "string" && n) : [];
      return { ...saved, names: Object.fromEntries(kept) };
    }
  } catch { /* Unreadable: as if none was kept. */ }
}

/** What's kept, unless it's another server's. */
function own(): Saved | undefined {
  const saved = read();
  if (!saved || (owner && saved.owner && saved.owner !== owner)) return;
  return saved;
}

function known(): Map<string, string> {
  if (!names) {
    const saved = own();
    names = new Map([...Object.entries(saved?.names ?? {}), ...(saved?.listing.models ?? []).map((m) => [m.id, m.name] as const)]);
  }
  return names;
}

/** Read the names from storage again on next use (a page starting over: tests). */
export function rereadModelNames(): void {
  names = undefined;
}

/** The name a model had in a listing this browser saw (the latest, else an earlier one), if any. */
export function rememberedModelName(id: string): string | undefined {
  return id ? known().get(id) : undefined;
}

/** The last listing kept in this browser, unless it's another server's. */
export function savedBotModels(): PiModels | undefined {
  return own()?.listing;
}

/** Keep the server's latest listing for the next page load, and the names of the models it no longer has. Best effort: storage may be full or gone. */
export function saveBotModels(listing: PiModels): void {
  // An answer without models (some test servers answer {}) names nothing.
  const models = Array.isArray(listing.models) ? listing.models : [];
  const listed = new Set(models.map((m) => m.id));
  // The latest names last, so the oldest go first when there are too many.
  const gone = [...known()].filter(([id]) => !listed.has(id)).slice(-NAMES_MAX);
  names = new Map([...gone, ...models.map((m) => [m.id, m.name] as const)]);
  try {
    storage()?.setItem(KEY, JSON.stringify({ owner, listing, names: Object.fromEntries(gone) } satisfies Saved));
  } catch { /* Over quota or blocked: the next load asks the server, as before. */ }
}

/** Drop the kept listing (memory included, via onForgetBotModels): this address serves another server now. */
export function forgetBotModels(): void {
  try {
    storage()?.removeItem(KEY);
  } catch { /* Nothing to drop. */ }
  names = new Map();
  for (const fn of forgotten) fn();
}

/** Hears when the kept listing goes, so a page holding it in memory lets go too. */
export function onForgetBotModels(fn: () => void): () => void {
  forgotten.add(fn);
  return () => void forgotten.delete(fn);
}

/**
 * /api/config answered: this is server `id`. A listing kept from another server goes; one saved
 * before the id was known (the listing came first) becomes this server's.
 */
export function claimBotModels(id: string): void {
  owner = id;
  const saved = read();
  if (!saved) return;
  if (saved.owner && saved.owner !== id) return forgetBotModels();
  if (!saved.owner) saveBotModels(saved.listing);
}
