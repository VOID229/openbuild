// What loading tools on demand cost in recorded bot sessions, and what it would have cost with
// loaded tools kept across Pi restarts and each bot's usual tools declared from the start
// (server/bots/toolPreload.ts). Offline only: point it at an isolated copy of bots/sessions, never the
// live directory. It prints numeric aggregates and OpenBots' own tool names, nothing else.
//
//   bun scripts/bot-tool-loads.ts <copied-session-directory> [--since ISO] [--json]
//
// "recorded" is read off the transcripts: every request that did nothing but load a tool (a
// load_tools call, or a call to a tool that wasn't loaded and had to be made again), every time a
// restarted Pi came back without the tools the session had loaded, and the tool declarations each
// request carried. "replayed" walks the same turns in order under the new rule: a session keeps what
// it loaded, a new session starts with the tools the bot used in two or more turns of the week before
// (within the budget), and a turn that needs a tool it doesn't have spends one request loading it.
// The replay is an estimate: it assumes the bot would have made the same tool calls.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import openbots, { CATALOG_BRIEF, CORE_TOOLS } from "../server/bots/extension";
import { declarationSizes, noteToolUse, preloadTools, type ToolUsage } from "../server/bots/toolPreload";

/** The repo's estimate: see scripts/bot-context-audit.ts. */
const BYTES_PER_TOKEN = 4.28;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".jsonl") ? [path] : [];
  });

interface Turn {
  at: number;
  /** Catalog tools the turn called. */
  used: Set<string>;
  requests: { prompt: number; uncached: number; declared: number; wasted: boolean }[];
}
interface Session {
  bot: string;
  start: number;
  turns: Turn[];
  /** Times a restarted Pi dropped tools the session had loaded, and the tools dropped. */
  drops: number;
  dropped: number;
  /** Uncached prompt tokens of the request right after each drop: the prompt cache went with the tools. */
  uncachedAfterDrop: number;
}

export function readSession(text: string, sizes: Record<string, number>, coreSize: number, since = 0): Omit<Session, "bot"> | undefined {
  const entries = text.split("\n").flatMap((line) => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
  // Sessions from before the catalog declared every tool: nothing to load, nothing to measure.
  if (!entries.some((e) => e.message?.role === "system" && (e.message.toolsAdded ?? []).some((t: { name?: string }) => t.name === "load_tools"))) return undefined;
  const session: Omit<Session, "bot"> = { start: 0, turns: [], drops: 0, dropped: 0, uncachedAfterDrop: 0 };
  const loaded = new Set<string>();
  let turn: Turn = { at: 0, used: new Set(), requests: [] };
  let afterDrop = false;
  /** Tool calls of the last assistant message, and how many of them only loaded a tool or weren't loaded. */
  let calls = 0, idle = 0;
  const settle = () => {
    const last = turn.requests.at(-1);
    if (last && calls > 0 && idle === calls) last.wasted = true;
    calls = idle = 0;
  };
  for (const e of entries) {
    const at = Date.parse(e.timestamp);
    const m = e.type === "message" ? e.message : undefined;
    if (!m) continue;
    session.start ||= at;
    if (m.role === "system") {
      const removed = (m.toolsRemoved ?? []).map((t: { name: string }) => t.name).filter((name: string) => name in CATALOG_BRIEF && !(m.toolsAdded ?? []).some((t: { name: string }) => t.name === name));
      for (const name of removed) loaded.delete(name);
      for (const t of m.toolsAdded ?? []) if (t.name in CATALOG_BRIEF) loaded.add(t.name);
      if (removed.length && at >= since) {
        session.drops++;
        session.dropped += removed.length;
        afterDrop = true;
      }
      continue;
    }
    if (m.role === "assistant") {
      settle();
      const usage = m.usage ?? {};
      const prompt = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      const uncached = (usage.input ?? 0) + (usage.cacheWrite ?? 0);
      if (afterDrop && prompt) {
        session.uncachedAfterDrop += uncached;
        afterDrop = false;
      }
      turn.at ||= at;
      turn.requests.push({ prompt, uncached, declared: coreSize + [...loaded].reduce((n, name) => n + (sizes[name] ?? 0), 0), wasted: false });
      for (const c of m.content ?? []) {
        if (c.type !== "toolCall") continue;
        calls++;
        if (c.name === "load_tools") idle++;
        else if (c.name in CATALOG_BRIEF) turn.used.add(c.name);
      }
      if (m.stopReason === "stop" || m.stopReason === "length") {
        settle();
        if (turn.at >= since) session.turns.push(turn);
        turn = { at: 0, used: new Set(), requests: [] };
      }
    }
    if (m.role === "toolResult" && m.isError && /wasn't loaded|^Tool \S+ not found$/.test(String(m.content?.[0]?.text ?? ""))) idle++;
  }
  return session;
}

export interface LoadReport {
  sessions: number;
  bots: number;
  turns: number;
  requests: number;
  recorded: { loadRequests: number; loadRequestShare: number; turnsLoading: number; turnsLoadingShare: number; promptTokensOnLoads: number; toolDrops: number; toolsDropped: number; uncachedTokensAfterDrops: number; declaredTokensPerRequest: number };
  replayed: { loadRequests: number; loadRequestShare: number; turnsLoading: number; turnsLoadingShare: number; promptTokensOnLoads: number; toolDrops: number; declaredTokensPerRequest: number; preloadedPerSession: number };
  allToolsTokensPerRequest: number;
  coreTokensPerRequest: number;
}

export function report(sessions: Session[], sizes: Record<string, number>, coreSize: number, allSize: number): LoadReport {
  const tokens = (chars: number) => Math.round(chars / BYTES_PER_TOKEN);
  const turns = sessions.flatMap((s) => s.turns);
  const requests = turns.flatMap((t) => t.requests);
  const wasted = requests.filter((r) => r.wasted);
  const share = (n: number, of: number) => (of ? Number((n / of).toFixed(3)) : 0);

  // The replay: each bot's sessions in the order they began, its usage carried from one to the next.
  let loads = 0, loading = 0, loadPrompt = 0, declared = 0, kept = 0, preloaded = 0;
  for (const bot of new Set(sessions.map((s) => s.bot))) {
    let usage: ToolUsage = {};
    const mine = sessions.filter((s) => s.bot === bot).sort((a, b) => a.start - b.start);
    // Sessions of one bot interleave (a conversation each), so its turns are replayed in time order.
    const have = new Map<Session, Set<string>>();
    const order = mine.flatMap((s) => s.turns.map((turn) => ({ s, turn }))).sort((a, b) => a.turn.at - b.turn.at);
    for (const { s, turn } of order) {
      if (!have.has(s)) {
        const start = new Set(preloadTools(usage, turn.at, sizes));
        have.set(s, start);
        preloaded += start.size;
      }
      const tools = have.get(s)!;
      const missing = [...turn.used].filter((name) => !tools.has(name));
      const size = () => coreSize + [...tools].reduce((n, name) => n + (sizes[name] ?? 0), 0);
      // The requests the turn made for itself, without the ones that only loaded tools.
      const real = turn.requests.filter((r) => !r.wasted);
      if (missing.length) {
        loads++;
        loading++;
        // One request names every tool the turn needs; it costs what the turn's first request did.
        loadPrompt += real[0]?.prompt ?? turn.requests[0]?.prompt ?? 0;
        declared += size();
        kept++;
        for (const name of missing) tools.add(name);
      }
      declared += size() * real.length;
      kept += real.length;
      usage = noteToolUse(usage, turn.used, turn.at);
    }
  }
  const loadingTurns = turns.filter((t) => t.requests.some((r) => r.wasted)).length;
  return {
    sessions: sessions.length,
    bots: new Set(sessions.map((s) => s.bot)).size,
    turns: turns.length,
    requests: requests.length,
    recorded: {
      loadRequests: wasted.length,
      loadRequestShare: share(wasted.length, requests.length),
      turnsLoading: loadingTurns,
      turnsLoadingShare: share(loadingTurns, turns.length),
      promptTokensOnLoads: wasted.reduce((n, r) => n + r.prompt, 0),
      toolDrops: sessions.reduce((n, s) => n + s.drops, 0),
      toolsDropped: sessions.reduce((n, s) => n + s.dropped, 0),
      uncachedTokensAfterDrops: sessions.reduce((n, s) => n + s.uncachedAfterDrop, 0),
      declaredTokensPerRequest: requests.length ? tokens(requests.reduce((n, r) => n + r.declared, 0) / requests.length) : 0,
    },
    replayed: {
      loadRequests: loads,
      loadRequestShare: share(loads, kept),
      turnsLoading: loading,
      turnsLoadingShare: share(loading, turns.length),
      promptTokensOnLoads: loadPrompt,
      toolDrops: 0,
      declaredTokensPerRequest: kept ? tokens(declared / kept) : 0,
      preloadedPerSession: sessions.length ? Number((preloaded / sessions.length).toFixed(2)) : 0,
    },
    allToolsTokensPerRequest: tokens(allSize),
    coreTokensPerRequest: tokens(coreSize),
  };
}

/** The core tools' declarations, and every tool's, in characters. */
export function declaredSizes(): { core: number; all: number } {
  let core = 0, all = 0;
  openbots({
    on() {},
    registerTool(t: { name: string; description: string; parameters: unknown }) {
      const size = JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length;
      all += size;
      if (CORE_TOOLS.includes(t.name)) core += size;
    },
  });
  return { core, all };
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root || root.startsWith("--")) {
    console.error("Usage: bun scripts/bot-tool-loads.ts <copied-session-directory> [--since ISO] [--json]");
    process.exit(1);
  }
  const since = process.argv.includes("--since") ? Date.parse(process.argv[process.argv.indexOf("--since") + 1]!) : 0;
  const sizes = declarationSizes();
  const { core, all } = declaredSizes();
  const sessions: Session[] = [];
  for (const file of walk(root)) {
    const read = readSession(readFileSync(file, "utf8"), sizes, core, since);
    // Pi names a session file <started>_<session id>.jsonl, and a bot's own session id is the bot's.
    if (read?.turns.length) sessions.push({ ...read, bot: file.split("/").pop()!.replace(/\.jsonl$/, "").split("_").pop()! });
  }
  const out = report(sessions, sizes, core, all);
  if (process.argv.includes("--json")) console.log(JSON.stringify(out, null, 1));
  else {
    const n = (value: number) => Math.round(value).toLocaleString("en-US");
    const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
    const rows: [string, string, string][] = [
      ["Requests that only loaded a tool", `${n(out.recorded.loadRequests)} (${pct(out.recorded.loadRequestShare)})`, `${n(out.replayed.loadRequests)} (${pct(out.replayed.loadRequestShare)})`],
      ["Turns that had to load first", `${n(out.recorded.turnsLoading)} (${pct(out.recorded.turnsLoadingShare)})`, `${n(out.replayed.turnsLoading)} (${pct(out.replayed.turnsLoadingShare)})`],
      ["Prompt tokens spent on those requests", n(out.recorded.promptTokensOnLoads), n(out.replayed.promptTokensOnLoads)],
      ["Times a restarted Pi dropped loaded tools", `${n(out.recorded.toolDrops)} (${n(out.recorded.toolsDropped)} tools)`, "0"],
      ["Uncached prompt tokens right after a drop", n(out.recorded.uncachedTokensAfterDrops), "0"],
      ["Tool declarations per request (tokens)", n(out.recorded.declaredTokensPerRequest), n(out.replayed.declaredTokensPerRequest)],
      ["  share of declaring all tools", pct(out.recorded.declaredTokensPerRequest / out.allToolsTokensPerRequest), pct(out.replayed.declaredTokensPerRequest / out.allToolsTokensPerRequest)],
    ];
    console.log(`${n(out.sessions)} sessions of ${n(out.bots)} bots: ${n(out.turns)} turns, ${n(out.requests)} model requests. All tools: ${n(out.allToolsTokensPerRequest)} tokens a request; the core: ${n(out.coreTokensPerRequest)}.`);
    const widths = [0, 1, 2].map((i) => Math.max(...[["", "Recorded", "Replayed"], ...rows].map((r) => r[i]!.length)));
    for (const r of [["", "Recorded", "Replayed"], ...rows]) console.log(r.map((cell, i) => (i ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join("  "));
  }
}
