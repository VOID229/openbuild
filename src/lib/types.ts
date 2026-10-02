import type { Attachment, DetectResult, Effort, PlanId } from "../../shared/types";

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

export interface Settings {
  theme: Theme;
  autoScroll: boolean;
  cmdEnter: boolean;
  autoRouter: boolean;
  avoid: NamedModel[];
  prioritize: PriorityEntry[];
  profile: Profile;
  keys: Partial<Record<PlanId, string>>;
  selection?: Selection;
  effort: Effort;
}

export type Detection = DetectResult | { plan: PlanId; status: "checking"; models: DetectResult["models"]; checkedAt?: number };

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
  createdAt: number;
}

export interface Chat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}
