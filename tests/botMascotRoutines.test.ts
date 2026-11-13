// What a bot does of its own accord, sampled many times: brisk at work, always in place (never a hop
// or a spin), and idle, mostly staring and looking around. tests/botMascots.test.ts watches the same
// in a real Chrome.
import { expect, test } from "bun:test";
import { nextBeat, nextBlink, nextIdle, type Step } from "../src/lib/bots/routines";

const RUNS = 5000;
const sample = (fn: () => Step[]) => Array.from({ length: RUNS }, fn);
const poseOf = (what: Step[0]) => (what !== null && typeof what === "object" && "x" in what ? what : undefined);
/** The moves in some routines: everything named that isn't a blink. */
const moves = (routines: Step[][]) => new Set(routines.flatMap((r) => r.map(([what]) => what)).filter((w): w is Extract<Step[0], string> => typeof w === "string" && !w.startsWith("blink")));
const faces = (routines: Step[][]) => routines.flatMap((r) => r.map(([what]) => what)).filter((w) => w !== null && typeof w === "object" && "flash" in w);
const poses = (routines: Step[][]) => routines.flatMap((r) => r.map(([what]) => poseOf(what)).filter((p) => !!p));

test("at work, a bot never hops or spins", () => {
  expect([...moves(sample(nextBeat))].sort()).toEqual(["nod", "pop", "wiggle"]);
});

test("at work, it's brisk, but every pose is held long enough to read", () => {
  const routines = sample(nextBeat);
  for (const r of routines) for (const [what, ms] of r) expect(ms).toBeGreaterThanOrEqual(poseOf(what) ? 200 : 260);
  // A whole routine is over within a few seconds.
  expect(Math.max(...routines.map((r) => r.reduce((n, [, ms]) => n + ms, 0)))).toBeLessThan(3200);
});

test("at work, the whole body is in it: it turns, rolls right over, leans in and back, and stares", () => {
  const all = poses(sample(nextBeat));
  // Looking hard to both sides, and up and down.
  expect(Math.max(...all.map((p) => p.x))).toBeGreaterThan(0.9);
  expect(Math.min(...all.map((p) => p.x))).toBeLessThan(-0.9);
  expect(Math.max(...all.map((p) => p.y))).toBeGreaterThan(0.8);
  expect(Math.min(...all.map((p) => p.y))).toBeLessThan(-0.8);
  // Rolled well over, both ways; leaning in and leaning back.
  expect(Math.max(...all.map((p) => p.roll ?? 0))).toBeGreaterThan(25);
  expect(Math.min(...all.map((p) => p.roll ?? 0))).toBeLessThan(-25);
  expect(Math.max(...all.map((p) => p.zoom ?? 0))).toBeGreaterThan(0.05);
  expect(Math.min(...all.map((p) => p.zoom ?? 0))).toBeLessThan(-0.04);
  // More staring, wide-eyed, than squinting.
  const wide = all.filter((p) => p.eyes === "wide").length;
  expect(wide / all.length).toBeGreaterThan(0.2);
  expect(wide).toBeGreaterThan(all.filter((p) => p.eyes === "squint").length);
  // Every routine ends back straight ahead.
  for (const r of sample(nextBeat)) {
    const last = r.map(([what]) => poseOf(what)).filter((p) => !!p).at(-1);
    if (last) expect(last).toEqual({ x: 0, y: 0 });
  }
});

test("idle, a bot mostly stares and looks around, with the odd blink", () => {
  let stares = 0;
  let looks = 0;
  let blinks = 0;
  for (const r of sample(() => nextIdle(false))) {
    const held = r.map(([what, ms]) => [poseOf(what), ms] as const).filter(([p]) => p);
    if (held.some(([p, ms]) => p!.x === 0 && p!.eyes === "wide" && ms >= 1500)) stares++;
    else if (held.some(([p]) => p!.x !== 0)) looks++;
    else if (r.some(([what]) => what === "blink" || what === "blink2")) blinks++;
    // Every look ends back straight ahead.
    if (held.length) expect(held.at(-1)![0]).toEqual({ x: 0, y: 0 });
  }
  expect((stares + looks) / RUNS).toBeGreaterThan(0.6);
  expect(stares / RUNS).toBeGreaterThan(0.15);
  expect(blinks / RUNS).toBeGreaterThan(0.1);
  expect(stares + looks + blinks).toBe(RUNS);
});

test("idle, it never squints: its eyes are open, or wider", () => {
  for (const p of poses(sample(() => nextIdle(false)))) expect(p.eyes ?? "wide").toBe("wide");
});

test("idle, only a lively bot moves or pulls a face, and never a hop or a spin", () => {
  const quiet = sample(() => nextIdle(false));
  expect(moves(quiet).size).toBe(0);
  expect(faces(quiet).length).toBe(0);
  const lively = sample(() => nextIdle(true));
  expect([...moves(lively)].sort()).toEqual(["nod", "pop", "wiggle"]);
  expect(faces(lively).length).toBeGreaterThan(0);
});

test("idle and following the pointer, a bot never takes its eyes off it", () => {
  for (const r of sample(() => nextIdle(true, true))) for (const [what] of r) expect(poseOf(what)).toBeUndefined();
});

test("plain, a bot only blinks: its eyes held open a natural while between, and no look, move or face", () => {
  const plain = sample(nextBlink);
  expect(moves(plain).size).toBe(0);
  expect(faces(plain).length).toBe(0);
  expect(poses(plain).length).toBe(0);
  for (const r of plain) {
    expect(r.map(([what]) => what)).toEqual([null, expect.stringMatching(/^blink2?$/)]);
    expect(r[0]![1]).toBeGreaterThanOrEqual(2000);
    expect(r[0]![1]).toBeLessThanOrEqual(5000);
  }
});
