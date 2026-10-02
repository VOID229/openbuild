// Types shared by the Bun server and the React client.

export type PlanId = "go" | "plus" | "black" | "zen";

export type Protocol = "chat" | "responses" | "messages" | "gemini";

/** Canonical effort levels, in UI order. "off" maps to provider "none"/disabled thinking. */
export const EFFORTS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Clamp a requested effort to the nearest supported level (ties go to the lower level). */
export function nearestEffort(levels: Effort[], wanted: Effort): Effort | undefined {
  if (!levels.length) return undefined;
  if (levels.includes(wanted)) return wanted;
  const at = EFFORTS.indexOf(wanted);
  const distance = (e: Effort) => Math.abs(EFFORTS.indexOf(e) - at);
  return [...levels].sort((a, b) => distance(a) - distance(b) || EFFORTS.indexOf(a) - EFFORTS.indexOf(b))[0];
}

export interface PlanConfig {
  id: PlanId;
  /** Label in Settings → API Keys */
  label: string;
  /** Short chip label in the model picker */
  chip: string;
  baseURL: string;
  /** Provider/model prefix, e.g. `opencode-go/glm-5.3` */
  prefix: "opencode" | "opencode-go";
}

// Routing table — implemented exactly as specified.
export const PLANS: Record<PlanId, PlanConfig> = {
  zen: { id: "zen", label: "Opencode Zen", chip: "Zen", baseURL: "https://opencode.ai/zen/v1", prefix: "opencode" },
  go: { id: "go", label: "Opencode Go", chip: "Go", baseURL: "https://opencode.ai/zen/go/v1", prefix: "opencode-go" },
  plus: { id: "plus", label: "Opencode Plus", chip: "Plus", baseURL: "https://opencode.ai/zen/go/v1", prefix: "opencode-go" },
  black: { id: "black", label: "Opencode Black", chip: "Black", baseURL: "https://opencode.ai/zen/v1", prefix: "opencode" },
};

/** Order of rows in Settings → API Keys (as drawn). */
export const KEY_ORDER: PlanId[] = ["go", "black", "plus", "zen"];
/** Order of chips in the model picker (as drawn). */
export const CHIP_ORDER: PlanId[] = ["go", "plus", "black", "zen"];

export interface ReasoningSupport {
  /** Effort levels the UI may offer for this model. Empty = no control. */
  efforts: Effort[];
  /** How the server should express the chosen effort. */
  mode: "effort" | "budget" | "none";
  /** Anthropic-style models that accept `thinking: {type: "disabled"}`. */
  toggle: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  family?: string;
  protocol: Protocol;
  reasoning: ReasoningSupport;
  /** Input modalities: text, image, pdf, ... */
  input: string[];
  contextLimit?: number;
  outputLimit?: number;
  /** USD per 1M output tokens, when known. */
  outputCost?: number;
  releaseDate?: string;
  /** Supports function/tool calling (needed for web search). */
  tools?: boolean;
}

export interface DetectResult {
  plan: PlanId;
  status: "valid" | "invalid" | "error";
  error?: string;
  models: ModelInfo[];
  checkedAt: number;
}

export type Attachment = {
  id: string;
  name: string;
  /** MIME type, e.g. image/png, application/pdf */
  mime: string;
  /** base64 data URL (images, PDFs) */
  dataUrl: string;
  /** Decoded contents for text files; inlined into the prompt by the client. */
  text?: string;
  size: number;
};

export interface WireMessage {
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
}

// ---------------------------------------------------------------------------------------
// Web search

export type SearchProviderId = "searxng" | "brave" | "kagi" | "exa" | "tavily" | "firecrawl" | "x";

export interface SearchProviderConfig {
  id: SearchProviderId;
  label: string;
  /** "url" = a self-hosted instance address rather than a secret key. */
  credential: "key" | "url";
  /** Where to get a key (or set up an instance). */
  site: string;
}

export const SEARCH_PROVIDERS: Record<SearchProviderId, SearchProviderConfig> = {
  exa: { id: "exa", label: "Exa", credential: "key", site: "https://dashboard.exa.ai/api-keys" },
  brave: { id: "brave", label: "Brave", credential: "key", site: "https://api-dashboard.search.brave.com/app/keys" },
  kagi: { id: "kagi", label: "Kagi", credential: "key", site: "https://kagi.com/settings?p=api" },
  firecrawl: { id: "firecrawl", label: "Firecrawl", credential: "key", site: "https://www.firecrawl.dev/app/api-keys" },
  tavily: { id: "tavily", label: "Tavily", credential: "key", site: "https://app.tavily.com/home" },
  x: { id: "x", label: "X", credential: "key", site: "https://developer.x.com/en/portal/dashboard" },
  searxng: { id: "searxng", label: "SearXNG", credential: "url", site: "https://docs.searxng.org/admin/installation.html" },
};

/** Order of rows in Settings → Web Search. */
export const SEARCH_ORDER: SearchProviderId[] = ["exa", "brave", "kagi", "firecrawl", "tavily", "searxng", "x"];

/** A configured search provider sent with a chat request: keys (or instance URLs) in priority order. */
export interface SearchCredentials {
  provider: SearchProviderId;
  keys: string[];
}

export interface SearchResultLink {
  title: string;
  url: string;
}

export interface ChatRequest {
  plan: PlanId;
  /** API keys for the plan in priority order; later keys are fallbacks. */
  keys: string[];
  model: string;
  effort: Effort;
  system?: string;
  sessionId: string;
  messages: WireMessage[];
  /** Web search providers the model may call as tools. */
  search?: SearchCredentials[];
}

/** NDJSON events streamed from /api/chat to the client. */
export type StreamEvent =
  | { t: "text"; v: string }
  | { t: "reasoning"; v: string }
  | { t: "error"; message: string; status?: number }
  /** Informational, e.g. a key failed and a fallback key was used. */
  | { t: "notice"; message: string }
  /** A web search tool call started (status "running") or finished. */
  | {
      t: "search";
      id: string;
      provider: SearchProviderId;
      query: string;
      status: "running" | "done" | "error";
      results?: SearchResultLink[];
      error?: string;
    }
  | { t: "done"; finish?: string; usage?: { input?: number; output?: number } };
