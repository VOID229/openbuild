import type { Attachment, Effort, ModelInfo, PlanId, SearchProviderId, SearchResultLink } from "../../shared/types";

export type Theme = "light" | "dark" | "system";

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
  autoScroll: boolean;
  cmdEnter: boolean;
  autoRouter: boolean;
  avoid: NamedModel[];
  prioritize: PriorityEntry[];
  profile: Profile;
  /** API keys per plan, in priority order (later keys are fallbacks). */
  keys: Partial<Record<PlanId, string[]>>;
  selection?: Selection;
  effort: Effort;
  /** Web search: let models call the configured search providers. */
  webSearch: boolean;
  /** Search API keys (SearXNG: instance URLs) per provider, in priority order. */
  search: Partial<Record<SearchProviderId, string[]>>;
  /** Automatic chat titles; an empty model list means "fastest available model". */
  naming: { enabled: boolean; models: NamingModel[] };
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
  /** Per-key results, keyed by `keyId(key)` (never the key itself). */
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
