// OpenBots' bots: a flat shape in one colour with two big, deep eyes, and nothing else. What makes
// one alive is how it moves: it's a solid thing that turns, rolls and leans as a whole (see
// lib/bots/rig.ts), the face sliding across the body as the head turns and the eyes darting ahead of
// it. A still bot rests turned up and away and rolled over. Left alone it breathes, stares straight
// out, blinks and looks around; at work it faces you, eyes grown big, brisk, rocking, peering and
// leaning in. It can follow the pointer, turning and leaning toward it; a held
// mood (thinking while typing, happy at a reaction) changes its eyes, and in a group the ones not at
// work doze, a "zzz" floating up over them. Starting on something, before there's a step to show, it
// turns into three dots for a moment and back, and in a chat's working row it stays three dots for as
// long as there's nothing to name. Nothing ever hops, and nothing spins of its own accord.
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { colorOf, shapeOf, type Action, type BotLook, type Mood } from "../../lib/bots/looks";
import { aimTarget, eyesFor, eyesOf, frame, newRig, nod, poseTarget, restFrame, restOf, snap, step, warm, type Pose } from "../../lib/bots/rig";
import { nextBeat, nextIdle, THINKING, type Step } from "../../lib/bots/routines";
import { cx } from "../../lib/ui";

export type { Action, Mood };

const calm = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

// One frame loop for every bot that's moving: each steps its springs and writes its transforms, and
// drops out once it has come to rest, so a page of still bots costs nothing.
const moving = new Set<(now: number) => void>();
let frameId = 0;
function run(now: number) {
  frameId = 0;
  for (const tick of [...moving]) tick(now);
  if (moving.size) frameId = requestAnimationFrame(run);
}
function animate(tick: (now: number) => void) {
  moving.add(tick);
  frameId ||= requestAnimationFrame(run);
}

// One pointer listener for every bot that follows it. Where the pointer is stays known between
// followers, so a bot that starts following turns the right way at once.
const followers = new Set<() => void>();
const pointer = { x: -1, y: -1, watching: false };
function onPointerMove(e: PointerEvent) {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  for (const f of followers) f();
}
function follow(fn: () => void) {
  if (!pointer.watching) {
    pointer.watching = true;
    window.addEventListener("pointermove", onPointerMove, { passive: true });
  }
  followers.add(fn);
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

/** The longest a bot stays three dots when it's only `waiting`, and how long it takes to come back from them, ms (see .bot-dots). */
const DOTS_MAX = 2400;
const DOTS_OUT = 560;
/** How long a bot looks pleased after a reaction or finishing something, ms. */
const PLEASED = 5200;
/** When the page has a moment to spare (or soon enough anyway). */
const whenIdle = (step: () => void) => void (typeof requestIdleCallback === "function" ? requestIdleCallback(step, { timeout: 3000 }) : setTimeout(step, 300));

/** How long a turn right round takes, ms. */
const SPIN = 720;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * One eye: a solid pill and nothing in it, its form set by the mood and pose in CSS (see
 * .bot-eye-fill). Hearts, in love. Where the head's turn puts it is written to it frame by frame.
 */
function Eye({ side, x, love, at, rest }: { side: "left" | "right"; x: number; love: boolean; at: React.Ref<HTMLSpanElement>; rest: string }) {
  return (
    <span ref={at} className={`bot-eye bot-eye-${side}`} style={{ left: `calc(var(--u) * ${x})`, transform: rest }}>
      {love ? (
        <svg className="bot-eye-heart" viewBox="-7 -8 14 14">
          <path d="M0 5.6C-10 -1.1 -4.5 -9 0 -3.4C4.5 -9 10 -1.1 0 5.6Z" />
        </svg>
      ) : (
        <span className="bot-eye-fill" />
      )}
    </span>
  );
}

export interface BotAvatarProps {
  look: BotLook;
  size: number;
  /** A held expression, e.g. thinking while the bot types. */
  mood?: Mood;
  /** Breathe, blink, stare and look around on its own. */
  alive?: boolean;
  /** Also nod, rock and pull faces now and then (the bigger avatars). */
  lively?: boolean;
  /** Follow the pointer: the whole body turns and leans toward it. */
  track?: boolean;
  /** Nod and smile on hover, turn right round when pressed. */
  playful?: boolean;
  /** Busy at something: brisk, rocking and peering about. */
  busy?: boolean;
  /**
   * Dozing, as a group's members do while they aren't at work: eyes shut, head down, breathing slowly
   * if it's alive. Set (true or false) on any avatar that can doze, so it eases in and out of it.
   */
  asleep?: boolean;
  /** A little "zzz" floats up while it dozes. Only the sidebars turn it on: beside chat messages the shut eyes say enough. */
  zzz?: boolean;
  /**
   * Starting on something, with nothing to show of it yet: the body gathers into three dots, a wave
   * running along them, and comes back as itself when there is (or after DOTS_MAX at the latest).
   */
  waiting?: boolean;
  /** Three dots, as `waiting`, but for as long as it's set: its life holds still meanwhile, out of sight. */
  dots?: boolean;
  /** Change it to make the bot react once: a swell and a happy face, or the given mood and move. */
  pulse?: { key: string | number; mood?: Mood; action?: Action };
  className?: string;
  label?: string;
}

export const BotAvatar = memo(function BotAvatar({ look, size, mood = "idle", alive = true, lively = false, track = false, playful = false, busy = false, asleep, zzz = false, waiting = false, dots: stayDots = false, pulse, className, label }: BotAvatarProps) {
  const [pose, setPose] = useState<Pose>();
  const shape = shapeOf(look);
  const color = colorOf(look);
  const ref = useRef<HTMLSpanElement>(null);
  const wholeRef = useRef<HTMLSpanElement>(null);
  const bodyRef = useRef<HTMLSpanElement>(null);
  const skinRef = useRef<HTMLSpanElement>(null);
  const leftRef = useRef<HTMLSpanElement>(null);
  const rightRef = useRef<HTMLSpanElement>(null);
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

  // Waiting: three dots for a moment, DOTS_MAX at the most.
  const [brief, setBrief] = useState(false);
  useEffect(() => {
    if (!waiting) return setBrief(false);
    setBrief(true);
    const limit = setTimeout(() => setBrief(false), DOTS_MAX);
    return () => clearTimeout(limit);
  }, [waiting]);
  // The dots: "in" while it's turned into them, "out" for the moment it takes to come back.
  const want = stayDots || brief;
  const staying = useRef(stayDots);
  staying.current = stayDots;
  const [dots, setDots] = useState<"in" | "out">();
  const dotsNow = useRef(dots);
  dotsNow.current = dots;
  useEffect(() => {
    if (want) return setDots("in");
    setDots((cur) => (cur === "in" ? "out" : cur));
    // The way back plays out on its own, unless it turns into dots again first.
    const back = setTimeout(() => setDots((cur) => (cur === "out" ? undefined : cur)), DOTS_OUT);
    return () => clearTimeout(back);
  }, [want]);

  const shown = flash ?? mood;
  const dozing = !!asleep && !busy;
  // A reaction stirs a dozing bot for as long as its face shows, then it drifts off again.
  const sleeping = dozing && !flash;
  const held = pose ?? (shown === "thinking" ? THINKING : undefined);

  // The body: springs toward wherever it's facing (a pose, the pointer, or back to rest), stepped
  // frame by frame while anything moves and written straight to the layers, so none of it renders.
  // It's drawn at rest to begin with (`rest`, below), with nothing run to put it there.
  const body = useRef<{ rig: ReturnType<typeof newRig>; tracking: boolean; last: number; spun: number; pose?: Pose; shape: typeof shape; size: number; busy: boolean }>(undefined);
  body.current ??= { rig: newRig(restOf(shape)), tracking: false, last: 0, spun: 0, pose: held, shape, size, busy };
  Object.assign(body.current, { pose: held, shape, size, busy });
  const write = () => {
    const b = body.current!;
    const f = frame(b.rig, b.shape, b.size);
    for (const [el, t] of [[wholeRef.current, f.whole], [bodyRef.current, f.body], [leftRef.current, f.left], [rightRef.current, f.right]] as const) if (el) el.style.transform = t;
    if (skinRef.current) skinRef.current.style.visibility = f.back ? "hidden" : "";
  };
  const target = () => {
    const b = body.current!;
    const el = ref.current;
    if (b.pose) return poseTarget(b.shape, b.pose, b.busy);
    if (!b.tracking || !el || pointer.x < 0) return restOf(b.shape);
    const r = el.getBoundingClientRect();
    return r.width ? aimTarget(b.shape, pointer.x - (r.left + (b.shape.face.x / 100) * r.width), pointer.y - (r.top + (b.shape.face.y / 100) * r.height), r.width) : restOf(b.shape);
  };
  const tick = useRef((now: number) => {
    const b = body.current!;
    const dt = b.last ? now - b.last : 16;
    b.last = now;
    if (b.spun) {
      const t = (now - b.spun) / SPIN;
      b.rig.spin = t >= 1 ? 0 : 360 * easeInOut(Math.max(0, t));
      if (t >= 1) b.spun = 0;
    }
    const done = step(b.rig, target(), dt, b.pose ? "pose" : b.tracking ? "track" : "rest") && !b.spun;
    write();
    if (!done) return;
    b.last = 0;
    moving.delete(tick.current);
  });
  /** Sets it moving toward wherever it now faces (or puts it there, when motion is reduced). */
  const move = () => {
    if (calm()) snap(body.current!.rig, target());
    else animate(tick.current);
    // Drawn as it stands now, before the next paint: a new shape or size was just drawn at rest.
    write();
  };
  useEffect(() => () => void moving.delete(tick.current), []);
  // How far this shape can turn is worked out ahead, in idle time, so its first look doesn't wait for it.
  useEffect(() => warm(shape, whenIdle), [shape]);
  // A new pose or thought, a new shape or size: on its way there. The first time, it's simply there.
  const mounted = useRef(false);
  useLayoutEffect(() => {
    if (mounted.current) return move();
    mounted.current = true;
    if (!held) return;
    snap(body.current!.rig, target());
    write();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, shape, size]);

  // Following the pointer, wherever it is; let go, it eases back to looking ahead. A pose wins: it
  // looks where the pose says, and takes the pointer up again after.
  useEffect(() => {
    const el = ref.current;
    if (!track || !el || calm()) return;
    const b = body.current!;
    b.tracking = true;
    el.dataset.tracking = "";
    const stop = follow(() => animate(tick.current));
    if (pointer.x >= 0) animate(tick.current);
    return () => {
      stop();
      b.tracking = false;
      delete el.dataset.tracking;
      animate(tick.current);
    };
  }, [track]);

  // Lids snap down, held a moment, and up a touch slower (see .bot-eye-fill): never the same blink twice.
  const doBlink = (twice = false) => {
    const close = Math.round(rand(70, 110));
    setBlink(close);
    later(() => setBlink(undefined), close + rand(30, 80));
    if (twice) later(() => doBlink(), rand(260, 360));
  };
  const doAction = (a: Action) => {
    if (calm()) return;
    // A turn right round and a nod are the body's own: the face goes round the back and comes out the
    // other side, or dips and comes back up. The rest are played over it (.bot-act).
    if (a === "spin") body.current!.spun = performance.now();
    if (a === "nod") nod(body.current!.rig);
    if (a === "spin" || a === "nod") animate(tick.current);
    setAction(undefined);
    requestAnimationFrame(() => setAction(a));
    later(() => setAction((cur) => (cur === a ? undefined : cur)), 1000);
  };
  const doFlash = (m: Mood, ms = 1000) => {
    setFlash(m);
    later(() => setFlash((cur) => (cur === m ? undefined : cur)), ms);
  };

  // A life of its own, one routine after another: busy, brisk poses with blinks between; idle, a rest
  // staring straight out and then a stare, a look around, a blink or (lively) a move. Dozing, there's
  // none of it: just the breathing, in CSS.
  useEffect(() => {
    const el = ref.current;
    if (!(alive || busy) || dozing || !el || calm()) return;
    let timer: ReturnType<typeof setTimeout>;
    let steps: Step[] = [];
    const next = () => {
      if (offScreen(el)) {
        timer = setTimeout(next, 2000);
        return;
      }
      // Three dots for a while: nothing of it shows, so nothing of it moves until it's back.
      if (staying.current) {
        timer = setTimeout(next, 300);
        return;
      }
      if (!steps.length) steps = busy ? (Math.random() < 0.25 ? [["blink", rand(500, 900)], ...nextBeat()] : nextBeat()) : [[null, rand(800, 2600)], ...nextIdle(lively, track)];
      const [what, ms] = steps.shift()!;
      if (what === null) setPose(undefined);
      else if (what === "blink" || what === "blink2") doBlink(what === "blink2");
      else if (typeof what === "string") doAction(what);
      else if ("flash" in what) doFlash(what.flash, ms);
      else setPose(what);
      timer = setTimeout(next, ms);
    };
    timer = setTimeout(next, busy ? 200 : rand(300, 1500));
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

  const pulseKey = pulse?.key;
  const lastPulse = useRef(pulseKey);
  useLayoutEffect(() => {
    if (pulseKey === undefined || pulseKey === lastPulse.current) return;
    lastPulse.current = pulseKey;
    // Its way into or out of the dots is the move: one played over it would cut that short.
    if (!dotsNow.current && !stayDots) doAction(pulse?.action ?? "jelly");
    // Pleased with itself, it stays that way a good while: the face of a bot that's done.
    doFlash(pulse?.mood ?? "happy", pulse?.mood ? 1300 : PLEASED);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pulseKey]);

  const { face } = shape;
  const eyes = eyesOf(shape);
  // How it's drawn while nothing has moved it: at rest. (What moves it writes over these.)
  const rest = restFrame(shape, size);
  // Each bot starts somewhere else in its cycle of breaths.
  // The outline its face is cut to is its own (named for the shape too, so that even two that came by
  // the same name would be cut alike).
  const clip = `bot-${shape.id}-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const delay = `${-(clip.charCodeAt(clip.length - 2) % 9) * 1.3}s`;
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
      data-eyes={flash ? undefined : eyesFor(pose, busy)}
      data-dots={dots}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size, "--u": `${size / 100}px`, "--bot-color": color.hex, "--bob-delay": delay, ...(blink ? { "--blink": `${blink}ms` } : {}) } as React.CSSProperties}
      onPointerEnter={playful ? () => { doAction("nod"); doFlash("happy", 1100); } : undefined}
      onPointerDown={playful ? () => doAction("spin") : undefined}
      onAnimationEnd={(e) => {
        if ((e.target as Element).classList.contains("bot-act")) setAction(undefined);
      }}
    >
      {/* The dots sit behind the body, so on the way in and out the two make one outline (.bot-dots). */}
      {dots && (
        <span className="bot-dots">
          <i />
          <i />
          <i />
        </span>
      )}
      {/* A one-off move (.bot-act), the slump of a doze (.bot-doze), then the body itself. */}
      <span className="bot-act">
        <span className="bot-doze">
          <span className="bot-whole" ref={wholeRef} style={{ transform: rest.whole }}>
            <span className="bot-body" ref={bodyRef} style={{ transform: rest.body }}>
              <svg viewBox="0 0 100 100" width={size} height={size}>
                <defs>
                  <clipPath id={clip} clipPathUnits="objectBoundingBox">
                    <path d={shape.path} transform="scale(0.01)" />
                  </clipPath>
                </defs>
                <path className="bot-shape" d={shape.path} fill={color.hex} />
              </svg>
              {/* The face, painted on the body and cut to its outline: the eyes slide across it as the head
                  turns, and under its edge. Sizes in it are in --u, a unit of the 100-unit box. */}
              <span className="bot-skin" ref={skinRef} style={{ clipPath: `url(#${clip})`, "--eye-w": eyes.w, "--eye-h": eyes.h } as React.CSSProperties}>
                <span className="bot-nap">
                  <span className="bot-eyes" style={{ left: `${face.x}%`, top: `${face.y}%` }}>
                    <Eye side="left" x={-eyes.gap / 2} love={shown === "love"} at={leftRef} rest={rest.left} />
                    <Eye side="right" x={eyes.gap / 2} love={shown === "love"} at={rightRef} rest={rest.right} />
                  </span>
                </span>
              </span>
            </span>
          </span>
        </span>
      </span>
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
    // A touch smaller than its seat when it has neighbours: the shapes reach wide (a sparkle's arms,
    // a wedge's corners), and seated side by side they'd touch each other and the count.
    const s = (layout[n + (me ? 1 : 0)]?.[2] ?? 0.5) * (count > 1 ? 0.92 : 1);
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
