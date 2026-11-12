// What a bot's turn cost, as numbers: how many model requests it took, how long the user waited for
// the first sign of life, the first tool call and the first reply, what the prompt cost in tokens and
// how much of it was cached, and how often a tool had to be loaded first. The runner fills one
// TurnMeter per turn and appends its record to bots/usage.jsonl (one JSON line per turn);
// scripts/bot-turn-metrics.ts summarizes that file, so a change can be measured against the turns
// before it.
//
// Numbers, enums and the names of OpenBots' own tools only: no text, no arguments, no names of the
// user's, no conversation ids. No imports at all: tests and the script use it as is, and the runner
// hands it the tool names (toolPreload.ts BOT_TOOLS).

/** OpenBots' own tools: the core every request declares, and the catalog a bot loads from. */
export interface ToolNames {
  core: ReadonlySet<string>;
  catalog: ReadonlySet<string>;
}

export type TurnTrigger = "messages" | "routine" | "heartbeat" | "note" | "reaction";
/** How a turn ended: it wrote to the chat, chose not to, was stopped, failed, or never reached the model. */
export type TurnOutcome = "replied" | "silent" | "stopped" | "error" | "skipped";

export interface TurnRecord {
  bot: string;
  turn: string;
  /** When the turn ended. */
  at: number;
  source: "assistant-message-usage";
  /** A provider reported usage for at least one request. */
  measured: boolean;
  excludesCompactionUsage: true;
  /** Model requests the turn made, failed ones included. */
  calls?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Records from before the fields below carry none of them. */
  v?: 2;
  trigger?: TurnTrigger;
  /** A chat shared with a friend: a Pi and session of its own. */
  friend?: boolean;
  /** The turn answered a message of the user's: the times below are what they sat through. */
  waiting?: boolean;
  outcome?: TurnOutcome;
  /** Requests whose model call failed: each one a retry or a fallback to the next model. */
  failedCalls?: number;
  /** The turn started a Pi process (the bot's first turn, after an idle spell, or in another conversation). */
  piStarted?: boolean;
  /** Catalog tools its Pi was started with (toolPreload.ts). */
  preloaded?: number;
  /** From the message that woke the bot (the user's, for a waiting turn) to… the turn starting. */
  queuedMs?: number;
  /** …the prompt reaching Pi: the queue, starting Pi and setting its model. */
  promptMs?: number;
  /** …the chat first showing the bot at work. */
  statusMs?: number;
  /** …its first tool call. */
  toolMs?: number;
  /** …its first message in the chat. */
  replyMs?: number;
  /** …the turn ending. */
  doneMs?: number;
  /** The first tool it called: one of OpenBots' own, or "other". */
  firstTool?: string;
  toolCalls?: number;
  /** load_tools calls: each took a model request of its own. */
  loads?: number;
  /** Tools those calls named. */
  loaded?: number;
  /** Calls to a tool that wasn't loaded: each failed once and was asked for again. */
  unloadedCalls?: number;
  /** Catalog tools the turn used. */
  tools?: string[];
}

const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** The result of a call to a tool that wasn't loaded: Pi's own wording, or what extension.ts makes of it. */
export function unloadedResult(message: { role?: string; isError?: boolean; toolName?: string; content?: unknown } | undefined, catalog: ReadonlySet<string>): boolean {
  if (message?.role !== "toolResult" || !message.isError || !message.toolName || !catalog.has(message.toolName)) return false;
  const text = Array.isArray(message.content) ? String((message.content[0] as { text?: unknown } | undefined)?.text ?? "") : "";
  return text === `Tool ${message.toolName} not found` || text.startsWith(`${message.toolName} wasn't loaded`);
}

export class TurnMeter {
  private readonly record: TurnRecord;
  private readonly since: number;
  private readonly used = new Set<string>();
  private readonly names: ToolNames;
  private prompted = false;

  /** `since` is when the message that woke the bot arrived; `now` when its turn starts. */
  constructor(init: { bot: string; trigger: TurnTrigger; friend?: boolean; waiting: boolean; since: number; tools: ToolNames }, now = Date.now()) {
    this.names = init.tools;
    this.since = Math.min(init.since, now);
    this.record = {
      bot: init.bot, turn: crypto.randomUUID(), at: now, source: "assistant-message-usage", measured: false, excludesCompactionUsage: true,
      calls: 0, v: 2, trigger: init.trigger, ...(init.friend ? { friend: true } : {}), waiting: init.waiting, failedCalls: 0,
      queuedMs: now - this.since, toolCalls: 0, loads: 0, loaded: 0, unloadedCalls: 0,
    };
  }

  private elapsed(now: number): number {
    return Math.max(0, now - this.since);
  }

  /** Its Pi: whether this turn had to start one, and how many catalog tools it came up with. */
  pi(started: boolean, preloaded: number) {
    this.record.piStarted = started;
    this.record.preloaded = preloaded;
  }

  /** The prompt is in Pi's hands. A second attempt, on a fallback model, doesn't move it. */
  prompt(now = Date.now()) {
    this.prompted = true;
    this.record.promptMs ??= this.elapsed(now);
  }

  /** The chat shows the bot at work. */
  status(now = Date.now()) {
    this.record.statusMs ??= this.elapsed(now);
  }

  /** A model request ended, with what the provider said it used. */
  request(usage: Record<string, unknown> | undefined, failed: boolean) {
    this.record.calls = (this.record.calls ?? 0) + 1;
    if (failed) this.record.failedCalls = (this.record.failedCalls ?? 0) + 1;
    if (!usage) return;
    this.record.measured = true;
    for (const key of USAGE_KEYS) {
      const value = usage[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) this.record[key] = (this.record[key] ?? 0) + value;
    }
  }

  /** A tool call started. */
  tool(name: string, args: unknown, now = Date.now()) {
    this.record.toolCalls = (this.record.toolCalls ?? 0) + 1;
    this.record.toolMs ??= this.elapsed(now);
    this.record.firstTool ??= this.names.core.has(name) || this.names.catalog.has(name) ? name : "other";
    if (this.names.catalog.has(name)) this.used.add(name);
    if (name !== "load_tools") return;
    this.record.loads = (this.record.loads ?? 0) + 1;
    const names = args && typeof args === "object" ? (args as { names?: unknown }).names : undefined;
    this.record.loaded = (this.record.loaded ?? 0) + (Array.isArray(names) ? names.length : names ? 1 : 0);
  }

  /** A tool was called before it was loaded. */
  unloaded() {
    this.record.unloadedCalls = (this.record.unloadedCalls ?? 0) + 1;
  }

  /** The bot's words reached the chat. */
  reply(now = Date.now()) {
    this.record.replyMs ??= this.elapsed(now);
  }

  /** Catalog tools the turn has used so far. */
  tools(): string[] {
    return [...this.used];
  }

  /** The finished record. Without `outcome` it's told from what happened: skipped, replied or silent. */
  finish(outcome?: TurnOutcome, now = Date.now()): TurnRecord {
    return {
      ...this.record,
      at: now,
      outcome: outcome ?? (!this.prompted ? "skipped" : this.record.replyMs === undefined ? "silent" : "replied"),
      doneMs: this.elapsed(now),
      ...(this.used.size ? { tools: [...this.used].sort() } : {}),
    };
  }
}

// ------------------------------------------------------------------ summary

export interface Spread {
  n: number;
  mean: number;
  p50: number;
  p90: number;
}

export interface TurnSummary {
  /** Lines read, and of them the turns that reached the model. */
  records: number;
  turns: number;
  /** Turns with the fields this file adds; older lines count toward requests and tokens only. */
  detailed: number;
  from?: number;
  to?: number;
  requestsPerTurn: Spread;
  /** Share of all requests whose model call failed. */
  failedRequestShare?: number;
  tokens: {
    /** Prompt tokens (uncached input + cache read + cache write) per turn and per request. */
    promptPerTurn: Spread;
    promptPerRequest: number;
    /** Share of prompt tokens read from cache. */
    cachedShare: number;
    outputPerTurn: number;
    total: { input: number; cacheRead: number; cacheWrite: number; output: number };
  };
  /** Turns that answered a message of the user's: what they waited, in milliseconds. */
  waiting: { turns: number; queuedMs: Spread; promptMs: Spread; statusMs: Spread; toolMs: Spread; replyMs: Spread; doneMs: Spread };
  loads: {
    /** Share of turns that spent a request on load_tools, or called a tool that wasn't loaded. */
    turnsLoadingShare?: number;
    loadsPerTurn?: number;
    unloadedCallsPerTurn?: number;
    /** Share of all requests that only loaded a tool or retried an unloaded one. */
    requestShare?: number;
    preloadedPerTurn?: number;
  };
  /** Share of turns that had to start a Pi process first. */
  piStartedShare?: number;
  outcomes: Record<string, number>;
  /** Catalog tools by the share of turns that used them. */
  tools: Record<string, number>;
}

const round = (value: number, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : 0);

/** Nearest-rank percentile of the values, which needn't be sorted. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export function spread(values: number[], digits = 2): Spread {
  const n = values.length;
  return { n, mean: n ? round(values.reduce((a, b) => a + b, 0) / n, digits) : 0, p50: round(percentile(values, 50), digits), p90: round(percentile(values, 90), digits) };
}

/** One JSON line per turn; anything that isn't a turn record is skipped. */
export function parseTurns(text: string): TurnRecord[] {
  const records: TurnRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as TurnRecord;
      if (record && typeof record === "object" && typeof record.at === "number" && typeof record.bot === "string") records.push(record);
    } catch {
      // A line cut short by a crash mid-write.
    }
  }
  return records;
}

export interface TurnFilter {
  since?: number;
  until?: number;
  /** A bot's id, or the start of it. */
  bot?: string;
}

export function filterTurns(records: TurnRecord[], { since, until, bot }: TurnFilter = {}): TurnRecord[] {
  return records.filter((r) => (since === undefined || r.at >= since) && (until === undefined || r.at < until) && (!bot || r.bot.startsWith(bot)));
}

const prompt = (r: TurnRecord) => (r.input ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0);
const defined = (records: TurnRecord[], key: "queuedMs" | "promptMs" | "statusMs" | "toolMs" | "replyMs" | "doneMs") => records.flatMap((r) => (typeof r[key] === "number" ? [r[key]!] : []));

export function summarizeTurns(records: TurnRecord[]): TurnSummary {
  // A turn that never reached the model (nothing to show, or stopped first) says nothing about speed.
  const turns = records.filter((r) => (r.calls ?? 0) > 0);
  const detailed = turns.filter((r) => r.v === 2);
  const waiting = detailed.filter((r) => r.waiting);
  const requests = turns.reduce((n, r) => n + (r.calls ?? 0), 0);
  const total = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const r of turns) for (const key of USAGE_KEYS) total[key] += r[key] ?? 0;
  const promptTotal = total.input + total.cacheRead + total.cacheWrite;
  const share = (n: number, of: number) => (of ? round(n / of, 3) : 0);
  const detailedRequests = detailed.reduce((n, r) => n + (r.calls ?? 0), 0);
  const tools: Record<string, number> = {};
  for (const r of detailed) for (const name of r.tools ?? []) tools[name] = (tools[name] ?? 0) + 1;
  const outcomes: Record<string, number> = {};
  for (const r of records.filter((r) => r.v === 2)) outcomes[r.outcome ?? "unknown"] = (outcomes[r.outcome ?? "unknown"] ?? 0) + 1;
  return {
    records: records.length,
    turns: turns.length,
    detailed: detailed.length,
    ...(turns.length ? { from: Math.min(...turns.map((r) => r.at)), to: Math.max(...turns.map((r) => r.at)) } : {}),
    requestsPerTurn: spread(turns.map((r) => r.calls ?? 0)),
    ...(detailed.length ? { failedRequestShare: share(detailed.reduce((n, r) => n + (r.failedCalls ?? 0), 0), detailedRequests) } : {}),
    tokens: {
      promptPerTurn: spread(turns.filter((r) => r.measured).map(prompt), 0),
      promptPerRequest: requests ? Math.round(promptTotal / requests) : 0,
      cachedShare: share(total.cacheRead, promptTotal),
      outputPerTurn: turns.length ? Math.round(total.output / turns.length) : 0,
      total,
    },
    waiting: {
      turns: waiting.length,
      queuedMs: spread(defined(waiting, "queuedMs"), 0),
      promptMs: spread(defined(waiting, "promptMs"), 0),
      statusMs: spread(defined(waiting, "statusMs"), 0),
      toolMs: spread(defined(waiting, "toolMs"), 0),
      replyMs: spread(defined(waiting, "replyMs"), 0),
      doneMs: spread(defined(waiting, "doneMs"), 0),
    },
    loads: detailed.length
      ? {
          turnsLoadingShare: share(detailed.filter((r) => (r.loads ?? 0) + (r.unloadedCalls ?? 0) > 0).length, detailed.length),
          loadsPerTurn: round(detailed.reduce((n, r) => n + (r.loads ?? 0), 0) / detailed.length),
          unloadedCallsPerTurn: round(detailed.reduce((n, r) => n + (r.unloadedCalls ?? 0), 0) / detailed.length),
          requestShare: share(detailed.reduce((n, r) => n + (r.loads ?? 0) + (r.unloadedCalls ?? 0), 0), detailedRequests),
          preloadedPerTurn: round(detailed.reduce((n, r) => n + (r.preloaded ?? 0), 0) / detailed.length),
        }
      : {},
    ...(detailed.length ? { piStartedShare: share(detailed.filter((r) => r.piStarted).length, detailed.length) } : {}),
    outcomes,
    tools: Object.fromEntries(Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([name, n]) => [name, share(n, detailed.length)])),
  };
}

const ms = (value: number) => (value >= 10_000 ? `${(value / 1000).toFixed(0)} s` : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`);
const pct = (value: number | undefined) => (value === undefined ? "–" : `${(value * 100).toFixed(1)}%`);
const count = (value: number) => Math.round(value).toLocaleString("en-US");

/** The summary as rows of a table: a label, then one cell per summary (one column, or before and after). */
export function summaryRows(summaries: TurnSummary[]): string[][] {
  const row = (label: string, cell: (s: TurnSummary) => string) => [label, ...summaries.map(cell)];
  const times = (label: string, key: keyof Omit<TurnSummary["waiting"], "turns">) => row(label, (s) => (s.waiting[key].n ? `${ms(s.waiting[key].p50)} / ${ms(s.waiting[key].p90)}` : "–"));
  const day = (at?: number) => (at ? new Date(at).toISOString().slice(0, 16).replace("T", " ") : "–");
  return [
    row("Turns (that reached the model)", (s) => `${count(s.turns)}${s.detailed < s.turns ? ` (${count(s.detailed)} with timings)` : ""}`),
    row("From – to (UTC)", (s) => `${day(s.from)} – ${day(s.to)}`),
    row("Model requests per turn: mean / p50 / p90", (s) => `${s.requestsPerTurn.mean} / ${s.requestsPerTurn.p50} / ${s.requestsPerTurn.p90}`),
    row("Requests that failed (retry or fallback)", (s) => pct(s.failedRequestShare)),
    row("Requests spent loading tools", (s) => pct(s.loads.requestShare)),
    row("Turns that loaded a tool first", (s) => pct(s.loads.turnsLoadingShare)),
    row("load_tools calls per turn", (s) => (s.loads.loadsPerTurn === undefined ? "–" : String(s.loads.loadsPerTurn))),
    row("Calls to an unloaded tool per turn", (s) => (s.loads.unloadedCallsPerTurn === undefined ? "–" : String(s.loads.unloadedCallsPerTurn))),
    row("Tools preloaded per turn", (s) => (s.loads.preloadedPerTurn === undefined ? "–" : String(s.loads.preloadedPerTurn))),
    row("Turns that started Pi first", (s) => pct(s.piStartedShare)),
    row("Turns answering the user", (s) => count(s.waiting.turns)),
    times("  message → turn starts: p50 / p90", "queuedMs"),
    times("  message → prompt sent: p50 / p90", "promptMs"),
    times("  message → first status: p50 / p90", "statusMs"),
    times("  message → first tool call: p50 / p90", "toolMs"),
    times("  message → first reply: p50 / p90", "replyMs"),
    times("  message → turn done: p50 / p90", "doneMs"),
    row("Prompt tokens per turn: mean / p50 / p90", (s) => `${count(s.tokens.promptPerTurn.mean)} / ${count(s.tokens.promptPerTurn.p50)} / ${count(s.tokens.promptPerTurn.p90)}`),
    row("Prompt tokens per request", (s) => count(s.tokens.promptPerRequest)),
    row("Prompt tokens read from cache", (s) => pct(s.tokens.cachedShare)),
    row("Output tokens per turn", (s) => count(s.tokens.outputPerTurn)),
    row("Most used catalog tools (share of turns)", (s) => Object.entries(s.tools).slice(0, 4).map(([name, n]) => `${name} ${pct(n)}`).join(", ") || "–"),
  ];
}

/** The rows as aligned text. */
export function formatTable(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((cell, i) => (i ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join("  ").trimEnd();
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}
