// OpenBots' bots: a shape and a colour with two little eyes. Left alone they breathe, blink and
// glance about; the bigger ones now and then hop, spin or wiggle. Eyes can follow the pointer, and a
// held mood (thinking while typing, happy at a reaction) changes their expression.
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { colorOf, shapeOf, type Action, type BotLook, type Mood, type Shape } from "../../lib/bots/looks";
import { useBots } from "../../lib/bots/store";
import { cx } from "../../lib/ui";

export type { Action, Mood };

const calm = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

// One pointer listener for every avatar whose eyes follow it, batched to a frame.
const followers = new Set<() => void>();
const pointer = { x: -1, y: -1, frame: 0 };
function onPointerMove(e: PointerEvent) {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.frame ||= requestAnimationFrame(() => {
    pointer.frame = 0;
    for (const f of followers) f();
  });
}
function follow(fn: () => void) {
  if (!followers.size) window.addEventListener("pointermove", onPointerMove, { passive: true });
  followers.add(fn);
  return () => {
    followers.delete(fn);
    if (!followers.size) window.removeEventListener("pointermove", onPointerMove);
  };
}

/** How far the eyes travel when looking, in the 100-unit box. */
const REACH = 5;

function Eye({ mood, x, scale, glint, side }: { mood: Mood; x: number; scale: number; glint: boolean; side: "left" | "right" }) {
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
      <g className={cx("bot-eye", mood === "squint" && "bot-eye-squint", mood === "thinking" && side === "left" && "bot-eye-squint")}>{eye}</g>
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
        <ellipse cx="34" cy="24" rx="30" ry="20" fill="#fff" opacity="0.16" />
        <ellipse cx="62" cy="96" rx="46" ry="22" fill="#000" opacity="0.1" />
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
  /** Also hop, spin and pull faces now and then (the bigger avatars). */
  lively?: boolean;
  /** Eyes follow the pointer. */
  track?: boolean;
  /** Hop and smile on hover, spin when pressed. */
  playful?: boolean;
  /** Change it to make the bot react once: a hop and a happy face, or the given mood. */
  pulse?: { key: string | number; mood?: Mood; action?: Action };
  className?: string;
  label?: string;
}

export const BotAvatar = memo(function BotAvatar({ look, size, mood = "idle", alive = true, lively: wantsLively = false, track: wantsTrack = false, playful = false, pulse, className, label }: BotAvatarProps) {
  // Settings → Bots can calm them all down.
  const lively = useBots((s) => wantsLively && s.prefs.lively);
  const track = useBots((s) => wantsTrack && s.prefs.track);
  const shape = shapeOf(look);
  const color = colorOf(look);
  const clip = useId().replace(/:/g, "");
  const ref = useRef<HTMLSpanElement>(null);
  const [blink, setBlink] = useState(false);
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

  const doBlink = (twice = false) => {
    setBlink(true);
    later(() => setBlink(false), 110);
    if (twice) later(() => doBlink(), 260);
  };
  const doAction = (a: Action) => {
    if (calm()) return;
    setAction(undefined);
    requestAnimationFrame(() => setAction(a));
    later(() => setAction((cur) => (cur === a ? undefined : cur)), 1100);
  };
  const doFlash = (m: Mood, ms = 1000) => {
    setFlash(m);
    later(() => setFlash((cur) => (cur === m ? undefined : cur)), ms);
  };

  // Idle life: mostly blinks and glances, and for lively ones the odd trick or face.
  useEffect(() => {
    if (!alive || calm()) return;
    let timer: ReturnType<typeof setTimeout>;
    const next = (first = false) => {
      timer = setTimeout(() => {
        const r = Math.random();
        if (r < 0.5) doBlink(Math.random() < 0.2);
        else if (r < 0.8 && !track) {
          setGlance([pick([-1, -0.6, 0.6, 1]) * REACH, pick([-0.6, 0, 0.4]) * REACH]);
          later(() => setGlance(undefined), 900 + Math.random() * 900);
        } else if (lively && r < 0.92) doAction(pick(["hop", "spin", "wiggle", "squish", "nod"] as const));
        else if (lively) doFlash(pick(["happy", "wink", "squint"] as const), 1100);
        else doBlink();
        next();
      }, (first ? 600 : 2200) + Math.random() * 4200);
    };
    next(true);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alive, lively, track]);

  // Eyes that follow the pointer, written straight to the element so moving the mouse doesn't render.
  useEffect(() => {
    const el = ref.current;
    if (!track || !el || calm()) return;
    return follow(() => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const dx = pointer.x - (r.left + r.width / 2);
      const dy = pointer.y - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, dist / (r.width * 2.2));
      el.style.setProperty("--track-x", String((dx / dist) * REACH * k));
      el.style.setProperty("--track-y", String((dy / dist) * REACH * 0.8 * k));
    });
  }, [track]);

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
  const look2 = glance ?? (shown === "thinking" ? [REACH * 0.7, -REACH * 0.75] : undefined);
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
      data-blink={blink || undefined}
      data-action={action}
      data-looking={look2 ? "" : undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size, "--bob-delay": `${-(clip.charCodeAt(clip.length - 2) % 9) * 0.4}s`, ...(look2 ? { "--look-x": look2[0], "--look-y": look2[1] } : {}) } as React.CSSProperties}
      onPointerEnter={playful ? () => { doAction("hop"); doFlash("happy", 900); } : undefined}
      onPointerDown={playful ? () => doAction("spin") : undefined}
      onAnimationEnd={(e) => {
        if ((e.target as Element).classList.contains("bot-act")) setAction(undefined);
      }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} overflow="visible">
        <g className="bot-act">
          <g className="bot-bob">
            <Body shape={shape} color={color.hex} clip={`bot${clip}`} />
            <g className="bot-face" transform={`translate(${face.x} ${face.y})`}>
              <g className="bot-look">
                <Eye mood={shown} x={-gap / 2} scale={eyeScale} glint={size >= 44} side="left" />
                <Eye mood={shown} x={gap / 2} scale={eyeScale} glint={size >= 44} side="right" />
              </g>
            </g>
          </g>
        </g>
      </svg>
    </span>
  );
});

/**
 * A group's avatar: its members huddled together (up to four, the rest as a count). The user can
 * sit in the huddle too, as their profile picture.
 */
export const BotHuddle = memo(function BotHuddle({ looks, size, alive = true, extra, me }: { looks: BotLook[]; size: number; alive?: boolean; extra?: number; me?: React.ReactNode }) {
  const members = looks.slice(0, me ? 3 : 4);
  const count = members.length + (me ? 1 : 0);
  // Where each member sits, as fractions of the box (centre x, centre y, size).
  const spots: [number, number, number][][] = [
    [],
    [[0.5, 0.5, 0.9]],
    [[0.33, 0.36, 0.6], [0.66, 0.64, 0.6]],
    [[0.32, 0.3, 0.52], [0.7, 0.4, 0.52], [0.4, 0.72, 0.52]],
    [[0.3, 0.28, 0.48], [0.7, 0.28, 0.48], [0.3, 0.72, 0.48], [0.72, 0.7, 0.48]],
  ];
  const layout = spots[Math.min(count, 4)] ?? [];
  const items: React.ReactNode[] = [];
  if (me) items.push(me);
  members.forEach((look, i) => items.push(<BotAvatar key={i} look={look} size={Math.round(size * (layout[i + (me ? 1 : 0)]?.[2] ?? 0.5))} alive={alive} />));
  return (
    <span className="bot-huddle" style={{ width: size, height: size }} aria-hidden>
      {items.map((item, i) => {
        const [x, y, s] = layout[i] ?? [0.5, 0.5, 0.5];
        return (
          <span key={i} className="bot-huddle-spot" style={{ left: `${(x - s / 2) * 100}%`, top: `${(y - s / 2) * 100}%`, width: `${s * 100}%`, height: `${s * 100}%` }}>
            {item}
          </span>
        );
      })}
      {!!extra && <span className="bot-huddle-more">+{extra}</span>}
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
