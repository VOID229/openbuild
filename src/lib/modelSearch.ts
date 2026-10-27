// Model search shared by every picker. Plan words in the query ("go", "zen", "opencode plus", …)
// filter by API key; the remaining words fuzzy-match the model: "go deepseek", "go zen qwen".
import { PLANS, type ModelInfo, type ModelScope, type PlanId } from "../../shared/types";
import { CUSTOM_PROVIDER, providerOf } from "./models";
import { providerOrder } from "./pluginOverrides";
import { fold, fuzzyScore } from "./search";
import type { Detection } from "./types";

const PLAN_WORDS = new Map<string, PlanId>((Object.keys(PLANS) as PlanId[]).map((p) => [fold(PLANS[p].chip), p]));

export interface ModelQuery {
  /** Plans named in the query; empty = no plan filter. */
  plans: PlanId[];
  /** The query without plan words (and without "opencode"). */
  text: string;
  /** The whole query, for literal matches such as "qwen plus" → "Qwen3.7 Plus". */
  raw: string;
}

export function parseModelQuery(query: string): ModelQuery {
  const plans: PlanId[] = [];
  const rest: string[] = [];
  for (const word of fold(query).split(/\s+/).filter(Boolean)) {
    const plan = PLAN_WORDS.get(word);
    if (plan) {
      if (!plans.includes(plan)) plans.push(plan);
    } else if (word !== "opencode") rest.push(word);
  }
  return { plans, text: rest.join(" "), raw: query.trim() };
}

/**
 * Score a model for a parsed query on a given plan. Models on a named plan match on the
 * remaining words; any model may also match the whole query literally (ranked lower).
 */
export function scoreModel(model: Pick<ModelInfo, "id" | "name">, plan: PlanId | PlanId[], q: ModelQuery): number | undefined {
  const label = `${model.name} ${model.id}`;
  const onPlan = q.plans.length === 0 || (Array.isArray(plan) ? plan : [plan]).some((p) => q.plans.includes(p));
  if (onPlan) {
    const s = q.text ? fuzzyScore(label, q.text) : 1;
    if (s !== undefined) return s + (q.plans.length ? 1 : 0);
  }
  return q.plans.length ? fuzzyScore(label, q.raw) : undefined;
}

export interface ModelGroup {
  plan: PlanId;
  models: ModelInfo[];
}

/** Search detected models, grouped by plan in `order`; `scope` limits plans when the query names none. */
export function searchModelGroups(detection: Partial<Record<PlanId, Detection>>, query: string, order: PlanId[], scope?: PlanId[]): ModelGroup[] {
  const q = parseModelQuery(query);
  const searching = q.raw.length > 0;
  return order
    .filter((plan) => detection[plan]?.models.length && (q.plans.length ? true : !scope || scope.includes(plan)))
    .map((plan) => {
      const models = detection[plan]!.models;
      if (!searching) return { plan, models };
      return {
        plan,
        models: models
          .map((m) => ({ m, s: scoreModel(m, plan, q) }))
          .filter((x) => x.s !== undefined)
          .sort((a, b) => b.s! - a.s!)
          .map((x) => x.m),
      };
    })
    .filter((g) => g.models.length);
}

export interface ProviderGroup {
  provider: string;
  models: ModelInfo[];
}

/** Whether a device's Pi settings scope its models at all (patterns that matched nothing don't). */
export const hasModelScope = (scope?: ModelScope) => !!scope?.models.length;

/** The model ids ("<provider>/<model id>") a device's Pi scope allows; undefined = no scope. */
export function scopeIds(scope?: ModelScope): Set<string> | undefined {
  const allowed = scope?.models ?? [];
  return allowed.length ? new Set(allowed.map((m) => `${m.provider}/${m.id}`)) : undefined;
}

/**
 * The models a picker offers: all of them, or only those in the device's Pi scope. The model already
 * selected is kept even when it's out of scope, so the picker can always show what the thread uses.
 */
export function scopedModels(models: ModelInfo[], scope?: ModelScope, selected?: string): ModelInfo[] {
  const ids = scopeIds(scope);
  if (!ids) return models;
  return models.filter((m) => ids.has(m.id) || m.id === selected);
}

/**
 * Pi models grouped by provider: in a plugin's `providerOrder` first (when one names the group), then
 * in the order Pi lists them, with non-built-in providers as one Custom group at the end.
 */
export function providerGroups(models: ModelInfo[]): ProviderGroup[] {
  const groups = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const p = providerOf(m);
    groups.set(p, [...(groups.get(p) ?? []), m]);
  }
  const custom = groups.get(CUSTOM_PROVIDER);
  // Custom goes last, after the providers Pi ships with.
  if (custom) {
    groups.delete(CUSTOM_PROVIDER);
    groups.set(CUSTOM_PROVIDER, custom);
  }
  return [...groups]
    .map(([provider, list], index) => ({ provider, models: list, index }))
    .sort((a, b) => (providerOrder(a.provider) ?? Infinity) - (providerOrder(b.provider) ?? Infinity) || a.index - b.index)
    .map(({ provider, models: list }) => ({ provider, models: list }));
}

/**
 * Search Pi models. Words naming a provider ("xai grok", "fireworks deepseek") narrow to it; the
 * rest fuzzy-match the model. Without a query, only `scope`'s provider is listed (if given).
 */
export function searchProviderGroups(models: ModelInfo[], query: string, scope?: string): ProviderGroup[] {
  const groups = providerGroups(models);
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return scope ? groups.filter((g) => g.provider === scope) : groups;
  const named = groups.filter((g) => words.includes(fold(g.provider)));
  const text = words.filter((w) => !named.some((g) => fold(g.provider) === w)).join(" ");
  return (named.length ? named : groups)
    .map((g) => ({
      provider: g.provider,
      models: g.models
        .map((m) => ({ m, s: text ? fuzzyScore(`${m.name} ${m.id}`, text) : 1 }))
        .filter((x) => x.s !== undefined)
        .sort((a, b) => b.s! - a.s!)
        .map((x) => x.m),
    }))
    .filter((g) => g.models.length);
}
