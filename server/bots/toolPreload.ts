// Which catalog tools a bot's Pi starts with, besides the core every request declares (extension.ts).
// A bot reaches for the same few tools turn after turn (its coding threads, its apps, its shell), and
// each one it has to load first costs a model request before anything happens. So the tools a bot
// has used lately are declared from the start of each session, most used first, up to a budget that
// keeps most of what loading on demand saves. Everything else still loads by name, and stays loaded.
//
// No database here: the runner keeps each bot's usage (db.toolUsage) and hands it in.
import openbots, { CATALOG_BRIEF, CORE_TOOLS } from "./extension";

/** OpenBots' own tools by name, for what counts them (turnMetrics.ts). */
export const BOT_TOOLS = { core: new Set<string>(CORE_TOOLS), catalog: new Set<string>(Object.keys(CATALOG_BRIEF)) };

/** Per catalog tool, when the bot's recent turns used it: one time per turn, oldest first. */
export type ToolUsage = Record<string, number[]>;

/** How far back a use still counts. */
export const PRELOAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Turns within the window that must have used a tool: once could be a one-off. */
export const PRELOAD_MIN_TURNS = 2;
/**
 * The most the preloaded declarations may add to a request, in characters as bot-prompt-size.ts
 * measures them (about 1,500 tokens): with the core that's under 40% of declaring all the tools.
 */
export const PRELOAD_BUDGET_CHARS = 6400;
/** Uses remembered per tool: enough to rank by, and the record stays small. */
export const USAGE_KEEP = 20;
/**
 * Declared from the start for every bot, whatever it has used: the shell. A third of all turns use
 * it, and it does what a quick task on the bot's computer needs (write a file, read one, run
 * something) in one call. Without it a bot's first such task, and its first in any new session
 * until the shell counted as usual, spent a whole model request on load_tools.
 */
export const STARTER_TOOLS: string[] = ["bash"];

let measured: Record<string, number> | undefined;

/** Each catalog tool's declaration (name, description, schema) in characters, as a request carries it. */
export function declarationSizes(): Record<string, number> {
  if (measured) return measured;
  const sizes: Record<string, number> = {};
  openbots({
    on() {},
    registerTool(t: { name: string; description: string; parameters: unknown }) {
      if (t.name in CATALOG_BRIEF) sizes[t.name] = JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length;
    },
  });
  return (measured = sizes);
}

/** The usage with a turn's tools added: catalog tools only, stale uses dropped, the newest USAGE_KEEP kept. */
export function noteToolUse(usage: ToolUsage | undefined, tools: Iterable<string>, now = Date.now()): ToolUsage {
  const used = new Set([...tools].filter((name) => name in CATALOG_BRIEF));
  const next: ToolUsage = {};
  for (const name of new Set([...Object.keys(usage ?? {}), ...used])) {
    if (!(name in CATALOG_BRIEF)) continue;
    const prior = Array.isArray(usage?.[name]) ? usage![name]! : [];
    const times = [...prior, ...(used.has(name) ? [now] : [])].filter((at) => typeof at === "number" && now - at <= PRELOAD_WINDOW_MS).slice(-USAGE_KEEP);
    if (times.length) next[name] = times;
  }
  return next;
}

/**
 * The tools to declare from the start: used in at least PRELOAD_MIN_TURNS turns of the last week, most
 * used first (the smaller declaration on a tie), each taken while it still fits the budget. A tool
 * too big for what's left is passed over, not a reason to stop: smaller ones behind it may fit.
 */
export function preloadTools(usage: ToolUsage | undefined, now = Date.now(), sizes: Record<string, number> = declarationSizes(), budget = PRELOAD_BUDGET_CHARS): string[] {
  const ranked = Object.entries(usage ?? {})
    .filter(([name]) => name in sizes)
    .map(([name, times]) => ({ name, turns: (Array.isArray(times) ? times : []).filter((at) => now - at <= PRELOAD_WINDOW_MS).length, size: sizes[name]! }))
    .filter((t) => t.turns >= PRELOAD_MIN_TURNS)
    .sort((a, b) => b.turns - a.turns || a.size - b.size || a.name.localeCompare(b.name));
  const picked: string[] = [];
  let left = budget;
  for (const t of ranked) {
    if (t.size > left) continue;
    picked.push(t.name);
    left -= t.size;
  }
  return picked;
}

/** What a bot's Pi declares from the start besides the core: the starter tools, then its usual ones in what's left of the budget. */
export function preloadWithStarter(usage: ToolUsage | undefined, now = Date.now(), sizes: Record<string, number> = declarationSizes(), budget = PRELOAD_BUDGET_CHARS): string[] {
  const starter = STARTER_TOOLS.filter((name) => name in sizes);
  const rest = Object.fromEntries(Object.entries(usage ?? {}).filter(([name]) => !starter.includes(name)));
  return [...starter, ...preloadTools(rest, now, sizes, budget - starter.reduce((n, name) => n + sizes[name]!, 0))];
}
