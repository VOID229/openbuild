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

/** The lowest reasoning a model supports: no thinking ("off") if it allows it, else the next level up. */
export function lowestEffort(levels: Effort[]): Effort {
  return nearestEffort(levels, "off") ?? "off";
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
  billing?: Billing;
  /** To price (or, for local, plan and free models, estimate) a thread's spend. */
  price?: Price;
  /** `price` is another listing's ("<provider>/<model id>"): the model's own provider reports none. */
  priceFrom?: string;
}

/**
 * Pi's scoped models: the `enabledModels` patterns in a device's Pi settings, and the models they
 * resolved to. A device with no scope lists every model its providers have.
 */
export interface ModelScope {
  patterns: string[];
  models: { provider: string; id: string }[];
  /** Patterns Pi couldn't use (no match, ambiguous, bad thinking level). */
  diagnostics?: { code: string; pattern: string; message: string }[];
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
  /** Picked from the composer's "@" menu: the text already names it, so no chip is shown. */
  mention?: boolean;
};

/** A workspace file's text, from GET /api/workspaces/file (for an "@" mention). */
export interface FileRead {
  /** Path relative to the workspace root. */
  path: string;
  name: string;
  dir: string;
  mime: string;
  size: number;
  text: string;
  /** When the file last changed on disk, to notice it changing under an open editor. */
  mtime?: number;
}

/** One entry of a folder in the file tree. */
export interface TreeEntry {
  name: string;
  dir: boolean;
  /** Matched by .gitignore. */
  ignored?: boolean;
  /** Uncommitted: "M" changed, "A" added, "?" new, "D" deleted, … (a folder: something in it changed). */
  git?: string;
}

/** A file or folder in a workspace, for the composer's "@" menu. */
export interface WorkspaceEntry {
  /** Path relative to the workspace root. */
  path: string;
  dir: boolean;
}

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

/** Tokens by kind: new input, input read from or written to the provider's cache, and output. */
export interface TokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** Tokens and cost of a reply, and how full the thread's context is afterwards. */
export interface Usage {
  /** Summed over the reply's model requests; `input` excludes cached input. */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** USD, as Pi priced it (0 when the provider reports no price: local, bundled in a plan, free). */
  cost?: number;
  contextTokens?: number;
  contextWindow?: number;
  /** The reply's last request: what the context holds now, by kind. */
  last?: TokenCounts;
  /** Prompt tokens of the reply's first request (in a thread's first reply: system prompt, tools and the first message). */
  firstPrompt?: number;
}

/** How a model is paid for: per token, by a subscription, running locally, or a free tier. */
export type Billing = "api" | "plan" | "local" | "free";

/** USD per 1M tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Where a thread works: a project's own checkout, or a git worktree of it. */
export interface Workspace {
  projectId: string;
  projectName: string;
  /** The directory Pi runs in. */
  cwd: string;
  /** The paired device this workspace lives on. Absent: the server this app is open on. */
  deviceId?: string;
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
  /** A paired device this project lives on. Absent: this server. `id` is namespaced as `<deviceId>::<id>` on the client. */
  deviceId?: string;
  /** That device's display name, for the "@device" label. */
  deviceName?: string;
}

/** Another OpenBuild server this one can use, paired over Tailscale or the local network. */
export interface Device {
  /** The device's server id (its OpenBuild data), also used as the proxy path segment. */
  id: string;
  /** The remote server's own id, which its reply streams mark as `via`. */
  serverId?: string;
  /** The name chosen when pairing. */
  name: string;
  /** The computer name, e.g. "Gal's MacBook Pro". */
  machine?: string;
  mode: "lan" | "tailscale";
  urls: string[];
  pairedAt?: number;
  lastSeenAt?: number;
  /** Reachable right now (checked when the device list is loaded). */
  online?: boolean;
  /** This server (always shown first in device pickers). */
  local?: boolean;
}

export interface GitInfo {
  branch?: string;
  branches: string[];
  /** Uncommitted changes (number of changed paths). */
  dirty: number;
  ahead?: number;
  behind?: number;
}

/** A changed path in a checkout, relative to the repository's top. */
export interface GitChange {
  path: string;
  /** "M" modified, "A" added, "D" deleted, "R" renamed, "?" untracked, "U" conflicted. */
  status: "M" | "A" | "D" | "R" | "?" | "U";
  /** A rename's old path. */
  from?: string;
  /** Some of it is staged already. */
  staged?: boolean;
}

/** What the Commit menu needs to know about a checkout. */
export interface GitChanges {
  repo: boolean;
  /** The repository's top folder. */
  root?: string;
  /** Where the workspace sits inside it ("" at the top, else "sub/dir/"). */
  prefix?: string;
  branch?: string;
  upstream?: string;
  /** Commits not pushed yet. */
  ahead?: number;
  behind?: number;
  /** The remote pushes go to when the branch has no upstream yet. */
  remote?: string;
  /** The remote's default branch, where pull requests go. */
  defaultBranch?: string;
  files: GitChange[];
  /** GitHub's CLI is installed, so pull requests can be opened. */
  gh?: boolean;
}

/** Runtime chosen when a thread starts; absent on legacy threads means Pi. */
export type ThreadRuntime = "pi" | "durable";

/** A turn of a thread, run by Pi in the thread's workspace. */
export interface PiChatRequest {
  threadId: string;
  runtime?: ThreadRuntime;
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

/** How a command the user ran ("!" or "!!") ended. */
export type ShellStatus = "running" | "done" | "stopped" | "error";

/**
 * NDJSON events for a command the user ran, from /api/pi/shells/:id. Whoever watches first gets the
 * output so far ("snap"), then new output as it comes, then how it ended.
 */
export type ShellEvent =
  | { t: "snap"; output: string; status: ShellStatus }
  | { t: "out"; v: string }
  /** It's over: its exit code, or why it didn't finish. `fullOutputPath`: Pi cut the output down for the model; all of it is in this file. */
  | { t: "exit"; status: Exclude<ShellStatus, "running">; exitCode?: number; fullOutputPath?: string; error?: string; ms: number }
  | { t: "end" };

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
  | { t: "ask"; id: string; method: "select" | "confirm" | "input" | "editor"; title: string; message?: string; options?: string[]; placeholder?: string; prefill?: string; other?: boolean }
  /** That question was answered (or cancelled, or timed out). */
  | { t: "asked"; id: string; answer?: string }
  /** Pi read a message steered into the running turn (`id` as given when it was sent, if known). */
  | { t: "steer"; id?: string; text: string }
  /** Tokens and cost so far, after each of the reply's model requests. */
  | { t: "usage"; usage: Usage }
  | { t: "done"; finish?: string; usage?: Usage }
  /** The reply is over (after done, an error, or a stop). A stream that ends without it was cut off. */
  | { t: "end" };
