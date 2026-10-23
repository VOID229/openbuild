import type { ReplyStream } from "../../shared/replies";
import type { Attachment, Effort, ModelInfo, PlanId, SearchProviderId, SearchResultLink, ToolId, Usage, Workspace } from "../../shared/types";

export type Theme = "light" | "dark" | "system";
export type FontStyle = "normal" | "fun" | "serif" | "mono";

export interface ModelRef {
  plan: PlanId;
  id: string;
}

/** What the composer is set to: a concrete model, or the experimental auto router. */
export type Selection = ModelRef | { auto: true };

export interface NamedModel {
  id: string;
  name: string;
}

export interface PriorityEntry extends NamedModel {
  tag: "Speed" | "complex";
}

export interface Profile {
  name: string;
  bio: string;
  location: string;
  language: string;
  avatar?: string;
}

/** One entry in the chat-naming model list (tried in order). */
export interface NamingModel extends ModelRef {
  effort: Effort;
}

export interface Settings {
  theme: Theme;
  font: FontStyle;
  autoScroll: boolean;
  cmdEnter: boolean;
  /** Opt-in transcription on the server's private Whisper endpoint. */
  dictation?: { enabled: boolean; connection: "lan" | "tailscale" };
  autoRouter: boolean;
  avoid: NamedModel[];
  prioritize: PriorityEntry[];
  profile: Profile;
  /** Saved key ids per plan, in priority order (later keys are fallbacks). The secrets live in the server's keychain. */
  keys: Partial<Record<PlanId, string[]>>;
  selection?: Selection;
  effort: Effort;
  /** Per-model reasoning defaults on the new-thread screen. */
  modelEfforts?: Record<string, Effort>;
  /** Web search: let models call the configured search providers. */
  webSearch: boolean;
  /** Saved key ids per search provider in priority order (SearXNG: instance URLs, which aren't secret). */
  search: Partial<Record<SearchProviderId, string[]>>;
  /** Saved GitHub token ids (the secrets live on the server). Optional: anonymous GitHub reads work without one. */
  github: string[];
  /**
   * Efficient web search: a separate model condenses each search's results and the chat model only
   * sees that digest. No model means the fastest available one.
   */
  searchDigest: { enabled: boolean; model?: NamingModel };
  /** Automatic chat titles; an empty model list means "fastest available model". */
  naming: { enabled: boolean; models: NamingModel[] };
  /** Account sync: also sync API keys (end-to-end encrypted). Off unless turned on. */
  syncApiKeys?: boolean;
  /** Where new threads work: a project (none = a scratch folder), in its checkout or a new worktree. */
  workspace: NewWorkspace;
  /** Starred Pi models ("<provider>/<id>"), in order; the first nine get ⌘1–⌘9. */
  favorites: string[];
}

export interface NewWorkspace {
  projectId?: string;
  mode: "local" | "worktree";
  /** Default workspace mode for new threads; last-used preserves the mode picker selection. */
  defaultMode?: "local" | "worktree" | "last-used";
  /** Local: the branch to switch to. Worktree: the branch to start from. None = the current one. */
  branch?: string;
}

export type DetectStatus = "checking" | "valid" | "invalid" | "error";

export interface KeyStatus {
  status: DetectStatus;
  error?: string;
  models?: number;
}

/** Models usable on a plan, merged across all of its keys. */
export interface Detection {
  plan: PlanId;
  status: DetectStatus;
  error?: string;
  models: ModelInfo[];
  checkedAt?: number;
  /** Per-key results, keyed by `keyId(key)` (of the saved key's id, never the key itself). */
  keys?: Record<string, KeyStatus>;
}

/** A web search the model ran while answering. */
export interface SearchCall {
  id: string;
  provider: ToolId;
  query: string;
  status: "running" | "done" | "error";
  results?: SearchResultLink[];
  error?: string;
  /** The results were condensed by the digest model. */
  digested?: boolean;
}

/** A tool Pi ran while answering (read a file, ran a command, edited code…). */
export interface ToolPart {
  type: "tool";
  id: string;
  name: string;
  args?: Record<string, unknown>;
  status: "running" | "done" | "error";
  output?: string;
  patch?: string;
  ms?: number;
}

/** A question a Pi extension asked during the reply, and the answer if there is one. */
export interface AskPart {
  type: "ask";
  id: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** A select that also takes the user's own words (question_ask's "Other"). */
  other?: boolean;
  /** Answered (the answer, or "" for cancelled / timed out); missing while waiting. */
  answer?: string;
}

/** A stretch of Pi's thinking, between the text and tools around it. */
export interface ThoughtPart {
  type: "thought";
  text: string;
  startedAt?: number;
  /** How long it thought; missing while it still is. */
  ms?: number;
}

/** A message the user steered into the reply while Pi was working, where Pi read it. */
export interface SteerPart {
  type: "steer";
  id?: string;
  text: string;
  attachments?: Attachment[];
}

/** A reply in order: what Pi wrote and thought, the tools it ran in between, questions it asked, and messages steered in. */
export type Part = { type: "text"; text: string } | ThoughtPart | ToolPart | AskPart | SteerPart;

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  attachments?: Attachment[];
  /** Assistant only */
  model?: ModelRef & { name: string; /** The reasoning level picked for that answer. */ effort?: Effort };
  routed?: boolean;
  status?: "streaming" | "done" | "error" | "stopped";
  error?: string;
  finish?: string;
  startedAt?: number;
  reasoningMs?: number;
  /** Pi replies: how long the whole turn took, from sending to done. */
  workedMs?: number;
  searches?: SearchCall[];
  /** e.g. "Opencode Go key 1 failed, so key 2 was used." */
  notice?: string;
  /** Where the reply runs, so it can be picked back up after a reload or a dropped connection. */
  stream?: ReplyStream;
  /** Pi replies: text, tool calls and questions in the order they happened (`content` is the text alone). */
  parts?: Part[];
  /** Tokens, cost and context fill after this reply. */
  usage?: Usage;
  createdAt: number;
}

export interface Chat {
  /** Reasoning preferences keyed by model identity (including the auto router). */
  efforts?: Record<string, Effort>;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  pinned?: boolean;
  archived?: boolean;
  /** "user" titles are never overwritten by automatic naming. */
  titleSource?: "auto" | "user";
  /** A reply finished while the chat wasn't open. */
  unread?: boolean;
  /** Legacy fork metadata, retained so existing threads keep their Pi session history. */
  forkOf?: string;
  /** Legacy source reply. */
  forkMessageId?: string;
  /** Legacy fork depth. */
  forkDepth?: number;
  /** Where the thread works (set when it starts; a fork works where its original did). */
  workspace?: Workspace;
}
