// The models bots can run on, as a component sees them. One listing for the whole page, shared by
// every picker: a picker that mounts gets it on its first render, so a bot's model never shows its
// raw id while it's asked for again. It starts from the copy this browser kept (./modelsCache.ts),
// then the server's answer replaces it, and so does each fresh listing, which comes whenever the
// custom extensions change (see onBotModels). One request at a time, however many pickers mount.
import { useEffect, useSyncExternalStore } from "react";
import { readableModelName } from "../../../shared/modelName";
import { botModels, onBotModels, type PiModels } from "../pi";
import { onForgetBotModels, rememberedModelName, rereadModelNames, saveBotModels, savedBotModels } from "./modelsCache";

export interface BotModelsState {
  /** What a bot can be put on: undefined while nothing is known, and when Pi can't start with these extensions (`failed`). */
  listing?: PiModels;
  /** The last listing known, kept through a failure: what names a model. */
  known?: PiModels;
  /** Pi can't start with the current extensions: the latest ask failed. */
  failed: boolean;
  /** The server has answered since this page loaded. Until then `known` may be the kept copy, so a model missing from it isn't known to be gone. */
  confirmed: boolean;
}

/** The server keeps its listing this long (server/bots/extensions.ts); a picker mounting later asks again. */
const FRESH_MS = 60_000;

let state: BotModelsState | undefined;
let answeredAt = 0;
let asking: Promise<PiModels> | undefined;
/** Counts asks, so only the latest one's answer is taken: a fresh listing beats an older one still on its way. */
let asked = 0;
const listeners = new Set<() => void>();
let wired = false;

function set(next: BotModelsState) {
  state = next;
  for (const fn of listeners) fn();
}

/** The listing as it stands, read at once: the kept copy until the server has answered. */
export function botModelsState(): BotModelsState {
  if (!state) {
    const known = savedBotModels();
    state = { listing: known, known, failed: false, confirmed: false };
  }
  if (!wired) {
    wired = true;
    // A fresh listing (the extensions changed) replaces whatever came before.
    onBotModels(take);
    // The kept copy was another server's: back to knowing nothing, and a picker on screen asks this one.
    onForgetBotModels(() => {
      asked++;
      asking = undefined;
      answeredAt = 0;
      set({ failed: false, confirmed: false });
      if (listeners.size) void refreshBotModels()?.catch(() => {});
    });
  }
  return state;
}

function take(listing: Promise<PiModels>): Promise<PiModels> {
  const mine = ++asked;
  void listing.then(
    (r) => {
      if (mine !== asked) return;
      answeredAt = Date.now();
      saveBotModels(r);
      set({ listing: r, known: r, failed: false, confirmed: true });
    },
    () => {
      if (mine !== asked) return;
      answeredAt = Date.now();
      set({ known: botModelsState().known, failed: true, confirmed: true });
    },
  );
  return listing;
}

/** Ask the server, unless an ask is on its way or it answered a moment ago. */
export function refreshBotModels(): Promise<PiModels> | undefined {
  botModelsState();
  if (asking || (answeredAt && Date.now() - answeredAt < FRESH_MS)) return asking;
  const listing = take(botModels());
  asking = listing;
  const done = () => {
    if (asking === listing) asking = undefined;
  };
  listing.then(done, done);
  return listing;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The bots' listing for a component, on its first render when the page (or this browser) has seen one. */
export function useBotModels(): BotModelsState {
  const current = useSyncExternalStore(subscribe, botModelsState, botModelsState);
  useEffect(() => void refreshBotModels(), []);
  return current;
}

/**
 * What names model `id` here, never its raw id: the listing's name, else the one it had in a listing
 * this browser saw before, else, once the server has answered or failed, a name read from the id
 * ("GLM 5.3 Flash"). Undefined while there's nothing to go on yet: the caller holds the name's place.
 */
export function modelLabel(id: string, { known, confirmed, failed }: BotModelsState): string | undefined {
  return known?.models?.find((m) => m.id === id)?.name ?? rememberedModelName(id) ?? (confirmed || failed ? readableModelName(id) : undefined);
}

/** Back to a page that has seen nothing, nothing kept in memory (tests). */
export function resetBotModels(): void {
  rereadModelNames();
  asked++;
  asking = undefined;
  answeredAt = 0;
  state = undefined;
}
