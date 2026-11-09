// How a bot's eyes follow the pointer: aimed straight at it, quick to lock on with a little snap,
// eased in from rest and eased back home. tests/botsSidebarMascots.test.ts watches it in a real Chrome.
import { expect, test } from "bun:test";
import { aimAt, gazeStep, TRACK_REACH, type Gaze } from "../src/components/bots/BotAvatar";

const rest = (): Gaze => ({ x: 0, y: 0, vx: 0, vy: 0 });
/** Runs the spring at 60fps toward (tx, ty) until it settles: each frame's position, and the frame count. */
function run(g: Gaze, tx: number, ty: number, locking: boolean) {
  const xs: number[] = [];
  for (let i = 0; i < 600; i++) {
    const done = gazeStep(g, tx, ty, 1000 / 60, locking);
    xs.push(g.x);
    if (done) return xs;
  }
  throw new Error("never settled");
}

test("the eyes aim straight at the pointer, and all the way over past the avatar's edge", () => {
  for (const angle of [0, 0.6, 2, -1.2, Math.PI]) {
    const [x, y] = aimAt(Math.cos(angle) * 40, Math.sin(angle) * 40, 28);
    expect(Math.atan2(y / 0.85, x)).toBeCloseTo(angle, 5);
    expect(Math.hypot(x, y / 0.85)).toBeGreaterThan(TRACK_REACH * 0.99);
  }
  expect(aimAt(0, 0, 28)).toEqual([0, 0]);
});

test("they reach well over even close in, and never past their reach", () => {
  // A third of the avatar away, most of the way over already; nearer in, by less.
  expect(aimAt(28 / 3, 0, 28)[0]).toBeGreaterThan(TRACK_REACH * 0.75);
  expect(aimAt(3, 0, 28)[0]).toBeLessThan(aimAt(9, 0, 28)[0]);
  for (let d = 0; d < 400; d += 7) expect(aimAt(d, d, 28)[0]).toBeLessThanOrEqual(TRACK_REACH);
});

test("on hover they lock on quickly, easing in from rest, with only a hint of overshoot", () => {
  const xs = run(rest(), TRACK_REACH, 0, true);
  // Eased in: the first frame moves less than the next.
  expect(xs[0]!).toBeLessThan(xs[1]! - xs[0]!);
  // Most of the way there within ~100ms, settled within ~a third of a second.
  expect(xs[5]!).toBeGreaterThan(TRACK_REACH * 0.8);
  expect(xs.length).toBeLessThan(22);
  const peak = Math.max(...xs);
  expect(peak).toBeGreaterThan(TRACK_REACH);
  expect(peak).toBeLessThan(TRACK_REACH * 1.06);
  expect(xs.at(-1)).toBe(TRACK_REACH);
});

test("off hover they ease back to looking ahead, slower and without overshooting", () => {
  const g: Gaze = { x: TRACK_REACH, y: 4, vx: 0, vy: 0 };
  const xs = run(g, 0, 0, false);
  expect(TRACK_REACH - xs[0]!).toBeLessThan(xs[0]! - xs[1]!);
  for (const x of xs) expect(x).toBeGreaterThanOrEqual(0);
  expect(xs.length).toBeGreaterThan(run(rest(), TRACK_REACH, 0, true).length);
  expect(g).toEqual({ x: 0, y: 0, vx: 0, vy: 0 });
});

test("a long frame doesn't throw the eyes off", () => {
  const g = rest();
  gazeStep(g, TRACK_REACH, 0, 2000, true);
  expect(g.x).toBeGreaterThan(0);
  expect(g.x).toBeLessThan(TRACK_REACH * 1.1);
});
