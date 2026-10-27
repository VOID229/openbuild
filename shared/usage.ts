// Usage across the coding agents installed on this machine (Pi and Durable threads, Claude Code,
// Codex, Grok, Cursor, OpenCode): tokens and cost from their transcripts, and their plans' limits.
// Built by server/usage/, shown by src/components/UsagePage.tsx.

export const USAGE_PROVIDERS = ["pi", "claude", "codex", "grok", "cursor", "opencode"] as const;
export type UsageProvider = (typeof USAGE_PROVIDERS)[number];

export const USAGE_PROVIDER_NAMES: Record<UsageProvider, string> = {
  pi: "Pi",
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  cursor: "Cursor",
  opencode: "OpenCode",
};

export const USAGE_RANGES = ["24h", "7d", "30d", "90d"] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

/** Tokens by kind. `input` excludes cached input; reasoning is part of `output`. */
export interface UsageTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface UsageProviderSummary {
  id: UsageProvider;
  sessions: number;
  requests: number;
  cost: number;
  tokens: number;
}

export interface UsageModelRow {
  provider: UsageProvider;
  model: string;
  cost: number;
  tokens: number;
  requests: number;
}

export interface UsageDayRow {
  /** Bucket start, ms. */
  t: number;
  cost: number;
  tokens: number;
  sessions: number;
}

export interface UsageReport {
  range: UsageRange;
  /** Hourly buckets for the past day, daily otherwise. */
  bucket: "hour" | "day";
  start: number;
  end: number;
  /** Providers with any use in the range, by cost. */
  providers: UsageProviderSummary[];
  /** One entry per bucket, oldest first; values in `providers` order. */
  series: { t: number; cost: number[]; tokens: number[] }[];
  totals: UsageTokens & { cost: number; sessions: number; requests: number; cacheSavings: number };
  /** Estimated cost by token kind. `other` is cost a provider reported without a breakdown. */
  costByType: UsageTokens & { other: number };
  models: UsageModelRow[];
  days: UsageDayRow[];
  /** Models that used tokens but have no known price; their cost counts as 0. */
  unpriced: string[];
  /** Sources still being read in the background; ask again shortly for them. */
  pending?: UsageProvider[];
  /** Sources that couldn't be read. */
  problems: { provider: UsageProvider; message: string }[];
  generatedAt: number;
}

export interface UsageWindow {
  id: string;
  label: string;
  kind: "session" | "weekly" | "monthly" | "other";
  usedPercent: number;
  resetsAt?: number;
  windowMins?: number;
  /** Dollar-metered limits: amounts in USD. */
  usedUsd?: number;
  limitUsd?: number;
}

export interface UsageLimits {
  /** Unique per account. */
  id: string;
  provider: UsageProvider;
  /** Set when a provider has more than one account here: "1", "2", … (from the config dir or Pi provider). */
  account?: string;
  /** Where the sign-in was read from: `~/.claude-2`, `Pi · openai-codex-2`. */
  source?: string;
  plan?: string;
  windows: UsageWindow[];
  /** When the numbers were taken; a snapshot from a transcript can be older than this request. */
  asOf: number;
  /** Read from the last transcript rather than asked live. */
  stale?: boolean;
  /** Banked resets (Codex). */
  resetCredits?: number;
  error?: string;
}

export interface UsageLimitsReport {
  providers: UsageLimits[];
  checkedAt: number;
}
