// Types shared by the Bun server and the React client.

/** "pi": a model configured in the installed Pi (its provider/model id). The rest are Opencode plans. */
export type PlanId = "go" | "plus" | "black" | "zen" | "pi";

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
  prefix: string;
}

// Routing table — implemented exactly as specified.
export const PLANS: Record<PlanId, PlanConfig> = {
  zen: { id: "zen", label: "Opencode Zen", chip: "Zen", baseURL: "https://opencode.ai/zen/v1", prefix: "opencode" },
  go: { id: "go", label: "Opencode Go", chip: "Go", baseURL: "https://opencode.ai/zen/go/v1", prefix: "opencode-go" },
  plus: { id: "plus", label: "Opencode Plus", chip: "Plus", baseURL: "https://opencode.ai/zen/go/v1", prefix: "opencode-go" },
  black: { id: "black", label: "Opencode Black", chip: "Black", baseURL: "https://opencode.ai/zen/v1", prefix: "opencode" },
  pi: { id: "pi", label: "Pi", chip: "Pi", baseURL: "", prefix: "pi" },
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
  /** Pi models: the provider id and display name (`id` is "<provider>/<model id>"). */
  provider?: string;
  providerName?: string;
  /** Pi models from a provider Pi doesn't ship with (models.json, extensions). */
  custom?: boolean;
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

export type SearchProviderId = "searxng" | "brave" | "kagi" | "exa" | "tavily" | "firecrawl" | "x" | "youtube";

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
  youtube: { id: "youtube", label: "YouTube", credential: "key", site: "https://console.cloud.google.com/apis/library/youtube.googleapis.com" },
  searxng: { id: "searxng", label: "SearXNG", credential: "url", site: "https://docs.searxng.org/admin/installation.html" },
};

/** Whether a search provider key (or SearXNG address) works, from POST /api/verify-search. */
export interface SearchCheckResult {
  provider: SearchProviderId;
  status: "valid" | "invalid" | "error";
  error?: string;
}

/** Order of rows in Settings → Web Search. */
/** The key scope for a GitHub token: it isn't a search provider, but it's stored like one. */
export const GITHUB_SCOPE = "github";

/** Which tool ran: a search provider, a web page read ("fetch"), or a GitHub read ("github"). */
export type ToolId = SearchProviderId | "fetch" | "github";

export const SEARCH_ORDER: SearchProviderId[] = ["exa", "brave", "kagi", "firecrawl", "tavily", "searxng", "x", "youtube"];

/**
 * A configured search provider sent with a chat request. Key-based providers carry nothing: the
 * server reads their keys from its vault. Instance-URL providers (SearXNG) send their URLs, which
 * aren't secret, in priority order.
 */
export interface SearchCredentials {
  provider: SearchProviderId;
  keys?: string[];
}

/** One slot of an ordered key list: keep a saved key by id, or add a new secret. */
export type KeyEdit = { id: string } | { secret: string };

/** Which keys are saved, as opaque ids in priority order. Secrets never leave the server. */
export interface KeyInventory {
  /** Where secrets are stored: the OS keychain, a 0600 file when no keychain is available, or (hosted site) this browser. */
  backend: "keychain" | "file" | "browser";
  /** Entry ids per plan id, key-based search provider id, or the GitHub scope. */
  keys: Record<string, string[]>;
}

export interface SearchResultLink {
  title: string;
  url: string;
}

/** The model that condenses web search results before the chat model sees them ("efficient web search"). */
export interface SearchDigestModel {
  plan: PlanId;
  model: string;
  effort: Effort;
}

export interface ChatRequest {
  plan: PlanId;
  model: string;
  effort: Effort;
  system?: string;
  sessionId: string;
  messages: WireMessage[];
  /** Web search providers the model may call as tools. */
  search?: SearchCredentials[];
  /** Run the reply apart from this request, so it can be picked back up (see shared/replies.ts). */
  stream?: { id: string; key?: string };
  /** Condense each search's results with this model, and send the chat model only the digest. */
  digest?: SearchDigestModel;
}

/** Tokens and cost of a reply, and how full the thread's context is afterwards. */
export interface Usage {
  input?: number;
  output?: number;
  cost?: number;
  contextTokens?: number;
  contextWindow?: number;
}

/** Where a thread works: a project's own checkout, or a git worktree of it. */
export interface Workspace {
  projectId: string;
  projectName: string;
  /** The directory Pi runs in. */
  cwd: string;
  branch?: string;
  /** A worktree OpenBuild created for this thread (on its own branch). */
  worktree?: boolean;
  /** The branch the worktree was started from. */
  base?: string;
}

/** A project: a directory (usually a git repository) threads can work in. */
export interface Project {
  id: string;
  name: string;
  path: string;
  git: boolean;
  /** Missing from disk (moved or deleted). */
  missing?: boolean;
}

export interface GitInfo {
  branch?: string;
  branches: string[];
  /** Uncommitted changes (number of changed paths). */
  dirty: number;
  ahead?: number;
  behind?: number;
}

/** A turn of a thread, run by Pi in the thread's workspace. */
export interface PiChatRequest {
  threadId: string;
  cwd: string;
  /** "<provider>/<model id>" */
  model: string;
  effort: Effort;
  message: string;
  images?: { data: string; mimeType: string }[];
  /** User messages before this one in the thread; Pi's history is cut back to match (retry, edit). */
  prior: number;
  /** Legacy fork source: starts from a copy of that thread's Pi session. */
  forkFrom?: string;
  stream?: { id: string };
}

/** A slash command from Pi: an extension command, a prompt template or a skill. */
export interface PiCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | "openbuild";
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
      provider: ToolId;
      query: string;
      status: "running" | "done" | "error";
      results?: SearchResultLink[];
      error?: string;
      /** The results were condensed by the digest model before the chat model saw them. */
      digested?: boolean;
    }
  /** Pi ran a tool (read, bash, edit, an extension's tool…): started, progressed or finished. */
  | {
      t: "tool";
      id: string;
      name: string;
      args?: Record<string, unknown>;
      status: "running" | "done" | "error";
      /** The tool's text output (trimmed to its head and tail when long). */
      output?: string;
      /** Unified diff of a file change (edit/write). */
      patch?: string;
      ms?: number;
    }
  /** A Pi extension asks the user something (confirm, choose, type) and waits for the answer. */
  | { t: "ask"; id: string; method: "select" | "confirm" | "input" | "editor"; title: string; message?: string; options?: string[]; placeholder?: string; prefill?: string }
  /** That question was answered (or cancelled, or timed out). */
  | { t: "asked"; id: string; answer?: string }
  /** Pi read a message steered into the running turn (`id` as given when it was sent, if known). */
  | { t: "steer"; id?: string; text: string }
  | { t: "done"; finish?: string; usage?: Usage }
  /** The reply is over (after done, an error, or a stop). A stream that ends without it was cut off. */
  | { t: "end" };
