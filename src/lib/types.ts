import type { ReplyStream } from "../../shared/replies";
import type { Attachment, Effort, ModelInfo, PlanId, SearchProviderId, SearchResultLink } from "../../shared/types";

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
  autoRouter: boolean;
  avoid: NamedModel[];
  prioritize: PriorityEntry[];
  profile: Profile;
  /** Saved key ids per plan, in priority order (later keys are fallbacks). The secrets live in the server's keychain. */
  keys: Partial<Record<PlanId, string[]>>;
  selection?: Selection;
  effort: Effort;
  /** Web search: let models call the configured search providers. */
  webSearch: boolean;
  /** Saved key ids per search provider in priority order (SearXNG: instance URLs, which aren't secret). */
  search: Partial<Record<SearchProviderId, string[]>>;
  /** Automatic chat titles; an empty model list means "fastest available model". */
  naming: { enabled: boolean; models: NamingModel[] };
  /** Account sync: also sync API keys (end-to-end encrypted). Off unless turned on. */
  syncApiKeys?: boolean;
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
  provider: SearchProviderId;
  query: string;
  status: "running" | "done" | "error";
  results?: SearchResultLink[];
  error?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  attachments?: Attachment[];
  /** Assistant only */
  model?: ModelRef & { name: string };
  routed?: boolean;
  status?: "streaming" | "done" | "error" | "stopped";
  error?: string;
  finish?: string;
  startedAt?: number;
  reasoningMs?: number;
  searches?: SearchCall[];
  /** e.g. "Opencode Go key 1 failed, so key 2 was used." */
  notice?: string;
  /** Where the reply runs, so it can be picked back up after a reload or a dropped connection. */
  stream?: ReplyStream;
  createdAt: number;
}

export interface Chat {
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
  /** Set on chats created with "2nd": the chat they were forked from… */
  forkOf?: string;
  /** …and the reply in that chat they re-answer. */
  forkMessageId?: string;
}
