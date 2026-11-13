// CI splits the suite between parallel jobs (scripts/test.ts --shard): a file that fell between the
// shards would silently stop being tested, and lopsided shards make every pull request wait.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectedSeconds, expectedWall, parseShard, shard, usesBrowser, type Entry } from "../scripts/testPlan";

const root = join(import.meta.dir, "..");
const timings: Record<string, number> = JSON.parse(readFileSync(join(root, "scripts/test-timings.json"), "utf8"));
const suite: Entry[] = [...new Bun.Glob("tests/**/*.test.ts").scanSync(root)].map(file => {
  const browser = usesBrowser(readFileSync(join(root, file), "utf8"));
  return { file, browser, seconds: expectedSeconds(file, browser, timings) };
});

test("every test file runs in exactly one shard, whatever order the files are found in", () => {
  for (const total of [1, 2, 4, 5, 7]) {
    const shards = Array.from({ length: total }, (_, i) => shard(suite, i + 1, total).map(entry => entry.file));
    expect(shards.flat().sort()).toEqual(suite.map(entry => entry.file).sort());
    const reversed = Array.from({ length: total }, (_, i) => shard([...suite].reverse(), i + 1, total).map(entry => entry.file));
    expect(reversed.map(files => files.sort())).toEqual(shards.map(files => files.sort()));
  }
});

test("CI's shards take about as long as each other", () => {
  const walls = [1, 2, 3, 4, 5].map(index => expectedWall(shard(suite, index, 5)));
  expect(Math.max(...walls) - Math.min(...walls)).toBeLessThan(20);
});

test("browser files are told apart, and a file not timed yet still counts", () => {
  expect(usesBrowser(`import { launchChrome } from "./chromePage";`)).toBe(true);
  expect(usesBrowser(`import { findBrowser } from "../server/pi/extensions/html-render";`)).toBe(true);
  expect(usesBrowser(`import { expect } from "bun:test";`)).toBe(false);
  expect(expectedSeconds("tests/new.test.ts", true, {})).toBeGreaterThan(expectedSeconds("tests/new.test.ts", false, {}));
  expect(expectedSeconds("tests/new.test.ts", false, { "tests/new.test.ts": 12 })).toBe(12);
});

test("the timings name files that exist", () => {
  const files = new Set(suite.map(entry => entry.file));
  expect(Object.keys(timings).filter(file => !files.has(file))).toEqual([]);
});

test("--shard takes index/total and nothing else", () => {
  expect(parseShard("2/4")).toEqual({ index: 2, total: 4 });
  for (const bad of ["", "0/4", "5/4", "2", "a/b", "1/0"]) expect(() => parseShard(bad)).toThrow("--shard takes index/total");
});
