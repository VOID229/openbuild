// Pi's OpenRouter catalog names models "Vendor: Model" ("DeepSeek: DeepSeek V4.1 Flash 1017",
// "Black Forest Labs: FLUX 3 Image"). The picker already prints the provider (OpenRouter) and its
// logo on the row, so the vendor prefix just repeats information and eats the label. This rewrites
// the detected model list to drop it; everything that reads `model.name` follows.
//
// Only display names change: ids (used for selection, requests and search) are untouched, and the
// original names are restored when the plugin is disabled or reloaded.
import { getState, subscribe, useStore } from "openbuild";

/** Pi provider ids whose model names carry a "Vendor: Model" prefix. Add more if you want. */
const PROVIDERS = new Set(["openrouter"]);

// A short, spaceless-prefix-free vendor label up to a colon, then the actual name.
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9 .&+_()'’-]{0,47}:\s+(\S.*)$/u;

const bareName = (name: string): string => name.match(PREFIX)?.[1] ?? name;

type ModelLike = { id: string; name: string; provider?: string };
type DetectionLike = { pi?: { models?: ModelLike[] } } | undefined;

/** The detected models with OpenRouter prefixes removed, or undefined when nothing changed. */
function strip(models: ModelLike[], originals: Map<string, string>): ModelLike[] | undefined {
  let changed = false;
  const next = models.map((model) => {
    if (!model.provider || !PROVIDERS.has(model.provider)) return model;
    const name = bareName(model.name);
    if (name === model.name) return model;
    if (!originals.has(model.id)) originals.set(model.id, model.name);
    changed = true;
    return { ...model, name };
  });
  return changed ? next : undefined;
}

const originals = new Map<string, string>();
let queued = false;

function patch() {
  // A store listener must not re-enter the store; run after the current notification settles.
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    const state = getState();
    const detection = state.detection as DetectionLike;
    const models = detection?.pi?.models;
    if (!models?.length) return;
    const next = strip(models, originals);
    if (!next) return;
    useStore.setState({
      detection: { ...state.detection, pi: { ...detection!.pi, models: next } },
    });
  });
}

const unsubscribe = subscribe(patch);
patch();

export default {
  dispose() {
    unsubscribe();
    const state = getState();
    const detection = state.detection as DetectionLike;
    const models = detection?.pi?.models;
    if (!models?.length) return;
    let changed = false;
    const next = models.map((model) => {
      const original = originals.get(model.id);
      if (!original || model.name === original) return model;
      originals.delete(model.id);
      changed = true;
      return { ...model, name: original };
    });
    if (changed) {
      useStore.setState({
        detection: { ...state.detection, pi: { ...detection!.pi, models: next } },
      });
    }
  },
};
