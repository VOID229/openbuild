// What a bot does of its own accord, sampled many times: unhurried, never a spin, and a hop only
// for the bigger, lively avatars. tests/botMascots.test.ts watches the same in a real Chrome.
import { expect, test } from "bun:test";
import { nextBeat, nextIdle } from "../src/components/bots/BotAvatar";

const RUNS = 5000;
const moves = (lively: boolean) => {
  const seen = new Set<string>();
  for (let i = 0; i < RUNS; i++) for (const [what] of nextBeat(lively)) if (typeof what === "string" && what !== "blink") seen.add(what);
  return seen;
};

test("at work, a bot never spins, and only a lively one hops", () => {
  expect([...moves(false)].sort()).toEqual(["nod", "squish", "wiggle"]);
  const lively = moves(true);
  expect(lively.has("spin")).toBe(false);
  expect(lively.has("hop")).toBe(true);
});

test("at work, every pose is held long enough to read", () => {
  for (let i = 0; i < RUNS; i++)
    for (const [what, ms] of nextBeat(true)) expect(ms).toBeGreaterThanOrEqual(typeof what === "object" ? 200 : 260);
});

test("idle, a bot mostly blinks and glances, seldom twice in a row, and never spins", () => {
  let blinks = 0;
  let doubles = 0;
  const actions = new Set<string>();
  for (let i = 0; i < RUNS; i++) {
    const quiet = nextIdle(false);
    expect("action" in quiet || "flash" in quiet).toBe(false);
    const what = nextIdle(true);
    if ("blink" in what) {
      blinks++;
      if (what.blink) doubles++;
    }
    if ("action" in what) actions.add(what.action);
  }
  expect(blinks / RUNS).toBeGreaterThan(0.4);
  expect(doubles / blinks).toBeLessThan(0.2);
  expect(actions.has("spin")).toBe(false);
  expect(actions.has("nod")).toBe(true);
});
