// What a bot does of its own accord, sampled many times: brisk, always on the ground (never a hop
// or a spin), and idle, mostly staring and looking around. tests/botMascots.test.ts watches the same
// in a real Chrome.
import { expect, test } from "bun:test";
import { nextBeat, nextIdle, type Step } from "../src/components/bots/BotAvatar";

const RUNS = 5000;
const sample = (fn: () => Step[]) => Array.from({ length: RUNS }, fn);
const poseOf = (what: Step[0]) => (what !== null && typeof what === "object" && "x" in what ? what : undefined);
/** The moves in some routines: everything named that isn't a blink. */
const moves = (routines: Step[][]) => new Set(routines.flatMap((r) => r.map(([what]) => what)).filter((w): w is Extract<Step[0], string> => typeof w === "string" && !w.startsWith("blink")));
const faces = (routines: Step[][]) => routines.flatMap((r) => r.map(([what]) => what)).filter((w) => w !== null && typeof w === "object" && "flash" in w);

test("at work, a bot never hops or spins, lively or not", () => {
  for (const lively of [false, true]) expect([...moves(sample(() => nextBeat(lively)))].sort()).toEqual(["nod", "squish", "wiggle"]);
});

test("at work, it's brisk, but every pose is held long enough to read", () => {
  const routines = sample(() => nextBeat(true));
  for (const r of routines) for (const [what, ms] of r) expect(ms).toBeGreaterThanOrEqual(poseOf(what) ? 200 : 260);
  // A whole routine is over within a few seconds.
  expect(Math.max(...routines.map((r) => r.reduce((n, [, ms]) => n + ms, 0)))).toBeLessThan(3200);
});

test("idle, a bot mostly stares and looks around, with the odd blink", () => {
  let stares = 0;
  let looks = 0;
  let blinks = 0;
  for (const r of sample(() => nextIdle(false))) {
    const poses = r.map(([what, ms]) => [poseOf(what), ms] as const).filter(([p]) => p);
    if (poses.some(([p, ms]) => p!.x === 0 && p!.eyes === "wide" && ms >= 1500)) stares++;
    else if (poses.some(([p]) => p!.x !== 0)) looks++;
    else if (r.some(([what]) => what === "blink" || what === "blink2")) blinks++;
    // Every look ends back straight ahead.
    if (poses.length) expect(poses.at(-1)![0]).toEqual({ x: 0, y: 0 });
  }
  expect((stares + looks) / RUNS).toBeGreaterThan(0.6);
  expect(stares / RUNS).toBeGreaterThan(0.15);
  expect(blinks / RUNS).toBeGreaterThan(0.1);
  expect(stares + looks + blinks).toBe(RUNS);
});

test("idle, only a lively bot moves or pulls a face, and never a hop or a spin", () => {
  const quiet = sample(() => nextIdle(false));
  expect(moves(quiet).size).toBe(0);
  expect(faces(quiet).length).toBe(0);
  const lively = sample(() => nextIdle(true));
  expect([...moves(lively)].sort()).toEqual(["nod", "squish", "wiggle"]);
  expect(faces(lively).length).toBeGreaterThan(0);
});

test("idle and following the pointer, a bot never takes its eyes off it", () => {
  for (const r of sample(() => nextIdle(true, true))) for (const [what] of r) expect(poseOf(what)).toBeUndefined();
});
