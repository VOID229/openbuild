// OpenBots' bots: a shape and a colour with two little eyes. Left alone they breathe, blink and
// glance about; the bigger ones now and then nod, wiggle or squish. Eyes can follow the pointer, a
// held mood (thinking while typing, happy at a reaction) changes their expression, and in a group the
// ones not at work doze, a "zzz" floating up over them.
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

/** How far the eyes travel when looking, in the 100-unit box. */
const REACH = 5;
/** Further when following the pointer, which they do only while it's on their row. */
const TRACK_REACH = 8;

/** Where a busy bot faces (-1…1 each way, x right and y down), how it tilts, and how open its eyes are. */
type Pose = { x: number; y: number; tilt?: number; eyes?: "wide" | "squint" };
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const side = () => (Math.random() < 0.5 ? -1 : 1);

/**
 * A busy bot's little routines: poses held for a while, one after another. Each beat is a list of
 * [pose, ms] steps, plus optionally a blink or a move along the way. Unhurried: a pose is held long
 * enough to read as a thought, and the moves are small ones: never a spin, and a hop only for the
 * bigger, lively avatars.
 */
const BEATS: { weight: number; steps: (lively: boolean) => [Pose | "blink" | Action, number][] }[] = [
  // A look off to one side, then back.
  { weight: 4, steps: () => { const s = side(); return [[{ x: s * rand(0.6, 1), y: rand(-0.3, 0.3) }, rand(1400, 2400)], [{ x: 0, y: 0 }, rand(500, 900)]]; } },
  // Scanning across, like reading.
  { weight: 3, steps: () => { const s = side(); return [[{ x: -s * 0.8, y: 0.3, eyes: "squint" }, 750], [{ x: -s * 0.25, y: 0.35, eyes: "squint" }, 560], [{ x: s * 0.35, y: 0.3, eyes: "squint" }, 560], [{ x: s * 0.9, y: 0.35, eyes: "squint" }, 850], [{ x: 0, y: 0 }, 600]]; } },
  // Pondering: up and away, eyes narrowed, head tilted.
  { weight: 3, steps: () => { const s = side(); return [[{ x: s * 0.7, y: -0.8, tilt: s * 8, eyes: "squint" }, rand(1800, 2700)], ["blink", 320], [{ x: 0, y: 0 }, 600]]; } },
  // Curious: a head tilt toward something, eyes wide.
  { weight: 3, steps: () => { const s = side(); return [[{ x: s * 0.5, y: 0.1, tilt: s * -14, eyes: "wide" }, rand(1500, 2200)], ["blink", 320], [{ x: 0, y: 0 }, 600]]; } },
  // Peering closely at something low.
  { weight: 2, steps: () => { const s = side(); return [[{ x: s * 0.35, y: 0.85, eyes: "squint" }, rand(1600, 2300)], [{ x: s * 0.35, y: 0.85, eyes: "wide" }, 700], [{ x: 0, y: 0 }, 600]]; } },
  // Mulling it over: a look down and a slow nod.
  { weight: 2, steps: () => [[{ x: 0, y: 0.55, eyes: "squint" }, 700], ["nod", 1100], [{ x: 0, y: 0 }, 600]] },
  // A double take.
  { weight: 1, steps: () => { const s = side(); return [[{ x: s * 0.9, y: 0 }, 450], [{ x: 0, y: 0 }, 450], [{ x: s, y: -0.1, eyes: "wide" }, 1300], [{ x: 0, y: 0 }, 600]]; } },
  // A bright idea: straight at you, eyes wide, a small hop (or a squish, where hopping would be a lot).
  { weight: 1, steps: (lively) => [[{ x: 0, y: -0.15, eyes: "wide" }, 260], [lively ? "hop" : "squish", 950], [{ x: 0, y: 0, eyes: "wide" }, 700], [{ x: 0, y: 0 }, 400]] },
  // Now and then, a little move.
  { weight: 1, steps: () => [[{ x: 0, y: 0 }, 200], [pick(["wiggle", "squish"] as const), 1200]] },
];
const beatTotal = BEATS.reduce((n, b) => n + b.weight, 0);
export function nextBeat(lively = false) {
  let r = Math.random() * beatTotal;
  for (const b of BEATS) if ((r -= b.weight) < 0) return b.steps(lively);
  return BEATS[0]!.steps(lively);
}

/** What an idle bot does next: mostly blink or glance, and for lively ones the odd small move or face. */
export function nextIdle(lively: boolean): { blink: boolean } | { glance: true } | { action: Action } | { flash: Mood } {
  const r = Math.random();
  if (r < 0.5) return { blink: Math.random() < 0.12 };
  if (r < 0.82) return { glance: true };
  if (lively && r < 0.93) return { action: pick(["nod", "nod", "squish", "wiggle", "hop"] as const) };
  if (lively) return { flash: pick(["happy", "wink", "squint"] as const) };
  return { blink: false };
}

function Eye({ mood, x, scale, glint, side, lid }: { mood: Mood; x: number; scale: number; glint: boolean; side: "left" | "right"; lid: boolean }) {
  const s = scale;
  // Expressions drawn as strokes: arcs for happy and wink, a droopy line for sleepy.
  const stroke = (d: string) => <path className="bot-eye-line" d={d} strokeWidth={4.4 * s} />;
  let eye: React.ReactNode;
  if (mood === "happy" || (mood === "wink" && side === "left")) eye = stroke(`M${-4.2 * s} ${2 * s}Q0 ${-5.5 * s} ${4.2 * s} ${2 * s}`);
  else if (mood === "sleepy") eye = stroke(`M${-4 * s} 0Q0 ${3.2 * s} ${4 * s} 0`);
  else if (mood === "love")
    eye = <path className="bot-eye-fill" d={`M0 ${5 * s}C${-9 * s} ${-1 * s} ${-4 * s} ${-8 * s} 0 ${-3 * s}C${4 * s} ${-8 * s} ${9 * s} ${-1 * s} 0 ${5 * s}Z`} />;
  else {
    const surprised = mood === "surprised";
    const ew = (surprised ? 9.5 : 7.5) * s;
    const eh = (surprised ? 11.5 : 16) * s;
    eye = (
      <>
        <rect className="bot-eye-fill" x={-ew / 2} y={-eh / 2} width={ew} height={eh} rx={ew / 2} />
        {glint && <circle className="bot-glint" cx={1.1 * s} cy={-eh / 2 + 3.4 * s} r={1.35 * s} />}
      </>
    );
  }
  return (
    <g transform={`translate(${x} 0) rotate(-9)`}>
      <g className={`bot-eye-side bot-eye-${side}`}>
      <g className={cx("bot-eye", mood === "squint" && "bot-eye-squint", mood === "thinking" && side === "left" && "bot-eye-squint")}>{eye}</g>
      {/* Shut, for dozing: the open eye fades into it, so nodding off and waking are eased both ways. */}
      {lid && <path className="bot-eye-line bot-lid" d={`M${-4.3 * s} ${1.6 * s}Q0 ${5 * s} ${4.3 * s} ${1.6 * s}`} strokeWidth={4 * s} />}
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
      </defs>
      <path className="bot-shape" d={shape.path} fill={color} />
      {/* A soft light from the upper left and a little shade underneath, inside the outline. */}
      <g clipPath={`url(#${clip})`} className="bot-shading">
        {/* Moved inside the clip, so the light can slide as the bot turns without dragging the clip along. */}
        <g className="bot-light">
          <ellipse cx="34" cy="24" rx="30" ry="20" fill="#fff" opacity="0.16" />
          <ellipse cx="62" cy="96" rx="46" ry="22" fill="#000" opacity="0.1" />
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
  /** Breathe, blink and glance on its own. */
  alive?: boolean;
  /** Also nod, wiggle and pull faces now and then, and hop when busy (the bigger avatars). */
  lively?: boolean;
  /** Eyes follow the pointer. */
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
  /** A little "zzz" floats up while it dozes. Off where something around it shows one instead (a huddle). */
  zzz?: boolean;
  /** Change it to make the bot react once: a hop and a happy face, or the given mood. */
  pulse?: { key: string | number; mood?: Mood; action?: Action };
  className?: string;
  label?: string;
}

export const BotAvatar = memo(function BotAvatar({ look, size, mood = "idle", alive = true, lively = false, track = false, playful = false, busy = false, asleep, zzz = true, pulse, className, label }: BotAvatarProps) {
  const [pose, setPose] = useState<Pose>();
  const shape = shapeOf(look);
  const color = colorOf(look);
  const clip = useId().replace(/:/g, "");
  const ref = useRef<HTMLSpanElement>(null);
  /** How long the lids take to close, a little different every blink; unset when they're open. */
  const [blink, setBlink] = useState<number>();
  const [glance, setGlance] = useState<[number, number]>();
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

  // Lids down, held a moment, and up a touch slower (see .bot-eye): never the same blink twice.
  const doBlink = (twice = false) => {
    const close = Math.round(rand(110, 170));
    setBlink(close);
    later(() => setBlink(undefined), close + rand(50, 130));
    if (twice) later(() => doBlink(), rand(420, 560));
  };
  const doAction = (a: Action) => {
    if (calm()) return;
    setAction(undefined);
    requestAnimationFrame(() => setAction(a));
    later(() => setAction((cur) => (cur === a ? undefined : cur)), 1400);
  };
  const doFlash = (m: Mood, ms = 1000) => {
    setFlash(m);
    later(() => setFlash((cur) => (cur === m ? undefined : cur)), ms);
  };

  // Busy: one small routine after another, looking about and pulling faces, with blinks between.
  useEffect(() => {
    if (!busy || calm()) return;
    let timer: ReturnType<typeof setTimeout>;
    let steps: ReturnType<typeof nextBeat> = [];
    const step = () => {
      if (!steps.length) steps = Math.random() < 0.25 ? [["blink", rand(800, 1400)], ...nextBeat(lively)] : nextBeat(lively);
      const [what, ms] = steps.shift()!;
      if (what === "blink") doBlink(Math.random() < 0.15);
      else if (typeof what === "string") doAction(what);
      else setPose(what);
      timer = setTimeout(step, ms);
    };
    timer = setTimeout(step, 250);
    return () => {
      clearTimeout(timer);
      setPose(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, lively]);

  // Idle life, unhurried: mostly blinks and glances, and for lively ones the odd small move or face.
  // Dozing, there's none of it: just the breathing, in CSS.
  const dozing = !!asleep && !busy;
  useEffect(() => {
    if (!alive || busy || dozing || calm()) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = (first = false) => {
      timer = setTimeout(() => {
        const what = nextIdle(lively);
        if ("glance" in what && !track) {
          setGlance([pick([-1, -0.6, 0.6, 1]) * REACH, pick([-0.6, 0, 0.4]) * REACH]);
          later(() => setGlance(undefined), rand(1300, 2500));
        } else if ("action" in what) doAction(what.action);
        else if ("flash" in what) doFlash(what.flash, 1400);
        else doBlink("blink" in what && what.blink);
        next();
      }, (first ? 900 : 3200) + Math.random() * 5200);
    };
    next(true);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alive, lively, track, busy, dozing]);

  // Woken to work, it has a little stretch on the way up.
  const wasDozing = useRef(dozing);
  useEffect(() => {
    if (wasDozing.current && !dozing) doAction("stretch");
    wasDozing.current = dozing;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dozing]);

  // Eyes that follow the pointer, written straight to the element so moving the mouse doesn't render.
  // Aimed from the eyes themselves (shapes carry their faces off-centre), all the way over once the
  // pointer is past the avatar's edge, in proportion closer in.
  const { x: faceX, y: faceY } = shape.face;
  useEffect(() => {
    const el = ref.current;
    if (!track || !el || calm()) return;
    el.dataset.tracking = "";
    const stop = follow(() => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const dx = pointer.x - (r.left + (faceX / 100) * r.width);
      const dy = pointer.y - (r.top + (faceY / 100) * r.height);
      const dist = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, dist / (r.width * 0.75));
      el.style.setProperty("--track-x", ((dx / dist) * TRACK_REACH * k).toFixed(2));
      el.style.setProperty("--track-y", ((dy / dist) * TRACK_REACH * 0.85 * k).toFixed(2));
    });
    return () => {
      stop();
      // Look ahead again once it stops following, e.g. when hovering ends: eased back, not snapped.
      delete el.dataset.tracking;
      el.style.removeProperty("--track-x");
      el.style.removeProperty("--track-y");
    };
  }, [track, faceX, faceY]);

  const pulseKey = pulse?.key;
  const lastPulse = useRef(pulseKey);
  useLayoutEffect(() => {
    if (pulseKey === undefined || pulseKey === lastPulse.current) return;
    lastPulse.current = pulseKey;
    doAction(pulse?.action ?? "hop");
    doFlash(pulse?.mood ?? "happy", 1300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulseKey]);

  const shown = flash ?? mood;
  // A reaction stirs a dozing bot for as long as its face shows, then it drifts off again.
  const sleeping = dozing && !flash;
  const look2 = pose ? [pose.x * REACH, pose.y * REACH * 0.8] : glance ?? (shown === "thinking" ? [REACH * 0.7, -REACH * 0.75] : undefined);
  // The head turning: the face slides and narrows, the body leans, the light moves the other way.
  const turn: Record<string, string | number> = pose ? { "--turn-x": pose.x, "--turn-y": pose.y, "--turn-a": Math.abs(pose.x), "--tilt": `${pose.tilt ?? 0}deg` } : {};
  const { face } = shape;
  // A touch bigger than the shapes' own numbers, so they still read on a 28px avatar.
  const eyeScale = (face.scale ?? 1) * 1.12;
  const gap = face.gap * 1.1;
  return (
    <span
      ref={ref}
      className={cx("bot", alive && "bot-alive", playful && "bot-playful", className)}
      data-color={color.id}
      data-mood={shown}
      data-blink={blink ? "" : undefined}
      data-action={action}
      data-looking={look2 ? "" : undefined}
      data-busy={busy || undefined}
      data-asleep={sleeping ? "" : undefined}
      data-eyes={flash ? undefined : pose?.eyes}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size, "--bob-delay": `${-(clip.charCodeAt(clip.length - 2) % 9) * 2.1}s`, ...(blink ? { "--blink": `${blink}ms` } : {}), ...(look2 ? { "--look-x": look2[0], "--look-y": look2[1] } : {}), ...turn } as React.CSSProperties}
      onPointerEnter={playful ? () => { doAction("nod"); doFlash("happy", 1100); } : undefined}
      onPointerDown={playful ? () => doAction("spin") : undefined}
      onAnimationEnd={(e) => {
        if ((e.target as Element).classList.contains("bot-act")) setAction(undefined);
      }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} overflow="visible">
        <g className="bot-act">
          <g className="bot-tilt">
            <g className="bot-turn">
              <Body shape={shape} color={color.hex} clip={`bot${clip}`} />
            </g>
            <g className="bot-face" transform={`translate(${face.x} ${face.y})`}>
              <g className="bot-look">
                <Eye mood={shown} x={-gap / 2} scale={eyeScale} glint={size >= 44} side="left" lid={asleep !== undefined} />
                <Eye mood={shown} x={gap / 2} scale={eyeScale} glint={size >= 44} side="right" lid={asleep !== undefined} />
              </g>
            </g>
          </g>
        </g>
      </svg>
      {asleep !== undefined && zzz && <Zzz size={size} />}
    </span>
  );
});

/** Sized from the avatar's, but never so small it stops reading as letters (the sidebar's are 28px and less). */
const zzzSize = (size: number) => Math.round(Math.min(16, Math.max(10, size * 0.3)));

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
export const BotHuddle = memo(function BotHuddle({ looks, size, alive = true, busy, active, track, me, zzz = true }: { looks: BotLook[]; size: number; alive?: boolean; busy?: boolean; active?: boolean[]; track?: boolean; me?: React.ReactNode; zzz?: boolean }) {
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
    items.push([i, <BotAvatar look={looks[i]!} size={Math.round(size * s)} alive={active ? active[i] || alive : alive} busy={active ? active[i] : busy} asleep={active && !active[i]} zzz={false} track={track} />]);
  });
  // One "zzz" for the huddle, over its corner, rather than one each on members too small to read it.
  const dozing = !!active && members.some((i) => !active[i]);
  // Hanging from the top corner, its lowest letter (2.15em down, and floating 0.2em more) would reach
  // the count's seat below in a small huddle: there it hangs that much higher.
  const z = zzzSize(size);
  const zzzTop = seated && active && zzz ? Math.min(-0.1 * z, 0.54 * size - 2.35 * z) : undefined;
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
