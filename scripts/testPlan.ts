// Which test files a run covers, and how they're split between CI's parallel jobs (scripts/test.ts).

export type Entry = { file: string; browser: boolean; seconds: number };

// A headless Chrome is a few processes and a renderer: several at once starve each other of frames,
// and the tests that count frames or wait 5 s for one (tests/chromePage.ts) start to fail.
export const usesBrowser = (source: string) => /["'.\/](chromePage|html-render)["']|\bfindBrowser\b/.test(source);

/** A file's expected seconds: measured (scripts/test-timings.json) or, for a file not measured yet, a guess. */
export const expectedSeconds = (file: string, browser: boolean, timings: Record<string, number>) => timings[file] ?? (browser ? 8 : 1);

/** `2/4` → the second of four shards. */
export function parseShard(raw: string) {
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  const index = Number(match?.[1]), total = Number(match?.[2]);
  if (!match || index < 1 || index > total) throw new Error(`--shard takes index/total, such as 2/4, not ${JSON.stringify(raw)}.`);
  return { index, total };
}

/**
 * The files of shard `index` of `total` (from 1). Every file lands in exactly one shard, whatever the
 * order of `entries`. Browser files run one at a time and the others beside them, so each kind is
 * spread on its own: the longest first, each to the shard with the least of that kind so far.
 */
export function shard(entries: Entry[], index: number, total: number): Entry[] {
  const mine: Entry[] = [];
  for (const browser of [true, false]) {
    const load = new Array<number>(total).fill(0);
    const lane = entries.filter(entry => entry.browser === browser)
      .sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    for (const entry of lane) {
      const at = load.indexOf(Math.min(...load));
      load[at]! += entry.seconds;
      if (at === index - 1) mine.push(entry);
    }
  }
  return mine;
}

/** How long a shard should take with two files at a time, one of them a browser's. */
export const expectedWall = (entries: Entry[]) => {
  const sum = (list: Entry[]) => list.reduce((total, entry) => total + entry.seconds, 0);
  return Math.max(sum(entries.filter(entry => entry.browser)), sum(entries) / 2);
};
