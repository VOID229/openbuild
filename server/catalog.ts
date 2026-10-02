// Model metadata (protocol, effort levels, modalities) from models.dev, joined with the
// per-key model list that Opencode returns from `GET {baseURL}/models`.
import { EFFORTS, PLANS, type DetectResult, type Effort, type ModelInfo, type PlanId, type Protocol, type ReasoningSupport } from "../shared/types";
import { USER_AGENT } from "./opencode";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CATALOG_TTL = 60 * 60 * 1000;

type ReasoningOption =
  | { type: "effort"; values: (string | null)[] }
  | { type: "toggle" }
  | { type: "budget_tokens"; min?: number; max?: number };

interface ModelsDevModel {
  id: string;
  name: string;
  family?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  reasoning_options?: ReasoningOption[];
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
  cost?: { output?: number };
  release_date?: string;
  provider?: { npm?: string };
}

type Catalog = Record<"opencode" | "opencode-go", Record<string, ModelsDevModel>>;

let cached: { at: number; catalog: Catalog } | undefined;
let inflight: Promise<Catalog> | undefined;

async function loadCatalog(): Promise<Catalog> {
  if (cached && Date.now() - cached.at < CATALOG_TTL) return cached.catalog;
  inflight ??= (async () => {
    try {
      const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`models.dev ${res.status}`);
      const all = (await res.json()) as Record<string, { models: Record<string, ModelsDevModel> }>;
      const catalog: Catalog = {
        opencode: all.opencode?.models ?? {},
        "opencode-go": all["opencode-go"]?.models ?? {},
      };
      cached = { at: Date.now(), catalog };
      return catalog;
    } catch (err) {
      console.warn("[catalog] models.dev unavailable, using heuristics:", (err as Error).message);
      // Serve stale data if we have it; otherwise fall back to id-based heuristics.
      return cached?.catalog ?? { opencode: {}, "opencode-go": {} };
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

function protocolFromNpm(npm: string | undefined): Protocol {
  switch (npm) {
    case "@ai-sdk/openai":
      return "responses";
    case "@ai-sdk/anthropic":
      return "messages";
    case "@ai-sdk/google":
      return "gemini";
    default:
      return "chat";
  }
}

/** Used only for models missing from models.dev. */
function protocolFromId(id: string): Protocol {
  if (id.startsWith("claude-")) return "messages";
  if (id.startsWith("gpt-") || id.startsWith("grok-")) return "responses";
  if (id.startsWith("gemini-")) return "gemini";
  return "chat";
}

function sortEfforts(efforts: Iterable<Effort>): Effort[] {
  const set = new Set(efforts);
  return EFFORTS.filter((e) => set.has(e));
}

function deriveReasoning(m: ModelsDevModel | undefined, protocol: Protocol): ReasoningSupport {
  const none: ReasoningSupport = { efforts: [], mode: "none", toggle: false };
  const opts = m?.reasoning_options;
  if (!m?.reasoning || !opts?.length) return none;

  // On/off switch: `thinking: {type: "disabled"}` on /messages; on /chat/completions
  // `reasoning_effort: "none"` + `thinking: {type: "disabled"}` (verified for Qwen, DeepSeek, LongCat).
  const toggle = (protocol === "messages" || protocol === "chat") && opts.some((o) => o.type === "toggle");
  const effort = opts.find((o): o is Extract<ReasoningOption, { type: "effort" }> => o.type === "effort");
  const budget = opts.some((o) => o.type === "budget_tokens");

  if (effort) {
    const levels = new Set<Effort>();
    for (const v of effort.values) {
      if (v === null || v === "none") levels.add("off");
      else if ((EFFORTS as readonly string[]).includes(v)) levels.add(v as Effort);
      // "minimal" has no slot in the UI's level list and is skipped.
    }
    if (toggle) levels.add("off");
    return { efforts: sortEfforts(levels), mode: "effort", toggle };
  }
  if (budget && (protocol === "messages" || protocol === "gemini")) {
    return { efforts: ["off", "low", "medium", "high", "max"], mode: "budget", toggle };
  }
  if (toggle) return { efforts: ["off", "medium"], mode: "none", toggle };
  return none;
}

/** Turn `glm-5.3-flash` into `Glm 5.3 Flash` for models models.dev doesn't know yet. */
function prettyName(id: string) {
  return id
    .split(/[-_]/)
    .map((p) => (/^[a-z]/.test(p) ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join(" ");
}

// Not chat models / not reachable through the standard endpoints.
const EXCLUDED = (id: string) => id.startsWith("jev-") || id === "test";

export async function describeModels(plan: PlanId, ids: string[]): Promise<ModelInfo[]> {
  const catalog = await loadCatalog();
  const provider = catalog[PLANS[plan].prefix];
  const other = catalog[PLANS[plan].prefix === "opencode" ? "opencode-go" : "opencode"];
  const models: ModelInfo[] = [];
  for (const id of ids) {
    if (EXCLUDED(id)) continue;
    const own = provider[id];
    const meta = own ?? other[id];
    const protocol = own ? protocolFromNpm(own.provider?.npm) : meta ? protocolFromNpm(meta.provider?.npm) : protocolFromId(id);
    models.push({
      id,
      name: meta?.name ?? prettyName(id),
      family: meta?.family,
      protocol,
      reasoning: deriveReasoning(meta, protocol),
      input: meta?.modalities?.input ?? ["text"],
      contextLimit: meta?.limit?.context,
      outputLimit: meta?.limit?.output,
      outputCost: meta?.cost?.output,
      releaseDate: meta?.release_date,
      // Unknown models are assumed to support tools; the upstream rejects them otherwise.
      tools: meta?.tool_call !== false,
    });
  }
  return models.sort(compareModels);
}

// Picker order: major providers first, newest first within a provider, free/preview models last.
const BRAND_ORDER = ["claude", "gpt", "gemini", "grok", "glm", "deepseek", "qwen", "kimi", "minimax", "mimo", "muse"];
const isExtra = (m: ModelInfo) => /free|preview|-exp\b|^test/.test(m.id);
const brandRank = (m: ModelInfo) => {
  const i = BRAND_ORDER.findIndex((b) => m.id.startsWith(b));
  return i < 0 ? BRAND_ORDER.length : i;
};

function compareModels(a: ModelInfo, b: ModelInfo) {
  return (
    Number(isExtra(a)) - Number(isExtra(b)) ||
    brandRank(a) - brandRank(b) ||
    (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Validate a key and list the models it can use.
 * - `GET /models` with a valid key returns only the models enabled for that key
 *   (an invalid key silently gets the public list, so it can't be used for validation).
 * - A deliberately invalid chat request costs nothing: bad keys get 401, good keys 400.
 */
export async function detectModels(plan: PlanId, key: string): Promise<DetectResult> {
  const { baseURL } = PLANS[plan];
  const headers = { authorization: `Bearer ${key}`, "user-agent": USER_AGENT };
  const checkedAt = Date.now();
  try {
    const [probe, list] = await Promise.all([
      fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "x-opencode-session": "openchat-key-check" },
        body: JSON.stringify({ model: "openchat-key-check", messages: [] }),
        signal: AbortSignal.timeout(20_000),
      }),
      fetch(`${baseURL}/models`, { headers, signal: AbortSignal.timeout(20_000) }),
    ]);
    await probe.body?.cancel();
    if (probe.status === 401 || probe.status === 403) {
      await list.body?.cancel();
      return { plan, status: "invalid", error: "Invalid API key", models: [], checkedAt };
    }
    if (!list.ok) {
      return { plan, status: "error", error: `Couldn't list models (HTTP ${list.status})`, models: [], checkedAt };
    }
    const body = (await list.json()) as { data?: { id: string }[] };
    const ids = (body.data ?? []).map((m) => m.id);
    return { plan, status: "valid", models: await describeModels(plan, ids), checkedAt };
  } catch (err) {
    return { plan, status: "error", error: `Couldn't reach Opencode: ${(err as Error).message}`, models: [], checkedAt };
  }
}
