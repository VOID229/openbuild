// What a Pi model costs, and how it's paid for. Pi prices most models itself (its catalog, models.json,
// extensions). Local models, ones bundled in a subscription bridge (pi-claude) and free tiers come with
// a price of 0, so their spend is estimated at what the same model costs elsewhere in Pi's catalog.
import type { Billing, ModelInfo, Price } from "../../shared/types";
import { pricesFromPi } from "./auth";

interface Listing {
  provider: string;
  id: string;
  context?: number;
  cost: Price;
}

export interface PriceBook {
  listings: Listing[];
  /** Providers signed in with a subscription's OAuth (ChatGPT for Codex, SuperGrok for xAI, …). */
  subscriptions: Set<string>;
  /** Normalized model id → listings, for estimates. */
  byKey: Map<string, Listing[]>;
}

let cache: { at: number; value: Promise<PriceBook> } | undefined;

/** Pi's catalog changes with Pi updates and sign-ins; both drop this cache (forgetPrices). */
export function priceBook(): Promise<PriceBook> {
  if (cache && Date.now() - cache.at < 30 * 60_000) return cache.value;
  const value = pricesFromPi().then(({ models, providers }) => {
    const byKey = new Map<string, Listing[]>();
    for (const l of models) {
      const k = modelKey(l.id);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k)!.push(l);
    }
    return { listings: models, subscriptions: new Set(providers.filter((p) => p.subscription).map((p) => p.id)), byKey };
  });
  cache = { at: Date.now(), value };
  value.catch(() => cache?.value === value && (cache = undefined));
  return value;
}

export const forgetPrices = () => (cache = undefined);

// ------------------------------------------------------------------ billing

/** Loopback, private and Tailscale addresses, bare host names (a LAN machine) and local domains. */
const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0$|::1$|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|[^.:]+$)|\.(local|lan|home|internal|localdomain|ts\.net)$/i;
const LOCAL_PROVIDER = /ollama|lm-?studio|llama|vllm|sglang|localai|mlx|jan\b|local/i;

export function isLocal(m: { provider: string; baseUrl?: string }) {
  if (LOCAL_PROVIDER.test(m.provider)) return true;
  try {
    return !!m.baseUrl && LOCAL_HOST.test(new URL(m.baseUrl).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/** Plans: subscription sign-ins, the Codex and Claude Code bridges, and coding/token plans. */
const PLAN_API = new Set(["openai-codex-responses", "claude-bridge"]);
const PLAN_PROVIDER = /^opencode-go$|token-plan|coding|copilot|gemini-cli|antigravity/i;

export function billingOf(m: any, book?: PriceBook): Billing {
  if (isLocal(m)) return "local";
  if (PLAN_API.has(m.api) || PLAN_PROVIDER.test(m.provider) || /token-plan|\/coding\//.test(m.baseUrl ?? "") || book?.subscriptions.has(m.provider)) return "plan";
  return priced(m.cost) ? "api" : "free";
}

const priced = (c: any): c is Price => !!c && (c.input > 0 || c.output > 0);

// ------------------------------------------------------------------ reference prices

/**
 * A model id as most listings spell it: no vendor prefix, tag, date, quantization or file format.
 * `Qwen/Qwen3-Coder-30B-A3B-Instruct-GGUF`, `qwen3-coder:30b-a3b-q4_K_M` → `qwen3-coder-30b-a3b`.
 */
export function modelKey(id: string) {
  return id
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/:free$/, "")
    .replace(/[:_ ]/g, "-")
    .replace(/-(gguf|mlx|awq|gptq|exl2|fp8|fp16|bf16|[mn][xv]fp\d|int4|int8|\d+bit|q\d(-k)?(-[a-z0-9])?|q\d-\d|iq\d(-[a-z]+)?|instruct|it|latest|preview|v\d+-\d+|\d{8}|\d{4}-\d{2}-\d{2})(?=-|$)/g, "")
    .replace(/-+$/, "");
}

/** The vendor's own listing first, then big gateways; re-sellers and regional copies last. */
const PREFERRED = ["anthropic", "openai", "google", "xai", "deepseek", "mistral", "moonshotai", "zai", "minimax", "xiaomi", "opencode", "vercel-ai-gateway", "openrouter", "together", "fireworks", "groq", "huggingface", "baseten", "cerebras"];
const rank = (provider: string) => {
  const i = PREFERRED.indexOf(provider);
  return i < 0 ? PREFERRED.length : i;
};

/** What the same model costs where it's sold by the token. */
export function referencePrice(id: string, book: PriceBook, exclude?: string): Listing | undefined {
  const key = modelKey(id);
  if (!key) return;
  const pick = (ls: Listing[]) => ls.filter((l) => l.provider !== exclude).sort((a, b) => rank(a.provider) - rank(b.provider))[0];
  const exact = book.byKey.get(key);
  if (exact) {
    const hit = pick(exact);
    if (hit) return hit;
  }
  // A size or variant suffix on one side only (`qwen3-coder-30b` / `qwen3-coder-30b-a3b`): the closest.
  let best: { l: Listing; d: number } | undefined;
  for (const [k, ls] of book.byKey) {
    if (!(k.startsWith(key + "-") || key.startsWith(k + "-"))) continue;
    const l = pick(ls);
    const d = Math.abs(k.length - key.length);
    if (l && (!best || d < best.d || (d === best.d && rank(l.provider) < rank(best.l.provider)))) best = { l, d };
  }
  return best?.l;
}

/** Quantized weights (`q4_K_M`, `iq1_m`, `-GGUF`, `-MLX`, `4bit`) are run locally. */
const QUANTIZED = /(^|[-_:.])(i?q\d([_-][a-z0-9]+)*|gguf|mlx|awq|gptq|exl2|\d+bit)($|[-_:.])/i;

/**
 * Models a thread used that Pi no longer lists (a provider since removed, an old local server):
 * their listing if Pi's catalog still has it, else what the same model costs elsewhere.
 */
export function lookup(ref: string, book: PriceBook): Pick<ModelInfo, "billing" | "price" | "priceFrom" | "contextLimit"> {
  const slash = ref.indexOf("/");
  const provider = ref.slice(0, slash);
  const id = ref.slice(slash + 1);
  const own = book.listings.find((l) => l.provider === provider && l.id === id);
  if (own) return { billing: billingOf({ provider, cost: own.cost }, book), price: own.cost, contextLimit: own.context };
  const local = LOCAL_PROVIDER.test(provider) || QUANTIZED.test(id);
  const other = referencePrice(id, book, provider);
  return { billing: local ? "local" : undefined, ...(other ? { price: other.cost, priceFrom: `${other.provider}/${other.id}` } : {}) };
}

/** Billing and price for a Pi model (from `get_available_models`). */
export function pricing(m: any, book?: PriceBook): Pick<ModelInfo, "billing" | "price" | "priceFrom"> {
  const billing = billingOf(m, book);
  if (priced(m.cost)) {
    const c = m.cost;
    return { billing, price: { input: c.input || 0, output: c.output || 0, cacheRead: c.cacheRead || 0, cacheWrite: c.cacheWrite || 0 } };
  }
  const ref = book && referencePrice(m.id, book, m.provider);
  return ref ? { billing, price: ref.cost, priceFrom: `${ref.provider}/${ref.id}` } : { billing };
}
