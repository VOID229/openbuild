// OpenBots: what a bot does of its own accord. At work it plays clips: short choreographed runs of
// looks, each pose held a moment, as the reference recording of Grok Bot's mascots does: a look
// round that ends in a backflip, a sway from side to side looking down, a curious spell with round
// eyes, and a breather back at rest. Every clip is the same each time it plays, as the reference's
// are; which one comes next is chosen at random, never the same twice running. Idle, a bot mostly rests,
// with a blink or a calm look about now and then. Nothing hops: a bot moves by turning, rolling and
// leaning, and at work, now and then, by going right round (a flip or a spin).
import type { Action, Mood } from "./looks";
import { RESTING, type Pose } from "./rig";

/**
 * One step of a routine, held for its ms: a pose, back to rest (null), a blink, a move, a face, or a
 * sweep (the pose it looks toward moving steadily there over the ms, from wherever it was). A step of
 * 0 ms happens with the next one.
 */
export type Step = [Pose | null | "blink" | "blink2" | Action | { flash: Mood } | { sweep: Pose }, number];

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const side = () => (Math.random() < 0.5 ? -1 : 1);
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
/** Straight ahead: at work, with the big eyes. (A getter, so that no two steps share a pose to be changed under them.) */
const ahead = (): Pose => ({ x: 0, y: 0 });

/**
 * The clips a bot at work plays, each the reference's own: its poses (where the eyes land, measured
 * off the recording and fitted to our rig) and how long each is held, move included.
 */
export const CLIPS = {
  /**
   * A look round: left, up and left (blinking on the way), a long look over to the right, up, and down,
   * then a backflip, the face going up over the top and coming back up from below.
   */
  lookFlip: (): Step[] => [
    [{ x: -0.48, y: -0.28, roll: 11 }, 500],
    ["blink", 0],
    [{ x: -0.62, y: -0.57, roll: 14 }, 620],
    [{ x: 0.27, y: -0.5, roll: -5 }, 1080],
    [{ x: 0.03, y: -0.79, roll: 0 }, 420],
    [{ x: 0, y: 0.72 }, 430],
    [ahead(), 0],
    ["flip", 700],
    [ahead(), 900],
  ],
  /**
   * Looking down, rolled right over to one side, then sweeping slowly across to the other, rolling
   * over the other way, and quickly back: three times, a little slower each time.
   */
  sway: (): Step[] => {
    const left: Pose = { x: -0.21, y: 0.82, roll: 33 };
    const right: Pose = { x: 0.3, y: 0.95, roll: -30 };
    return [[left, 850], [{ sweep: right }, 750], [right, 300], [left, 450], [{ sweep: right }, 900], [right, 250], [left, 650], [{ sweep: right }, 1000], [right, 300], [ahead(), 400]];
  },
  /**
   * Curious: eyes gone to round dots, it leans right back away from something up and to the left, one
   * eye bigger than the other, then looks over the other way, comes back in big-eyed, spins right round
   * and settles small-eyed.
   */
  curious: (): Step[] => [
    [ahead(), 500],
    [{ x: 0, y: 0, eyes: "dot" }, 1000],
    [{ x: -0.71, y: -0.2, roll: 20, zoom: -0.27, eyes: "dot", near: 0.17 }, 1250],
    [{ x: 0.35, y: -0.16, roll: -20, zoom: -0.1, eyes: "dot", near: 0.15 }, 800],
    [{ x: 0.43, y: -0.18, roll: -23 }, 1000],
    ["spin", 450],
    [{ x: 0.21, y: 0, eyes: "open" }, 900],
    [ahead(), 800],
  ],
  /** Glancing off small-eyed, then at something to the left with round eyes, one bigger, and back. */
  glance: (): Step[] => [
    [{ x: 0.44, y: -0.1, eyes: "open" }, 700],
    [{ x: -0.63, y: -0.3, roll: 10, eyes: "dot", near: 0.18 }, 1060],
    [{ x: 0, y: 0, eyes: "open" }, 650],
    [ahead(), 600],
  ],
  /**
   * A breather: back at rest a moment, small-eyed, then a look to the left, up, and round about with
   * the big eyes again, and straight ahead.
   */
  breather: (): Step[] => [
    [{ ...RESTING, eyes: "open" }, 1200],
    [{ x: -0.75, y: -0.13, roll: 3, eyes: "open" }, 770],
    [{ x: -0.23, y: -1, roll: -20, zoom: 0.04, eyes: "open" }, 560],
    [{ x: 0, y: -1, roll: -7, zoom: 0.02 }, 670],
    [{ x: -0.5, y: -0.65, roll: 8 }, 500],
    [{ x: 0.32, y: -0.39, roll: -18 }, 430],
    [ahead(), 1170],
  ],
} satisfies Record<string, () => Step[]>;
export type Clip = keyof typeof CLIPS;

/** How often each clip comes up at work: the look round most, as in the reference. */
const WEIGHTS: Record<Clip, number> = { lookFlip: 4, sway: 2, curious: 1, glance: 1, breather: 2 };

/** A busy bot's next clip, never the one it just played. */
export function nextClip(last?: Clip): Clip {
  const open = (Object.keys(WEIGHTS) as Clip[]).filter((c) => c !== last);
  let r = Math.random() * open.reduce((n, c) => n + WEIGHTS[c], 0);
  for (const c of open) if ((r -= WEIGHTS[c]) < 0) return c;
  return open[0]!;
}

/** A busy bot's routine, one clip after another: each call plays the next one (and remembers it). */
export function beats() {
  let last: Clip | undefined;
  return (): Step[] => CLIPS[(last = nextClip(last))]();
}
/** One clip at random, for whoever doesn't keep track. */
export const nextBeat = (): Step[] => CLIPS[nextClip()]();

/**
 * Coming back from three dots, as in the reference: round-eyed straight out, leaning right back for a
 * look up and to the left, small-eyed for a moment, and big-eyed into the work.
 */
export const AFTER_DOTS: Step[] = [
  [{ x: 0, y: 0, eyes: "dot" }, 750],
  [{ x: -0.71, y: -0.2, roll: 20, zoom: -0.27, eyes: "dot", near: 0.17 }, 850],
  [{ x: 0.05, y: -0.6, roll: -15, eyes: "open" }, 420],
  [ahead(), 900],
];

/**
 * An idle bot's routines, with a rest between them: mostly just resting, the odd blink, now and then
 * a calm look about with its small eyes, and for lively ones a face. `looks` marks the ones that take
 * the eyes off ahead, which a bot following the pointer skips: it's looking at the pointer.
 */
const IDLE: { weight: number; looks?: true; lively?: true; steps: () => Step[] }[] = [
  // A blink, now and then twice.
  { weight: 4, steps: () => [[Math.random() < 0.15 ? "blink2" : "blink", 300]] },
  // Turning to look straight out a while, and back to rest.
  { weight: 2, looks: true, steps: () => [[{ x: 0, y: 0, eyes: "open" }, rand(1400, 2600)], [null, 300]] },
  // A look off to one side, then the other, and back to rest.
  { weight: 2, looks: true, steps: () => { const s = side(); return [[{ x: s * rand(0.5, 0.8), y: rand(-0.3, 0.1), eyes: "open" }, rand(700, 1200)], [{ x: -s * rand(0.4, 0.7), y: rand(-0.3, 0.1), eyes: "open" }, rand(700, 1100)], [null, 300]]; } },
  // A look up and away, the head cocked, held as if lost in it.
  { weight: 1, looks: true, steps: () => { const s = side(); return [[{ x: s * rand(0.3, 0.6), y: rand(-0.9, -0.6), roll: -s * rand(10, 20), eyes: "open" }, rand(1200, 2200)], [null, 300]]; } },
  // A face pulled.
  { weight: 1, lively: true, steps: () => [[{ flash: pick(["happy", "wink", "surprised"] as const) }, 1200]] },
];
export function nextIdle(lively: boolean, tracking = false): Step[] {
  const open = IDLE.filter((b) => (lively || !b.lively) && (!tracking || !b.looks));
  let r = Math.random() * open.reduce((n, b) => n + b.weight, 0);
  for (const b of open) if ((r -= b.weight) < 0) return [[null, rand(2400, 5200)], ...b.steps()];
  return [[null, rand(2400, 5200)], ...open[0]!.steps()];
}

/**
 * A plain bot's only routine: its eyes held open a natural while, then a blink (now and then two).
 * Nothing else: no look, stare, move or face, so it stays just itself, blinking.
 */
export function nextBlink(): Step[] {
  return [[null, rand(2000, 5000)], [Math.random() < 0.12 ? "blink2" : "blink", 300]];
}

/** Thinking (while typing): looking up a little, head cocked, its eyes narrowed to dashes (in CSS). */
export const THINKING: Pose = { x: 0.12, y: -0.5, roll: -10 };

/**
 * Reading, as the reference reads: wide oval eyes darting about the page, a quick look down, up to
 * the top left and across, then back to the left of a line and slowly along it to the right, and
 * quickly back. Each `at` is when a look starts, in ms into the page; a sweep moves steadily from the
 * look before it to its own over `sweep` ms. The page then starts again.
 */
export const READING_PAGE: { at: number; pose: Pose; sweep?: number }[] = [
  { at: 0, pose: { x: -0.8, y: -0.15 } },
  { at: 450, pose: { x: -0.43, y: 0.89, roll: 2 } },
  { at: 920, pose: { x: -0.36, y: -0.89, roll: -8 } },
  { at: 1920, pose: { x: 0.24, y: -0.92, roll: 6 } },
  { at: 2570, pose: { x: -0.86, y: 0.17 } },
  { at: 4150, pose: { x: 0.68, y: 0.12 }, sweep: 1150 },
  { at: 4590, pose: { x: -0.71, y: 0.14 } },
];
/** How long a page of reading takes, ms, before it starts again. */
export const READING_MS = 5300;

/** Where a reading bot looks `ms` into its reading. */
export function readingAt(ms: number): Pose {
  const t = ((ms % READING_MS) + READING_MS) % READING_MS;
  let i = 0;
  while (i + 1 < READING_PAGE.length && READING_PAGE[i + 1]!.at <= t) i++;
  const next = READING_PAGE[i + 1];
  const here = READING_PAGE[i]!;
  // On its way along a line: steadily from where it was to where the sweep ends.
  if (next?.sweep && t > next.at - next.sweep) {
    const k = (t - (next.at - next.sweep)) / next.sweep;
    const [a, b] = [here.pose, next.pose];
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * k, eyes: "read" };
  }
  return { roll: 0, ...here.pose, eyes: "read" };
}

/** Reading with motion reduced: held still, eyes on the line it starts along. */
export const READING_STILL: Pose = { x: 0, y: 0.15, roll: 0, eyes: "read" };
