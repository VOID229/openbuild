import { expect, test } from "bun:test";
import { CATALOG_BRIEF } from "../server/bots/extension";
import { declarationSizes, noteToolUse, PRELOAD_BUDGET_CHARS, PRELOAD_MIN_TURNS, PRELOAD_WINDOW_MS, preloadTools, USAGE_KEEP } from "../server/bots/toolPreload";

const NOW = Date.UTC(2026, 10, 12, 12);
const HOUR = 60 * 60 * 1000;
const times = (n: number, from = NOW - HOUR) => Array.from({ length: n }, (_, i) => from - i * 60_000).reverse();

test("every catalog tool has a measured declaration, and nothing else does", () => {
  const sizes = declarationSizes();
  expect(Object.keys(sizes).sort()).toEqual(Object.keys(CATALOG_BRIEF).sort());
  for (const size of Object.values(sizes)) expect(size).toBeGreaterThan(100);
  // The budget keeps most of what loading on demand saves: under a quarter of the catalog.
  expect(PRELOAD_BUDGET_CHARS).toBeLessThan(Object.values(sizes).reduce((a, b) => a + b, 0) / 4);
});

test("a turn's catalog tools are remembered, once a turn, and old uses fall away", () => {
  let usage = noteToolUse(undefined, ["bash", "bash", "send_message", "load_tools", "made_up"], NOW);
  // Only catalog tools: the core is always declared, and a tool of the user's own isn't ours to preload.
  expect(usage).toEqual({ bash: [NOW] });
  usage = noteToolUse(usage, new Set(["bash", "use_app"]), NOW + 1000);
  expect(usage).toEqual({ bash: [NOW, NOW + 1000], use_app: [NOW + 1000] });
  // A turn that used nothing still ages the record.
  expect(noteToolUse(usage, [], NOW + PRELOAD_WINDOW_MS + 500)).toEqual({ bash: [NOW + 1000], use_app: [NOW + 1000] });
  expect(noteToolUse(usage, [], NOW + PRELOAD_WINDOW_MS + 5000)).toEqual({});
  // Only the newest uses are kept, so the record stays small however busy the bot is.
  let busy: Record<string, number[]> = {};
  for (let i = 0; i < USAGE_KEEP + 15; i++) busy = noteToolUse(busy, ["bash"], NOW + i);
  expect(busy.bash).toHaveLength(USAGE_KEEP);
  expect(busy.bash!.at(-1)).toBe(NOW + USAGE_KEEP + 14);
  // A record that isn't what it should be doesn't break a turn.
  expect(noteToolUse({ bash: "x", teleport: [NOW] } as never, ["read"], NOW)).toEqual({ read: [NOW] });
});

test("a bot starts with the tools it used in two or more recent turns", () => {
  expect(preloadTools(undefined, NOW)).toEqual([]);
  expect(preloadTools({}, NOW)).toEqual([]);
  // Once could be a one-off.
  expect(PRELOAD_MIN_TURNS).toBe(2);
  expect(preloadTools({ bash: times(1) }, NOW)).toEqual([]);
  expect(preloadTools({ bash: times(2), todo: times(1) }, NOW)).toEqual(["bash"]);
  // Most used first.
  expect(preloadTools({ bash: times(3), use_app: times(9), routine: times(2) }, NOW)).toEqual(["use_app", "bash", "routine"]);
  // Uses from more than a week ago don't count.
  expect(preloadTools({ bash: [NOW - PRELOAD_WINDOW_MS - HOUR, NOW - PRELOAD_WINDOW_MS - 2 * HOUR, NOW - HOUR] }, NOW)).toEqual([]);
  expect(preloadTools({ bash: [NOW - PRELOAD_WINDOW_MS - HOUR, NOW - 2 * HOUR, NOW - HOUR] }, NOW)).toEqual(["bash"]);
  // A name that isn't a catalog tool is never preloaded.
  expect(preloadTools({ send_message: times(9), teleport: times(9), bash: times(2) }, NOW)).toEqual(["bash"]);
});

test("preloaded declarations stay within the budget, passing over a tool that doesn't fit", () => {
  const sizes = { big: 4000, medium: 3000, small: 500, tiny: 300 };
  // big fits, medium doesn't (7000 > 6400), small and tiny still do.
  expect(preloadTools({ big: times(9), medium: times(8), small: times(7), tiny: times(6) }, NOW, sizes, 6400)).toEqual(["big", "small", "tiny"]);
  // On a tie the smaller declaration goes first.
  expect(preloadTools({ big: times(4), tiny: times(4), small: times(4) }, NOW, sizes, 1000)).toEqual(["tiny", "small"]);
  expect(preloadTools({ big: times(4) }, NOW, sizes, 100)).toEqual([]);
  // The real catalog: a bot that uses everything still starts within the budget.
  const real = declarationSizes();
  const all = preloadTools(Object.fromEntries(Object.keys(real).map((name) => [name, times(5)])), NOW);
  expect(all.length).toBeGreaterThan(3);
  expect(all.reduce((n, name) => n + real[name]!, 0)).toBeLessThanOrEqual(PRELOAD_BUDGET_CHARS);
  // The primary bot's mix: its coding threads and apps come along, the big manage_bot waits to be asked for.
  const primary = preloadTools({ openbuild: times(20), use_app: times(18), manage_bot: times(6), apps: times(5), bash: times(4) }, NOW);
  expect(primary.slice(0, 2)).toEqual(["openbuild", "use_app"]);
  expect(real.openbuild! + real.manage_bot!).toBeGreaterThan(PRELOAD_BUDGET_CHARS);
  expect(primary).not.toContain("manage_bot");
  expect(primary.reduce((n, name) => n + real[name]!, 0)).toBeLessThanOrEqual(PRELOAD_BUDGET_CHARS);
});
