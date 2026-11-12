// OpenBots' bots: a shape and a colour with two big, deep eyes. Left alone they breathe, stare
// straight out, blink and look around, the head and body turning after the eyes; the bigger ones now
// and then nod, wiggle or squish. Eyes can follow the pointer, the whole body leaning after them; a
// held mood (thinking while typing, happy at a reaction) changes their expression, and in a group the
// ones not at work doze, a "zzz" floating up over them. Nothing ever hops: they stay on the ground.
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { colorOf, shapeOf, type Action, type BotLook, type Mood, type Shape } from "../../lib/bots/looks";
import { cx } from "../../lib/ui";

export type { Action, Mood };

const calm = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

// One pointer listener for every avatar whose eyes follow it, batched to a frame. Where the pointer
// is stays known between followers, so eyes that start following look the right way at once.
const followers = new Set<() => void>();
const pointer = { x: -1, y: -1, frame: 0, watching: false };
function onPointerMove(e: PointerEvent) {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  if (!followers.size) return;
  pointer.frame ||= requestAnimationFrame(() => {
    pointer.frame = 0;
    for (const f of followers) f();
  });
}
function follow(fn: () => void) {
  if (!pointer.watching) {
    pointer.watching = true;
    window.addEventListener("pointermove", onPointerMove, { passive: true });
  }
  followers.add(fn);
  if (pointer.x >= 0) fn();
  return () => void followers.delete(fn);
}

/**
 * Off screen (scrolled away, in a hidden pane, skipped by content-visibility, or in a hidden tab), a
 * routine waits rather than spend frames there. Checked once a step: an IntersectionObserver would
 * have Chrome restyle every frame of the breathing, which otherwise runs on the compositor.
 */
function offScreen(el: Element) {
  if (document.hidden) return true;
  if (typeof el.checkVisibility === "function" && !el.checkVisibility({ contentVisibilityAuto: true })) return true;
  const r = el.getBoundingClientRect();
  return !r.width || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth;
}

/** An open eye's size in the 100-unit box, before the shape's own scale: tall and deep. */
export const EYE_W = 8.6;
export const EYE_H = 18.4;
/** Drawn a touch bigger than the shapes' own numbers, so they still read on a 28px avatar. */
export const EYE_BOOST = 1.12;

/** How far the eyes travel when looking, in the 100-unit box. */
const REACH = 5.5;
/** Further when following the pointer, which they do only while it's on their row. */
export const TRACK_REACH = 11;

/**
 * Where eyes following the pointer aim, the pointer (dx, dy) from between them on an avatar `width`
 * across: straight at it, most of the way over within a few eye-widths and all of it by the edge
 * (`reach` of it, on a shape with less room).
 */
export function aimAt(dx: number, dy: number, width: number, reach = 1): [number, number] {
  const dist = Math.hypot(dx, dy);
  if (!dist || !width) return [0, 0];
  const k = Math.tanh(dist / (width * 0.3)) * reach * TRACK_REACH;
  return [(dx / dist) * k, (dy / dist) * 0.85 * k];
}

export type Spring = { stiffness: number; damping: number };
/** The eyes' springs: quick onto the pointer with a hint of overshoot, unhurried and flat back home. */
export const EYES: [lock: Spring, back: Spring] = [{ stiffness: 38, damping: 0.72 }, { stiffness: 20, damping: 1 }];
/** The body's: it turns and leans after the eyes, slower and heavier, swaying a little past and back. */
export const BODY: [lock: Spring, back: Spring] = [{ stiffness: 15, damping: 0.6 }, { stiffness: 11, damping: 0.9 }];
export type Gaze = { x: number; y: number; vx: number; vy: number };

/**
 * Moves the eyes (or, with BODY, the body) `dt` ms along a spring toward (tx, ty). Starting from rest
 * they ease in rather than jump, and they settle onto it (true once there, so the frames can stop).
 */
export function gazeStep(g: Gaze, tx: number, ty: number, dt: number, locking: boolean, springs = EYES): boolean {
  const { stiffness: w, damping: z } = springs[locking ? 0 : 1];
  // A long frame (a busy main thread, a hidden tab) is taken in short steps, so the spring stays stable.
  for (let left = Math.min(dt, 100) / 1000; left > 0; left -= 1 / 240) {
    const h = Math.min(left, 1 / 240);
    g.vx += (w * w * (tx - g.x) - 2 * z * w * g.vx) * h;
    g.vy += (w * w * (ty - g.y) - 2 * z * w * g.vy) * h;
    g.x += g.vx * h;
    g.y += g.vy * h;
  }
  if (Math.hypot(tx - g.x, ty - g.y) > 0.02 || Math.hypot(g.vx, g.vy) > 0.2) return false;
  Object.assign(g, { x: tx, y: ty, vx: 0, vy: 0 });
  return true;
}

/**
 * Where a bot faces (-1…1 each way, x right and y down), how it tilts, and how open its eyes are. The
 * eyes get there first, in a quick flick; the head and then the body follow (see .bot-look in bots.css).
 */
type Pose = { x: number; y: number; tilt?: number; eyes?: "wide" | "squint" };
/** One step of a routine, held for its ms: a pose, straight ahead again (null), a blink, a move or a face. */
export type Step = [Pose | null | "blink" | "blink2" | Action | { flash: Mood }, number];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const side = () => (Math.random() < 0.5 ? -1 : 1);
const AHEAD: Pose = { x: 0, y: 0 };

/**
 * A busy bot's routines: poses one after another, plus a blink or a move along the way. Brisk: the
 * eyes flick, the head snaps after them, and a look is held just long enough to read as a thought.
 * The moves stay on the ground: never a hop, and never a spin.
 */
const BEATS: { weight: number; steps: (lively: boolean) => Step[] }[] = [
  // A sharp look off to one side, held, and back.
  { weight: 4, steps: () => { const s = side(); return [[{ x: s * rand(0.7, 1), y: rand(-0.35, 0.35) }, rand(700, 1300)], [AHEAD, rand(300, 600)]]; } },
  // Scanning across, like reading: the eyes jump along, the head following.
  { weight: 3, steps: () => { const s = side(); return [[{ x: -s * 0.85, y: 0.3, eyes: "squint" }, 420], [{ x: -s * 0.3, y: 0.32, eyes: "squint" }, 300], [{ x: s * 0.3, y: 0.3, eyes: "squint" }, 300], [{ x: s * 0.9, y: 0.34, eyes: "squint" }, 480], [AHEAD, 360]]; } },
  // Pondering: up and away, eyes narrowed, head cocked.
  { weight: 3, steps: () => { const s = side(); return [[{ x: s * 0.75, y: -0.85, tilt: s * 10, eyes: "squint" }, rand(900, 1500)], ["blink", 260], [AHEAD, 360]]; } },
  // Curious: a sharp head tilt toward something, eyes wide.
  { weight: 3, steps: () => { const s = side(); return [[{ x: s * 0.55, y: 0.1, tilt: s * -16, eyes: "wide" }, rand(800, 1300)], ["blink", 260], [AHEAD, 360]]; } },
  // Peering at something low, then eyes wide at what it found.
  { weight: 2, steps: () => { const s = side(); return [[{ x: s * 0.4, y: 0.9, eyes: "squint" }, rand(900, 1400)], [{ x: s * 0.4, y: 0.9, eyes: "wide" }, 420], [AHEAD, 360]]; } },
  // A stare straight out, wide and unblinking.
  { weight: 3, steps: () => [[{ x: 0, y: -0.05, eyes: "wide" }, rand(1100, 1900)], [AHEAD, 300]] },
  // Mulling it over: a look down and a quick nod.
  { weight: 2, steps: () => [[{ x: 0, y: 0.6, eyes: "squint" }, 420], ["nod", 640], [AHEAD, 360]] },
  // A double take.
  { weight: 2, steps: () => { const s = side(); return [[{ x: s * 0.9, y: 0 }, 260], [AHEAD, 240], [{ x: s, y: -0.1, eyes: "wide" }, 900], [AHEAD, 360]]; } },
  // A bright idea: straight at you, eyes wide, with a squish.
  { weight: 1, steps: () => [[{ x: 0, y: -0.2, eyes: "wide" }, 260], ["squish", 560], [{ x: 0, y: 0, eyes: "wide" }, 420], [AHEAD, 260]] },
  // Now and then, a little move.
  { weight: 1, steps: () => [[AHEAD, 200], [pick(["wiggle", "squish"] as const), 700]] },
];
const beatTotal = BEATS.reduce((n, b) => n + b.weight, 0);
export function nextBeat(lively = false): Step[] {
  let r = Math.random() * beatTotal;
  for (const b of BEATS) if ((r -= b.weight) < 0) return b.steps(lively);
  return BEATS[0]!.steps(lively);
}

/**
 * An idle bot's routines, with a rest looking straight out between them: mostly staring and looking
 * around, the odd blink, and for lively ones a small move or a face. `looks` marks the ones that take
 * the eyes off ahead, which a bot following the pointer skips: its eyes are on the pointer.
 */
const IDLE: { weight: number; looks?: true; lively?: true; steps: () => Step[] }[] = [
  // A blink, now and then twice.
  { weight: 3, steps: () => [[Math.random() < 0.15 ? "blink2" : "blink", 300]] },
  // A stare: straight out, eyes a touch wider, held without a blink.
  { weight: 3, looks: true, steps: () => [[{ x: 0, y: -0.05, eyes: "wide" }, rand(1600, 3000)], [AHEAD, 200]] },
  // A look off somewhere, the head and body turning after the eyes, and back.
  { weight: 4, looks: true, steps: () => [[{ x: side() * rand(0.5, 1), y: rand(-0.6, 0.45) }, rand(700, 1500)], [AHEAD, 300]] },
  // Looking around: a few quick looks this way and that, then straight out again.
  {
    weight: 3,
    looks: true,
    steps: () => {
      let s = side();
      const looks = Array.from({ length: 2 + Math.floor(Math.random() * 3) }, (): Step => [{ x: (s = -s) * rand(0.45, 1), y: rand(-0.55, 0.4) }, rand(380, 900)]);
      return [...looks, [AHEAD, 300]];
    },
  },
  // A small move, or a face pulled.
  { weight: 1, lively: true, steps: () => [[pick(["nod", "nod", "squish", "wiggle"] as const), 700]] },
  { weight: 1, lively: true, steps: () => [[{ flash: pick(["happy", "wink", "surprised", "squint"] as const) }, 1200]] },
];
export function nextIdle(lively: boolean, tracking = false): Step[] {
  const open = IDLE.filter((b) => (lively || !b.lively) && (!tracking || !b.looks));
  let r = Math.random() * open.reduce((n, b) => n + b.weight, 0);
  for (const b of open) if ((r -= b.weight) < 0) return b.steps();
  return open[0]!.steps();
}

/** Thinking (while typing): looking up and off to one side, head cocked, one eye narrowed. */
const THINKING: Pose = { x: 0.5, y: -0.75, tilt: 7 };

function Eye({ mood, x, scale, side, lid }: { mood: Mood; x: number; scale: number; side: "left" | "right"; lid: boolean }) {
  const s = scale;
  const ew = EYE_W * s;
  const eh = EYE_H * s;
  const r = ew / 2;
  const top = -eh / 2;
  // Shut, drawn as a stroke: a lid's curve, sagging a little.
  const shut = (sag: number, w = 4.6) => <path className="bot-eye-line" d={`M${-r - 0.2 * s} ${0.6 * s}Q0 ${sag * s} ${r + 0.2 * s} ${0.6 * s}`} strokeWidth={w * s} />;
  let eye: React.ReactNode;
  if (mood === "sleepy") eye = shut(3.6, 4.4);
  else if (mood === "wink" && side === "left") eye = shut(4.4, 5);
  else if (mood === "happy" || mood === "wink") {
    // Smiling: still open and solid, the cheeks pushing the lower lid up into a gentle curve.
    // Its lower corners softened (.bot-eye-smile), so it stays an eye and never comes to a point.
    const bottom = top + eh * 0.7;
    const lift = ew * 0.22;
    eye = <path className="bot-eye-fill bot-eye-smile" d={`M${-r} ${bottom}V${top + r}A${r} ${r} 0 0 1 ${r} ${top + r}V${bottom}C${r * 0.45} ${bottom - lift} ${-r * 0.45} ${bottom - lift} ${-r} ${bottom}Z`} strokeWidth={1.4 * s} />;
  } else if (mood === "love")
    eye = <path className="bot-eye-fill" d={`M0 ${5.6 * s}C${-10 * s} ${-1.1 * s} ${-4.5 * s} ${-9 * s} 0 ${-3.4 * s}C${4.5 * s} ${-9 * s} ${10 * s} ${-1.1 * s} 0 ${5.6 * s}Z`} />;
  else {
    // Open: a tall pill, or rounder and bigger still in surprise.
    const w = mood === "surprised" ? ew * 1.25 : ew;
    const h = mood === "surprised" ? eh * 0.8 : eh;
    eye = <rect className="bot-eye-fill" x={-w / 2} y={-h / 2} width={w} height={h} rx={w / 2} />;
  }
  return (
    <g transform={`translate(${x} 0) rotate(-9)`}>
      <g className={`bot-eye-side bot-eye-${side}`}>
        {/* Keyed by mood, so a new expression pops in rather than swapping flat (bot-eye-in). */}
        <g key={mood} className={cx("bot-eye", mood === "squint" && "bot-eye-squint", mood === "thinking" && side === "left" && "bot-eye-squint")}>{eye}</g>
        {/* Shut, for dozing: the open eye fades into it, so nodding off and waking are eased both ways. */}
        {lid && <path className="bot-eye-line bot-lid" d={`M${-r} ${1.6 * s}Q0 ${5.2 * s} ${r} ${1.6 * s}`} strokeWidth={4.2 * s} />}
      </g>
    </g>
  );
}

function Body({ shape, color, clip }: { shape: Shape; color: string; clip: string }) {
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <path d={shape.path} />
        </clipPath>
        {/* The eyes' fill: near-black at the top, lifting a little toward the bottom, so they read deep. */}
        <linearGradient id={`${clip}-eye`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="bot-eye-stop-top" />
          <stop offset="1" className="bot-eye-stop-bottom" />
        </linearGradient>
      </defs>
      <path className="bot-shape" d={shape.path} fill={color} />
      {/* A soft light from the upper left and a little shade underneath, inside the outline. */}
      <g clipPath={`url(#${clip})`} className="bot-shading">
        {/* Moved inside the clip, so the light can slide as the bot turns without dragging the clip along:
            once as the pointer steers it, once as a pose turns it. */}
        <g className="bot-steer-light">
          <g className="bot-light">
            <ellipse cx="34" cy="24" rx="30" ry="20" fill="#fff" opacity="0.16" />
            <ellipse cx="62" cy="96" rx="46" ry="22" fill="#000" opacity="0.1" />
          </g>
        </g>
      </g>
      {shape.extra && <path d={shape.extra.path} fill={shape.extra.fill} />}
    </>
  );
}

export interface BotAvatarProps {
  look: BotLook;
  size: number;
  /** A held expression, e.g. thinking while the bot types. */
  mood?: Mood;
  /** Breathe, blink, stare and look around on its own. */
  alive?: boolean;
  /** Also nod, wiggle and pull faces now and then (the bigger avatars). */
  lively?: boolean;
  /** Eyes follow the pointer, and the body turns and leans after them. */
  track?: boolean;
  /** Nod and smile on hover, spin when pressed. */
  playful?: boolean;
  /** Busy at something: fidgets much more often, looking about and pulling faces. */
  busy?: boolean;
  /**
   * Dozing, as a group's members do while they aren't at work: eyes shut, head down, breathing slowly
   * if it's alive. Set (true or false) on any avatar that can doze, so it eases in and out of it.
   */
  asleep?: boolean;
  /** A little "zzz" floats up while it dozes. Only the sidebars turn it on: beside chat messages the shut eyes say enough. */
  zzz?: boolean;
  /** Change it to make the bot react once: a squish and a happy face, or the given mood and move. */
  pulse?: { key: string | number; mood?: Mood; action?: Action };
  className?: string;
  label?: string;
}

export const BotAvatar = memo(function BotAvatar({ look, size, mood = "idle", alive = true, lively = false, track = false, playful = false, busy = false, asleep, zzz = false, pulse, className, label }: BotAvatarProps) {
  const [pose, setPose] = useState<Pose>();
  const shape = shapeOf(look);
  const color = colorOf(look);
  const clip = useId().replace(/:/g, "");
  const ref = useRef<HTMLSpanElement>(null);
  /** How long the lids take to close, a little different every blink; unset when they're open. */
  const [blink, setBlink] = useState<number>();
  const [action, setAction] = useState<Action>();
  const [flash, setFlash] = useState<Mood>();
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  };
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // Lids snap down, held a moment, and up a touch slower (see .bot-eye): never the same blink twice.
  const doBlink = (twice = false) => {
    const close = Math.round(rand(70, 110));
    setBlink(close);
    later(() => setBlink(undefined), close + rand(30, 80));
    if (twice) later(() => doBlink(), rand(260, 360));
  };
  const doAction = (a: Action) => {
    if (calm()) return;
    setAction(undefined);
    requestAnimationFrame(() => setAction(a));
    later(() => setAction((cur) => (cur === a ? undefined : cur)), 1000);
  };
  const doFlash = (m: Mood, ms = 1000) => {
    setFlash(m);
    later(() => setFlash((cur) => (cur === m ? undefined : cur)), ms);
  };

  // A life of its own, one routine after another: busy, brisk poses and faces with blinks between;
  // idle, a rest staring straight out and then a stare, a look around, a blink or (lively) a move.
  // Dozing, there's none of it: just the breathing, in CSS.
  const dozing = !!asleep && !busy;
  useEffect(() => {
    const el = ref.current;
    if (!(alive || busy) || dozing || !el || calm()) return;
    let timer: ReturnType<typeof setTimeout>;
    let steps: Step[] = [];
    const step = () => {
      if (offScreen(el)) {
        timer = setTimeout(step, 2000);
        return;
      }
      if (!steps.length)
        steps = busy ? (Math.random() < 0.25 ? [["blink", rand(500, 900)], ...nextBeat(lively)] : nextBeat(lively)) : [[null, rand(800, 2600)], ...nextIdle(lively, track)];
      const [what, ms] = steps.shift()!;
      if (what === null) setPose(undefined);
      else if (what === "blink" || what === "blink2") doBlink(what === "blink2");
      else if (typeof what === "string") doAction(what);
      else if ("flash" in what) doFlash(what.flash, ms);
      else setPose(what);
      timer = setTimeout(step, ms);
    };
    timer = setTimeout(step, busy ? 200 : rand(300, 1500));
    return () => {
      clearTimeout(timer);
      setPose(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alive, busy, lively, track, dozing]);

  // Woken to work, it has a little stretch on the way up.
  const wasDozing = useRef(dozing);
  useEffect(() => {
    if (wasDozing.current && !dozing) doAction("stretch");
    wasDozing.current = dozing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dozing]);

  // Eyes that follow the pointer, and the body after them, written straight to the element so moving
  // the mouse doesn't render. Aimed from the eyes themselves (shapes carry their faces off-centre),
  // sprung onto the pointer on hover and back to looking ahead after, frame by frame: the eyes on a
  // quick spring (--track-*), the body turning and leaning on a slower, heavier one (--steer-*).
  // Where they are carries over, so hovering again on the way back picks up from there. A pose (a
  // look, a stare, a thought: data-looking) wins: they let go.
  const { x: faceX, y: faceY, reach = 1 } = shape.face;
  const gaze = useRef({ g: { x: 0, y: 0, vx: 0, vy: 0 } as Gaze, b: { x: 0, y: 0, vx: 0, vy: 0 } as Gaze, on: false, frame: 0, last: 0 });
  const kick = useRef(() => {});
  kick.current = () => {
    const el = ref.current;
    const s = gaze.current;
    if (!el || s.frame) return;
    const tick = (now: number) => {
      s.frame = 0;
      const dt = s.last ? now - s.last : 16;
      s.last = now;
      let tx = 0;
      let ty = 0;
      const r = el.getBoundingClientRect();
      if (s.on && r.width && !("looking" in el.dataset) && pointer.x >= 0)
        [tx, ty] = aimAt(pointer.x - (r.left + (faceX / 100) * r.width), pointer.y - (r.top + (faceY / 100) * r.height), r.width, reach);
      const eyes = gazeStep(s.g, tx, ty, dt, s.on);
      const done = gazeStep(s.b, tx, ty, dt, s.on, BODY) && eyes;
      if (done && !s.on) {
        for (const p of ["--track-x", "--track-y", "--steer-x", "--steer-y", "--steer-a"]) el.style.removeProperty(p);
        delete el.dataset.steering;
      } else {
        el.dataset.steering = "";
        el.style.setProperty("--track-x", s.g.x.toFixed(2));
        el.style.setProperty("--track-y", s.g.y.toFixed(2));
        el.style.setProperty("--steer-x", (s.b.x / TRACK_REACH).toFixed(3));
        el.style.setProperty("--steer-y", (s.b.y / TRACK_REACH).toFixed(3));
        el.style.setProperty("--steer-a", Math.min(1, Math.abs(s.b.x / TRACK_REACH)).toFixed(3));
      }
      if (done) s.last = 0;
      else s.frame = requestAnimationFrame(tick);
    };
    s.frame = requestAnimationFrame(tick);
  };
  useEffect(() => {
    const el = ref.current;
    if (!track || !el || calm()) return;
    const s = gaze.current;
    el.dataset.tracking = "";
    s.on = true;
    const stop = follow(() => kick.current());
    kick.current();
    return () => {
      stop();
      delete el.dataset.tracking;
      s.on = false;
      kick.current();
    };
  }, [track, faceX, faceY, reach]);
  useEffect(() => () => cancelAnimationFrame(gaze.current.frame), []);

  const pulseKey = pulse?.key;
  const lastPulse = useRef(pulseKey);
  useLayoutEffect(() => {
    if (pulseKey === undefined || pulseKey === lastPulse.current) return;
    lastPulse.current = pulseKey;
    doAction(pulse?.action ?? "squish");
    doFlash(pulse?.mood ?? "happy", 1300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulseKey]);

  const shown = flash ?? mood;
  // A reaction stirs a dozing bot for as long as its face shows, then it drifts off again.
  const sleeping = dozing && !flash;
  const held = pose ?? (shown === "thinking" ? THINKING : undefined);
  // Following eyes let go of the pointer for a pose or thought, and take it up again after.
  const looking = !!held;
  useEffect(() => {
    if (gaze.current.on) kick.current();
  }, [looking]);
  // Where it faces: the eyes (--look-*), the head after them and the body last (--turn-*), leaning
  // into it unless the pose cocks the head its own way.
  const turn: Record<string, string | number> = held
    ? { "--look-x": held.x * REACH, "--look-y": held.y * REACH * 0.8, "--turn-x": held.x, "--turn-y": held.y, "--turn-a": Math.abs(held.x), "--tilt": `${held.tilt ?? held.x * 5}deg` }
    : {};
  const { face } = shape;
  const eyeScale = (face.scale ?? 1) * EYE_BOOST;
  const gap = face.gap * 1.1;
  return (
    <span
      ref={ref}
      className={cx("bot", alive && "bot-alive", playful && "bot-playful", className)}
      data-color={color.id}
      data-mood={shown}
      data-blink={blink ? "" : undefined}
      data-action={action}
      data-looking={held ? "" : undefined}
      data-busy={busy || undefined}
      data-asleep={sleeping ? "" : undefined}
      data-eyes={flash ? undefined : pose?.eyes}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size, "--bob-delay": `${-(clip.charCodeAt(clip.length - 2) % 9) * 1.3}s`, "--eye-fill": `url(#bot${clip}-eye)`, ...(blink ? { "--blink": `${blink}ms` } : {}), ...turn } as React.CSSProperties}
      onPointerEnter={playful ? () => { doAction("nod"); doFlash("happy", 1100); } : undefined}
      onPointerDown={playful ? () => doAction("spin") : undefined}
      onAnimationEnd={(e) => {
        if ((e.target as Element).classList.contains("bot-act")) setAction(undefined);
      }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} overflow="visible">
        <g className="bot-act">
          {/* Leaning after the pointer (--steer-*), then turned and tilted by a pose (--turn-*). */}
          <g className="bot-steer">
            <g className="bot-tilt">
              <g className="bot-turn">
                <Body shape={shape} color={color.hex} clip={`bot${clip}`} />
              </g>
              <g className="bot-face" transform={`translate(${face.x} ${face.y})`}>
                <g className="bot-head">
                  <g className="bot-steer-face">
                    <g className="bot-look">
                      <g className="bot-track">
                        <Eye mood={shown} x={-gap / 2} scale={eyeScale} side="left" lid={asleep !== undefined} />
                        <Eye mood={shown} x={gap / 2} scale={eyeScale} side="right" lid={asleep !== undefined} />
                      </g>
                    </g>
                  </g>
                </g>
              </g>
            </g>
          </g>
        </g>
      </svg>
      {asleep !== undefined && zzz && <Zzz size={size} />}
    </span>
  );
});

/** Sized from the avatar's, within a narrow range: still letters at the sidebar's 28px, and never loud on the big ones. */
const zzzSize = (size: number) => Math.round(Math.min(11, Math.max(8, size * 0.18)));

/** The "zzz" over a dozing bot or huddle: shown, and floating up a letter at a time, only while it dozes (see .bot-zzz). */
function Zzz({ size }: { size: number }) {
  return (
    <span className="bot-zzz" style={{ fontSize: zzzSize(size) }} aria-hidden>
      {/* The letters are drawn by CSS, so they stay out of the row's text. */}
      <span data-z="z" />
      <span data-z="z" />
      <span data-z="Z" />
    </span>
  );
}

/** Below this size a seat in the huddle is too small for a readable count, so it goes beside it. */
export const HUDDLE_SEAT_MIN = 32;

/**
 * A group's avatar: its members huddled together (up to four), and the rest as a count that never
 * sits over one of them. Big enough, the count takes the last seat of the huddle, so the avatar keeps
 * its box and lines up with the others; smaller, it follows the huddle as a number. The user can sit
 * in the huddle too, as their profile picture. `active` picks, by member, who is at work: those come
 * alive and fidget, and the rest doze (breathing, unless `alive` is false). Without it, every member
 * is awake and `alive` and `busy` go for all of them.
 */
export const BotHuddle = memo(function BotHuddle({ looks, size, alive = true, busy, active, track, me, zzz = false }: { looks: BotLook[]; size: number; alive?: boolean; busy?: boolean; active?: boolean[]; track?: boolean; me?: React.ReactNode; zzz?: boolean }) {
  const seats = me ? 3 : 4;
  const over = looks.length > seats;
  const seated = over && size >= HUDDLE_SEAT_MIN;
  // Who sits in it: those at work first, so a busy member is never one of the count, and then in the
  // group's own order, so they keep their places.
  const room = seated ? seats - 1 : seats;
  const order = looks.map((_, i) => i);
  const members = (active ? [...order.filter((i) => active[i]), ...order.filter((i) => !active[i])] : order).slice(0, room).sort((a, b) => a - b);
  const extra = looks.length - members.length;
  const count = members.length + (me ? 1 : 0) + (seated ? 1 : 0);
  // Where each member sits, as fractions of the box (centre x, centre y, size): a 2×2 grid filled as
  // far as the shapes allow, three as two over one, a pair on the diagonal. The count's seat is the
  // last one of the grid.
  const spots: [number, number, number][][] = [
    [],
    [[0.5, 0.5, 0.9]],
    [[0.32, 0.35, 0.6], [0.68, 0.65, 0.6]],
    [[0.28, 0.29, 0.5], [0.72, 0.29, 0.5], [0.5, 0.72, 0.5]],
    [[0.28, 0.28, 0.5], [0.72, 0.28, 0.5], [0.28, 0.72, 0.5], [0.72, 0.72, 0.5]],
  ];
  const layout = spots[Math.min(count, 4)] ?? [];
  const items: [React.Key, React.ReactNode][] = [];
  if (me) items.push(["me", me]);
  members.forEach((i, n) => {
    const s = layout[n + (me ? 1 : 0)]?.[2] ?? 0.5;
    items.push([i, <BotAvatar look={looks[i]!} size={Math.round(size * s)} alive={active ? active[i] || alive : alive} busy={active ? active[i] : busy} asleep={active && !active[i]} track={track} />]);
  });
  // One "zzz" for the huddle, over its corner, rather than one each on members too small to read it.
  const dozing = !!active && members.some((i) => !active[i]);
  // Hanging from the top corner, its lowest letter (1.95em down, and floating 0.2em more) would reach
  // the count's seat below in a small huddle: there it hangs that much higher.
  const z = zzzSize(size);
  const zzzTop = seated && active && zzz ? Math.min(-0.1 * z, 0.54 * size - 2.15 * z) : undefined;
  const label = `+${extra}`;
  const spot = ([x, y, s]: [number, number, number]) => ({ left: `${(x - s / 2) * 100}%`, top: `${(y - s / 2) * 100}%`, width: `${s * 100}%`, height: `${s * 100}%` });
  return (
    <span className="bot-huddle" data-more={over ? (seated ? "seat" : "beside") : undefined} aria-hidden>
      <span className="bot-huddle-box" style={{ width: size, height: size, ...(zzzTop !== undefined && { "--zzz-top": `${zzzTop.toFixed(1)}px` }) } as React.CSSProperties} data-dozing={dozing ? "" : undefined}>
        {items.map(([key, item], i) => {
          const [x, y, s] = layout[i] ?? [0.5, 0.5, 0.5];
          // Dozing, heads lean in toward the middle of the huddle.
          const lean = Math.abs(x - 0.5) < 0.1 ? 0 : x < 0.5 ? 5 : -5;
          return (
            <span key={key} className="bot-huddle-spot" style={{ ...spot([x, y, s]), "--lean": `${lean}deg` } as React.CSSProperties}>
              {item}
            </span>
          );
        })}
        {seated && (
          <span className="bot-huddle-spot bot-huddle-seat" style={{ ...spot(layout[3]!), "--more-font": `${Math.max(9, Math.round(size * (label.length > 2 ? 0.19 : 0.23)))}px` } as React.CSSProperties}>
            <span className="bot-huddle-more">{label}</span>
          </span>
        )}
        {active && zzz && <Zzz size={size} />}
      </span>
      {over && !seated && <span className="bot-huddle-more" style={{ "--more-font": `${Math.max(10, Math.round(size * 0.55))}px` } as React.CSSProperties}>{label}</span>}
    </span>
  );
});

/**
 * A group's members side by side, each its own mascot, for where a huddle would be too small to read
 * (the chat's header at rest). Up to `max` show, those at work first as in a huddle, and the rest as a
 * count after them ("+2" after four). `active` picks who is at work, as in BotHuddle; the rest doze, without a "zzz" each.
 */
export const BotLineup = memo(function BotLineup({ looks, size, alive = true, busy, active, track, max = 4 }: { looks: BotLook[]; size: number; alive?: boolean; busy?: boolean; active?: boolean[]; track?: boolean; max?: number }) {
  const room = max;
  const order = looks.map((_, i) => i);
  const members = (active ? [...order.filter((i) => active[i]), ...order.filter((i) => !active[i])] : order).slice(0, room).sort((a, b) => a - b);
  const extra = looks.length - members.length;
  return (
    <span className="bot-lineup" aria-hidden>
      {members.map((i) => (
        <BotAvatar key={i} look={looks[i]!} size={size} alive={active ? active[i] || alive : alive} busy={active ? active[i] : busy} asleep={active && !active[i]} zzz={false} track={track} />
      ))}
      {extra > 0 && <span className="bot-lineup-more">+{extra}</span>}
    </span>
  );
});

/** OpenBots' icon for the sidebar: a puff outline with two eyes, in the text colour like the other icons. */
export function BotsGlyph({ size = 18, className }: { size?: number; className?: string; "aria-hidden"?: boolean }) {
  return (
    <svg className={cx("bots-glyph", className)} viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <path
        d="M7.2 19.5c-2.6 0-4.5-1.9-4.5-4.3 0-1.7 1-3.1 2.4-3.8-.1-.3-.1-.6-.1-.9 0-2.4 2-4.3 4.4-4.3.7 0 1.3.2 1.9.4C12.1 5.1 13.6 4.2 15.3 4.2c2.7 0 4.9 2.1 4.9 4.8 0 .4 0 .7-.1 1.1 1.2.8 1.9 2.1 1.9 3.6 0 3.2-2.6 5.8-5.8 5.8H7.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <g className="bots-glyph-eyes" fill="currentColor">
        <rect x="10.6" y="10.2" width="2" height="4.4" rx="1" transform="rotate(-9 11.6 12.4)" />
        <rect x="14.6" y="10.2" width="2" height="4.4" rx="1" transform="rotate(-9 15.6 12.4)" />
      </g>
    </svg>
  );
}
