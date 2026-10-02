import type { ModelInfo, PlanId } from "../../shared/types";
import type { Detection, ModelRef, NamedModel, PriorityEntry, Selection, Settings } from "./types";

import claude from "../assets/brands/claude-color.svg" with { type: "text" };
import gemini from "../assets/brands/gemini-color.svg" with { type: "text" };
import deepseek from "../assets/brands/deepseek-color.svg" with { type: "text" };
import qwen from "../assets/brands/qwen-color.svg" with { type: "text" };
import grok from "../assets/brands/grok.svg" with { type: "text" };
import openai from "../assets/brands/openai.svg" with { type: "text" };
import zhipu from "../assets/brands/zhipu-color.svg" with { type: "text" };
import kimi from "../assets/brands/kimi-color.svg" with { type: "text" };
import minimax from "../assets/brands/minimax-color.svg" with { type: "text" };
import meta from "../assets/brands/meta-color.svg" with { type: "text" };
import mimo from "../assets/brands/xiaomimimo.svg" with { type: "text" };
import hunyuan from "../assets/brands/hunyuan-color.svg" with { type: "text" };
import longcat from "../assets/brands/longcat-color.svg" with { type: "text" };
import nvidia from "../assets/brands/nvidia-color.svg" with { type: "text" };
import arcee from "../assets/brands/arcee-color.svg" with { type: "text" };
import mistral from "../assets/brands/mistral-color.svg" with { type: "text" };
import stepfun from "../assets/brands/stepfun-color.svg" with { type: "text" };
import opencode from "../assets/brands/opencode.svg" with { type: "text" };

// The icons are decorative; drop their <title> so they don't produce stray hover tooltips.
const clean = (svg: string) => svg.replace(/<title>[\s\S]*?<\/title>/, "");

const BRANDS: [RegExp, string][] = (<[RegExp, string][]>[
  [/^claude/, claude],
  [/^gemini|^gemma/, gemini],
  [/^deepseek/, deepseek],
  [/^qwen/, qwen],
  [/^grok/, grok],
  [/^gpt|^o\d|^codex/, openai],
  [/^glm/, zhipu],
  [/^kimi/, kimi],
  [/^minimax/, minimax],
  [/^muse/, meta],
  [/^mimo/, mimo],
  [/^hy\d/, hunyuan],
  [/^longcat/, longcat],
  [/^nemotron/, nvidia],
  [/^trinity/, arcee],
  [/^(mistral|devstral|codestral)/, mistral],
  [/^step/, stepfun],
]).map(([re, svg]) => [re, clean(svg)]);
const FALLBACK = clean(opencode);

export function brandSvg(modelId: string): string {
  const id = modelId.toLowerCase();
  return BRANDS.find(([re]) => re.test(id))?.[1] ?? FALLBACK;
}

export const isAuto = (s: Selection | undefined): s is { auto: true } => !!s && "auto" in s;

export function availablePlans(detection: Partial<Record<PlanId, Detection>>): PlanId[] {
  return (Object.keys(detection) as PlanId[]).filter((p) => detection[p]?.models.length && detection[p]?.status !== "invalid");
}

export function findModel(detection: Partial<Record<PlanId, Detection>>, ref: ModelRef | undefined): ModelInfo | undefined {
  if (!ref) return undefined;
  return detection[ref.plan]?.models.find((m) => m.id === ref.id);
}

const PLAN_PREFERENCE: PlanId[] = ["zen", "black", "go", "plus"];

// Hooks for the think harder/faster + auto router features. Models tagged in
// Settings → General → "models to prioritize" take precedence over these lists.
const QUALITY_PREFERENCE = ["claude-opus-5-5", "gpt-6-sol", "gpt-6.1-sol", "claude-fable-5-1", "glm-5.3", "kimi-k3", "qwen3.8-max", "deepseek-v4-pro", "grok-4.7", "gemini-3.1-pro"];
const FAST_PREFERENCE = ["qwen3.8-flash", "glm-5.3-flash", "deepseek-v4.1-flash", "gemini-3.8-flash", "claude-haiku-4-5", "gpt-6-luna", "deepseek-v4-flash", "mimo-v2.6-flash"];
const FAST_RE = /flash|lite|mini|nano|haiku|luna|tiny|turbo|lightning|fast|air\b/;

/** Normalise ids and display names ("Qwen3.8 flash", "qwen3.8-flash") for loose matching. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9.]/g, "");
const matches = (m: ModelInfo, entry: NamedModel) => norm(m.id) === norm(entry.id) || norm(m.name) === norm(entry.name);

export function isFastModel(model: Pick<ModelInfo, "id" | "name">, settings: Pick<Settings, "prioritize">): boolean {
  const tagged = settings.prioritize.find((p) => matches(model as ModelInfo, p));
  if (tagged) return tagged.tag === "Speed";
  return FAST_RE.test(model.id.toLowerCase());
}

interface Candidate {
  plan: PlanId;
  model: ModelInfo;
}

function candidates(detection: Partial<Record<PlanId, Detection>>, avoid: NamedModel[], preferPlan?: PlanId): Candidate[] {
  const plans = availablePlans(detection).sort((a, b) => {
    if (a === preferPlan) return -1;
    if (b === preferPlan) return 1;
    return PLAN_PREFERENCE.indexOf(a) - PLAN_PREFERENCE.indexOf(b);
  });
  return plans.flatMap((plan) =>
    (detection[plan]?.models ?? []).filter((m) => !avoid.some((a) => matches(m, a))).map((model) => ({ plan, model })),
  );
}

function pick(pool: Candidate[], tagged: PriorityEntry[], preference: string[], fallback: (c: Candidate) => boolean): ModelRef | undefined {
  for (const entry of tagged) {
    const hit = pool.find((c) => matches(c.model, entry));
    if (hit) return { plan: hit.plan, id: hit.model.id };
  }
  for (const id of preference) {
    const hit = pool.find((c) => c.model.id === id);
    if (hit) return { plan: hit.plan, id: hit.model.id };
  }
  const hit = pool.find(fallback);
  return hit && { plan: hit.plan, id: hit.model.id };
}

/** Faster model used by "think faster" and by the router for easy prompts. */
export function fastTarget(detection: Partial<Record<PlanId, Detection>>, settings: Settings, preferPlan?: PlanId) {
  const pool = candidates(detection, settings.avoid, preferPlan);
  const tagged = settings.prioritize.filter((p) => p.tag === "Speed");
  return pick(pool, tagged, FAST_PREFERENCE, (c) => isFastModel(c.model, settings));
}

/** Higher-quality model used by "think harder" and by the router for complex prompts. */
export function qualityTarget(detection: Partial<Record<PlanId, Detection>>, settings: Settings, preferPlan?: PlanId) {
  const pool = candidates(detection, settings.avoid, preferPlan);
  const tagged = settings.prioritize.filter((p) => p.tag === "complex");
  return pick(pool, tagged, QUALITY_PREFERENCE, (c) => !isFastModel(c.model, settings));
}

/** Default selection once keys are detected: Claude Opus 5.5 as drawn, else the best available. */
export function defaultModel(detection: Partial<Record<PlanId, Detection>>): ModelRef | undefined {
  const pool = candidates(detection, []);
  return pick(pool, [], QUALITY_PREFERENCE, () => true);
}

const COMPLEX_RE =
  /```|\b(code|function|class|bug|debug|error|stack ?trace|compile|refactor|algorithm|regex|sql|typescript|javascript|python|rust|golang|java|c\+\+|api|implement|prove|proof|derive|derivative|integral|equation|theorem|lemma|matrix|probability|statistic|calculus|physics|chemistry|biology|molecule|quantum|optimi[sz]e|complexity|architecture)\b|[=∑∫√π∂]|\d+\s*[\^*/]\s*\d+/i;

/** Experimental router: easy prompts → fast model, code/math/science → higher-quality model. */
export function routePrompt(text: string, hasFiles: boolean, detection: Partial<Record<PlanId, Detection>>, settings: Settings) {
  const complex = hasFiles || text.length > 700 || COMPLEX_RE.test(text);
  return (complex ? qualityTarget(detection, settings) : fastTarget(detection, settings)) ??
    (complex ? fastTarget(detection, settings) : qualityTarget(detection, settings));
}
