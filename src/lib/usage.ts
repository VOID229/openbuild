// A thread's context fill and spend, from its replies' usage (see server/pi/usage.ts) and the models'
// prices and billing (server/pi/pricing.ts). Local, plan and free models report no cost of their
// own; theirs is estimated at what the same model costs where it's sold by the token.
import { useEffect, useState } from "react";
import type { Billing, ModelInfo, Price, TokenCounts } from "../../shared/types";
import { piModelPrices } from "./pi";
import type { Message } from "./types";

type Tokens = Partial<TokenCounts>;

export const priceOf = (t: Tokens, p: Price) =>
  ((t.input ?? 0) * p.input + (t.cacheRead ?? 0) * p.cacheRead + (t.cacheWrite ?? 0) * p.cacheWrite + (t.output ?? 0) * p.output) / 1e6;

const tokensIn = (t: Tokens) => (t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) + (t.output ?? 0);

export interface Spend {
  /** Everything: what was billed, plus what plan, local and free use is worth at API prices. */
  total: number;
  /** Charged per token. */
  billed: number;
  /** Covered by a subscription. */
  plan: number;
  /** Local models and free tiers. */
  free: number;
  /** Some of it is estimated at another listing's price; those listings. */
  estimatedFrom: string[];
  /** Replies with tokens but no price at all (a model nobody sells by the token). */
  unpriced: number;
  /** Replies by how they were paid for. */
  replies: Record<Billing, number>;
  tokens: TokenCounts;
}

export function threadSpend(messages: Message[], models: ModelInfo[]): Spend | undefined {
  const byId = new Map(models.map((m) => [m.id, m]));
  const s: Spend = {
    total: 0, billed: 0, plan: 0, free: 0, estimatedFrom: [], unpriced: 0,
    replies: { api: 0, plan: 0, local: 0, free: 0 },
    tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  };
  let any = false;
  for (const m of messages) {
    const u = m.role === "assistant" ? m.usage : undefined;
    if (!u || !tokensIn(u)) continue;
    any = true;
    for (const k of ["input", "cacheRead", "cacheWrite", "output"] as const) s.tokens[k] += u[k] ?? 0;
    const model = m.model ? byId.get(m.model.id) : undefined;
    // Pi charged nothing for a model it can't tell us about: not billed, as far as anyone knows.
    const billing: Billing = model?.billing ?? (u.cost ? "api" : "free");
    s.replies[billing]++;
    let usd = u.cost ?? 0;
    if (!usd && model?.price) {
      usd = priceOf(u, model.price);
      if (model.priceFrom && !s.estimatedFrom.includes(model.priceFrom)) s.estimatedFrom.push(model.priceFrom);
    } else if (!usd) s.unpriced++;
    if (billing === "api") s.billed += usd;
    else if (billing === "plan") s.plan += usd;
    else s.free += usd;
    s.total += usd;
  }
  return any ? s : undefined;
}

/** "(free)" or "(plan)" before the amount, when none of it was billed. */
export const spendKind = (s: Spend) => (s.replies.api ? "" : s.replies.plan ? "plan" : "free");

/** Models the thread used, with any Pi no longer lists filled in from Pi's catalog. */
const extra = new Map<string, Promise<Record<string, Partial<ModelInfo>>>>();
export function useThreadModels(messages: Message[] | undefined, models: ModelInfo[] | undefined): ModelInfo[] {
  const [found, setFound] = useState<ModelInfo[]>([]);
  const known = new Set(models?.map((m) => m.id));
  const missing = [...new Set(messages?.flatMap((m) => (m.role === "assistant" && m.usage && m.model?.id.includes("/") && !known.has(m.model.id) ? [m.model.id] : [])))].sort();
  const key = models ? missing.join(",") : "";
  useEffect(() => {
    if (!key) return setFound([]);
    let live = true;
    const ids = key.split(",");
    Promise.all(ids.map((id) => {
      if (!extra.has(id)) extra.set(id, piModelPrices([id]).catch(() => (extra.delete(id), {})));
      return extra.get(id)!.then((r) => (r[id] ? [{ id, name: id, ...r[id] } as ModelInfo] : []));
    })).then((all) => live && setFound(all.flat()));
    return () => {
      live = false;
    };
  }, [key]);
  return found.length ? [...(models ?? []), ...found] : (models ?? []);
}

export interface ContextFill {
  /** Unknown right after compacting, until the next reply. */
  used?: number;
  window?: number;
  /** The last request by kind, the system prompt and tools taken out of the input it was part of. */
  rows?: TokenCounts & { system?: number };
}

/** A rough count for text, where no provider counted it. */
const estimate = (text: string) => Math.ceil(text.length / 4);

export function contextFill(messages: Message[], models: ModelInfo[]): ContextFill | undefined {
  const reply = messages.findLast((m) => m.role === "assistant" && m.usage && (m.usage.contextTokens || m.usage.contextWindow));
  if (!reply?.usage) return;
  const u = reply.usage;
  const window = u.contextWindow ?? models.find((m) => m.id === reply.model?.id)?.contextLimit;
  const fill: ContextFill = { used: u.contextTokens, window };
  if (!u.last || u.contextTokens === undefined) return fill;
  const rows: NonNullable<ContextFill["rows"]> = { ...u.last };
  // The thread's first request held the system prompt, the tools and the first message only.
  const first = messages.findIndex((m) => m.role === "assistant" && m.usage?.firstPrompt);
  const prompt = messages[first - 1];
  if (first > 0 && prompt?.role === "user" && !prompt.attachments?.length) {
    let system = Math.max(0, messages[first]!.usage!.firstPrompt! - estimate(prompt.content));
    system = Math.min(system, rows.cacheRead + rows.cacheWrite + rows.input);
    if (system) {
      rows.system = system;
      // Usually cached after the first request.
      for (const k of ["cacheRead", "cacheWrite", "input"] as const) {
        const take = Math.min(rows[k], system);
        rows[k] -= take;
        system -= take;
      }
    }
  }
  fill.rows = rows;
  return fill;
}

/** Cents show from a tenth of one: $0.021, $1.24, $312. */
export function formatUsd(v: number) {
  if (v === 0) return "$0.00";
  if (v < 0.001) return "<$0.001";
  if (v < 1) return `$${v.toFixed(3)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

export const formatTokens = (n: number) => Math.round(n).toLocaleString("en-US");

export const shortTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : String(n));
