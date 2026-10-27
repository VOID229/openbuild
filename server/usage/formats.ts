// How each agent records token use in its transcripts, one JSON object per line. Parsers are
// incremental: a file is read from where the last scan stopped, with whatever a parser needs to
// carry between lines (the current model, a session id) kept in its state.
import type { UsageProvider } from "../../shared/usage";

/** One model request (or a turn, where that's all a transcript records). */
export interface Rec {
  t: number;
  model: string;
  session: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** USD the transcript reports; null to estimate from the model's price. */
  cost: number | null;
  /** Identifies the request across files: forks, copies and moved transcripts repeat it. */
  key: string;
}

export interface Format<S = any> {
  provider: UsageProvider;
  initial(): S;
  /** Strings a line must contain to be worth parsing; most transcript lines are content. */
  markers: string[];
  parse(line: any, state: S, out: Rec[]): void;
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const time = (v: unknown) => {
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) && t > 0 ? t : 0;
};
const used = (r: Pick<Rec, "input" | "cacheRead" | "cacheWrite" | "output">) => r.input + r.cacheRead + r.cacheWrite + r.output > 0;

// ------------------------------------------------------------------ Pi

/** Pi sessions (~/.pi/agent/sessions): usage on each assistant message, with its provider and model. */
export const pi: Format<{ session: string }> = {
  provider: "pi",
  initial: () => ({ session: "" }),
  markers: ['"usage"', '"type":"session"'],
  parse(e, state, out) {
    if (e.type === "session") {
      state.session = str(e.id);
      return;
    }
    const t = time(e.timestamp);
    if (!t) return;
    const m = e.type === "message" ? obj(e.message) : e;
    if (e.type === "message" && m.role !== "assistant" && m.role !== "toolResult") return;
    const u = obj(m.usage);
    // Pi's input and cache counters are already disjoint.
    const r = { input: n(u.input), cacheRead: n(u.cacheRead), cacheWrite: n(u.cacheWrite), output: n(u.output) };
    const reported = typeof u.cost?.total === "number" && u.cost.total > 0 ? u.cost.total : null;
    if (!used(r) && reported === null) return;
    // Tool results and summaries that used a model carry no model of their own.
    const model = m.provider && m.model ? `${m.provider}/${m.responseModel || m.model}` : "Tools & summaries";
    // Forks copy entries with their ids and timestamps.
    out.push({ t, model, session: state.session, ...r, cost: reported, key: `pi:${str(e.id)}:${e.timestamp}:${model}` });
  },
};

// ------------------------------------------------------------------ Claude Code

/** Claude Code (~/.claude/projects): each content block of a message repeats the message's usage. */
export const claude: Format<null> = {
  provider: "claude",
  initial: () => null,
  markers: ['"usage"'],
  parse(e, _state, out) {
    if (e.type !== "assistant") return;
    const m = obj(e.message);
    const model = str(m.model);
    // Placeholders for replies that never reached the API.
    if (!model || model === "<synthetic>") return;
    const t = time(e.timestamp);
    if (!t) return;
    const u = obj(m.usage);
    const r = { input: n(u.input_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), output: n(u.output_tokens) };
    if (!used(r)) return;
    const id = `${str(m.id)}:${str(e.requestId)}`;
    out.push({ t, model, session: str(e.sessionId), ...r, cost: typeof e.costUSD === "number" ? e.costUSD : null, key: id === ":" ? `claude:${e.uuid ?? t}` : `claude:${id}` });
  },
};

// ------------------------------------------------------------------ Codex

interface CodexState {
  session: string;
  model: string;
  /** The last cumulative total seen, to skip counters Codex re-emits. */
  total: number;
  /** A forked session starts by copying its parent's history in a burst; that's billed in the parent. */
  forkUntil: number;
  sawMeta: boolean;
}

/** Codex rollouts (~/.codex/sessions, often .jsonl.zst): `token_count` events, model from `turn_context`. */
export const codex: Format<CodexState> = {
  provider: "codex",
  initial: () => ({ session: "", model: "", total: -1, forkUntil: 0, sawMeta: false }),
  markers: ['"token_count"', '"turn_context"', '"session_meta"'],
  parse(e, state, out) {
    const p = obj(e.payload);
    const t = time(e.timestamp);
    if (e.type === "session_meta") {
      // Only the first: copied ancestor metas would misattribute what follows.
      if (state.sawMeta) return;
      state.sawMeta = true;
      state.session = str(p.id) || str(p.session_id);
      if (p.forked_from_id || p.source?.subagent?.thread_spawn?.parent_thread_id) state.forkUntil = t + 1000;
      return;
    }
    if (e.type === "turn_context") {
      if (p.model) state.model = str(p.model);
      return;
    }
    if (p.type !== "token_count" || !t || !state.model) return;
    const info = obj(p.info);
    const last = obj(info.last_token_usage);
    const total = n(obj(info.total_token_usage).total_tokens);
    if (state.forkUntil && t < state.forkUntil) {
      // Copied history arrives within milliseconds; real requests follow a model turn.
      state.forkUntil = t + 1000;
      if (total) state.total = total;
      return;
    }
    state.forkUntil = 0;
    if (total && total === state.total) return;
    if (total) state.total = total;
    const input = n(last.input_tokens);
    const cached = Math.min(input, n(last.cached_input_tokens));
    const write = Math.min(input - cached, n(last.cache_write_input_tokens));
    // Codex counts cached input inside input_tokens.
    const r = { input: input - cached - write, cacheRead: cached, cacheWrite: write, output: n(last.output_tokens) };
    if (!used(r)) return;
    out.push({ t, model: state.model, session: state.session, ...r, cost: null, key: `codex:${state.session}:${t}:${input}:${r.output}` });
  },
};

// ------------------------------------------------------------------ Grok

const GROK_TICKS_PER_USD = 1e10;

/** Grok Build (~/.grok/sessions/<cwd>/<id>/updates.jsonl): usage per turn, split by model. */
export const grok: Format<null> = {
  provider: "grok",
  initial: () => null,
  markers: ['"turn_completed"'],
  parse(e, _state, out) {
    const params = obj(e.params);
    const update = obj(params.update);
    if (update.sessionUpdate !== "turn_completed") return;
    const usage = obj(update.usage);
    const t = time(params._meta?.agentTimestampMs) || time(e.timestamp);
    if (!t) return;
    const session = str(params.sessionId);
    const prompt = str(update.prompt_id) || String(t);
    const read = (u: Record<string, any>) => {
      const cacheRead = n(u.cachedReadTokens);
      const cacheWrite = n(u.cacheCreationTokens);
      // Like Codex, inputTokens includes the cached part.
      return { input: Math.max(0, n(u.inputTokens) - cacheRead - cacheWrite), cacheRead, cacheWrite, output: n(u.outputTokens), ticks: typeof u.costUsdTicks === "number" ? u.costUsdTicks : null };
    };
    const models = Object.entries(obj(usage.modelUsage)).filter(([m]) => m);
    const turn = read(usage);
    const rows = models.length ? models.map(([m, u]) => [m, read(obj(u))] as const) : ([["grok", turn]] as const);
    for (const [model, { ticks, ...r }] of rows) {
      if (!used(r)) continue;
      // A model without its own cost gets the turn's (only when it's the only model).
      const cost = ticks !== null ? ticks / GROK_TICKS_PER_USD : rows.length === 1 && turn.ticks !== null ? turn.ticks / GROK_TICKS_PER_USD : null;
      out.push({ t, model, session, ...r, cost, key: `grok:${session}:${prompt}:${model}` });
    }
  },
};

// ------------------------------------------------------------------ OpenCode

/** An OpenCode message (its SQLite `message` / `session_message` rows), or null. */
export function opencodeRecord(data: string, id: string, session: string, created: number): Rec | null {
  let m: Record<string, any>;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (m.role !== undefined && m.role !== "assistant") return null;
  const tokens = obj(m.tokens);
  const model = str(obj(m.model).id) || str(obj(m.model).modelID) || str(m.modelID);
  const t = time(obj(m.time).created) || created;
  if (!model || !t) return null;
  const r = { input: n(tokens.input), cacheRead: n(obj(tokens.cache).read), cacheWrite: n(obj(tokens.cache).write), output: n(tokens.output) + n(tokens.reasoning) };
  if (!used(r)) return null;
  // OpenCode records 0 for unknown prices, subscriptions included.
  return { t, model, session: str(m.sessionID) || session, ...r, cost: typeof m.cost === "number" && m.cost > 0 ? m.cost : null, key: `opencode:${id}` };
}

/** Strip Cursor's effort and speed suffixes, for pricing (`cursor-grok-4.6-high-fast` → `grok-4.6`). */
export const cursorPriceModel = (model: string) =>
  model.replace(/^cursor-/, "").replace(/(?:-thinking)?(?:-(?:none|minimal|low|medium|high|xhigh|max))?(?:-fast)?$/, "");
