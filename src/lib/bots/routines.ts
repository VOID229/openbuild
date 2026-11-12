// OpenBots: what a bot does of its own accord. A routine is a few steps one after another: a pose
// held for a while, straight ahead again, a blink, a move or a face. Idle, a bot mostly stares and
// looks around; at work it's brisk, turning, rolling and peering at things. Everything is a turn or a
// lean of the whole body: nothing hops, and nothing spins of its own accord.
import type { Action, Mood } from "./looks";
import type { Pose } from "./rig";

/** One step of a routine, held for its ms: a pose, straight ahead again (null), a blink, a move or a face. */
export type Step = [Pose | null | "blink" | "blink2" | Action | { flash: Mood }, number];

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const side = () => (Math.random() < 0.5 ? -1 : 1);
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
const AHEAD: Pose = { x: 0, y: 0 };

/** A busy bot's routines. Brisk: each look is held just long enough to read as a thought. */
const BEATS: { weight: number; steps: () => Step[] }[] = [
  // A wide stare straight out, rocking from side to side as it works.
  { weight: 4, steps: () => { const s = side(); return [[{ x: 0, y: -0.04, roll: s * 10, eyes: "wide" }, rand(520, 760)], [{ x: 0, y: -0.04, roll: -s * 10, eyes: "wide" }, rand(520, 760)], [{ x: 0, y: 0, roll: s * 5, eyes: "wide" }, 420], [AHEAD, 280]]; } },
  // A hard look off to one side, the whole body rolling into it, and back.
  { weight: 3, steps: () => { const s = side(); return [[{ x: s * rand(0.8, 1), y: rand(-0.4, 0.35), roll: s * rand(12, 22) }, rand(700, 1200)], [AHEAD, rand(300, 520)]]; } },
  // Up and away at something, wide-eyed, the head thrown right back over the other shoulder.
  { weight: 3, steps: () => { const s = side(); return [[{ x: s * rand(0.6, 0.8), y: rand(-0.9, -0.7), roll: -s * rand(22, 30), eyes: "wide" }, rand(800, 1300)], [AHEAD, rand(320, 480)]]; } },
  // Following something along the bottom, eyes wide and low on the face, rolling over as it goes.
  { weight: 3, steps: () => { const s = side(); return [[{ x: -s * 0.75, y: 0.85, roll: -s * rand(16, 22), eyes: "wide" }, rand(600, 800)], [{ x: 0, y: 1, roll: -s * 4, eyes: "wide" }, rand(420, 560)], [{ x: s * 0.7, y: 0.85, roll: s * 6, eyes: "wide" }, rand(600, 800)], [AHEAD, 360]]; } },
  // Working it out: eyes narrowed to dashes, looking up a little, swaying slowly from side to side.
  { weight: 2, steps: () => { const s = side(); return [[{ x: -s * 0.1, y: -0.45, roll: -s * 12, eyes: "squint" }, rand(700, 900)], [{ x: s * 0.15, y: -0.4, roll: s * 14, eyes: "squint" }, rand(800, 1000)], [{ x: 0, y: -0.4, roll: 0, eyes: "squint" }, 420], [AHEAD, 320]]; } },
  // Reading: eyes narrowed, scanning along a line and the next, the head going with them.
  { weight: 3, steps: () => { const s = side(); return [[{ x: -s * 0.9, y: 0.3, eyes: "squint" }, 400], [{ x: -s * 0.3, y: 0.32, eyes: "squint" }, 280], [{ x: s * 0.35, y: 0.32, eyes: "squint" }, 280], [{ x: s * 0.95, y: 0.36, eyes: "squint" }, 460], [AHEAD, 340]]; } },
  // Pondering: up and away, head cocked the other way, eyes narrowed.
  { weight: 3, steps: () => { const s = side(); return [[{ x: s * 0.7, y: -0.9, roll: -s * 13, eyes: "squint" }, rand(900, 1400)], ["blink", 260], [AHEAD, 340]]; } },
  // Curious: rolled right over to one side, eyes wide.
  { weight: 3, steps: () => { const s = side(); return [[{ x: s * 0.3, y: 0.05, roll: s * rand(26, 38), eyes: "wide" }, rand(800, 1300)], ["blink", 260], [AHEAD, 380]]; } },
  // Leaning back from it a touch for a better look, eyes gone round.
  { weight: 1, steps: () => { const s = side(); return [[{ x: s * 0.45, y: 0.3, roll: s * 6, zoom: -0.06, eyes: "round" }, rand(900, 1400)], [{ x: -s * 0.4, y: 0.25, roll: -s * 6, zoom: -0.06, eyes: "round" }, rand(500, 800)], [AHEAD, 380]]; } },
  // Peering at something low, then eyes wide at what it found.
  { weight: 2, steps: () => { const s = side(); return [[{ x: s * 0.4, y: 0.95, eyes: "squint" }, rand(800, 1200)], [{ x: s * 0.4, y: 0.9, zoom: 0.06, eyes: "wide" }, 460], [AHEAD, 340]]; } },
  // Leaning right in, wide-eyed and close.
  { weight: 2, steps: () => [[{ x: 0, y: 0.08, zoom: 0.1, eyes: "wide" }, rand(1000, 1700)], ["blink", 260], [AHEAD, 300]] },
  // Mulling it over: a look down and a nod or two.
  { weight: 2, steps: () => [[{ x: 0, y: 0.95 }, 300], [{ x: 0, y: 0.15 }, 240], [{ x: 0, y: 0.8 }, 260], [AHEAD, 340]] },
  // A double take.
  { weight: 2, steps: () => { const s = side(); return [[{ x: s * 0.85, y: 0 }, 260], [AHEAD, 220], [{ x: s, y: -0.1, roll: s * 16, eyes: "wide" }, 900], [AHEAD, 360]]; } },
  // A bright idea: straight at you, eyes wide, with a little swell.
  { weight: 1, steps: () => [[{ x: 0, y: -0.2, eyes: "wide" }, 260], ["pop", 520], [{ x: 0, y: 0, eyes: "wide" }, 420], [AHEAD, 260]] },
  // Now and then, a little move.
  { weight: 1, steps: () => [[AHEAD, 200], [pick(["wiggle", "nod"] as const), 700]] },
];
const beatTotal = BEATS.reduce((n, b) => n + b.weight, 0);
export function nextBeat(): Step[] {
  let r = Math.random() * beatTotal;
  for (const b of BEATS) if ((r -= b.weight) < 0) return b.steps();
  return BEATS[0]!.steps();
}

/**
 * An idle bot's routines, with a rest looking straight out between them: mostly staring and looking
 * around, the odd blink, and for lively ones a small move or a face. `looks` marks the ones that take
 * the eyes off ahead, which a bot following the pointer skips: it's looking at the pointer.
 */
const IDLE: { weight: number; looks?: true; lively?: true; steps: () => Step[] }[] = [
  // A blink, now and then twice.
  { weight: 3, steps: () => [[Math.random() < 0.15 ? "blink2" : "blink", 300]] },
  // A stare: straight out, leaning in a touch, eyes wider, held without a blink.
  { weight: 3, looks: true, steps: () => [[{ x: 0, y: -0.05, zoom: 0.035, eyes: "wide" }, rand(1600, 3000)], [AHEAD, 200]] },
  // A look off somewhere, the whole body turning and leaning into it, and back.
  { weight: 3, looks: true, steps: () => [[{ x: side() * rand(0.55, 1), y: rand(-0.6, 0.45) }, rand(800, 1600)], [AHEAD, 300]] },
  // A long look up and away, the head rolled right back, held as if lost in it.
  { weight: 2, looks: true, steps: () => { const s = side(); return [[{ x: s * rand(0.55, 0.8), y: rand(-0.85, -0.6), roll: -s * rand(18, 28) }, rand(1800, 3200)], [AHEAD, 340]]; } },
  // Looking around: a few looks this way and that, then straight out again.
  {
    weight: 3,
    looks: true,
    steps: () => {
      let s = side();
      const looks = Array.from({ length: 2 + Math.floor(Math.random() * 3) }, (): Step => [{ x: (s = -s) * rand(0.5, 1), y: rand(-0.55, 0.4) }, rand(420, 950)]);
      return [...looks, [AHEAD, 300]];
    },
  },
  // Head cocked over to one side at something, and back.
  { weight: 2, looks: true, steps: () => { const s = side(); return [[{ x: s * 0.25, y: -0.1, roll: s * rand(14, 22) }, rand(900, 1700)], [AHEAD, 320]]; } },
  // A small move, or a face pulled.
  { weight: 1, lively: true, steps: () => [[pick(["nod", "nod", "pop", "wiggle"] as const), 700]] },
  { weight: 1, lively: true, steps: () => [[{ flash: pick(["happy", "wink", "surprised", "squint"] as const) }, 1200]] },
];
export function nextIdle(lively: boolean, tracking = false): Step[] {
  const open = IDLE.filter((b) => (lively || !b.lively) && (!tracking || !b.looks));
  let r = Math.random() * open.reduce((n, b) => n + b.weight, 0);
  for (const b of open) if ((r -= b.weight) < 0) return b.steps();
  return open[0]!.steps();
}

/** Thinking (while typing): looking up a little, head cocked, its eyes narrowed to dashes (in CSS). */
export const THINKING: Pose = { x: 0.12, y: -0.5, roll: -10 };
