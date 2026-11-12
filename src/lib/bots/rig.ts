// OpenBots: how a bot's body moves. A bot is one solid thing: a flat shape with its face a little
// proud of it, like eyes painted on a dome. It turns (yaw and pitch, in 3D), rolls and leans as a
// whole, the face sliding across the body and narrowing toward the edge as it turns away. Nothing is
// keyframed: every part rides a spring toward where the bot wants to face, the eyes darting ahead,
// the head after them and the body last, so a change of mind mid-move stays smooth. This file is the
// arithmetic (no DOM), so tests can run it; BotAvatar.tsx writes what it works out to the page.
//
// The body is turned by the browser, in perspective. The face on it is worked out here and painted
// flat inside the body's outline, which cuts it off: an eye that slides to the edge goes round it out
// of sight, as it would on something round, rather than hanging off the side.
import type { Shape } from "./looks";

/** An open eye's size in the 100-unit box, before the shape's own scale: tall and deep. */
export const EYE_W = 10;
export const EYE_H = 23.4;
/** The eyes lean with the body's resting pose. */
export const EYE_TILT = -9;

/** The eyes' forms a pose can ask for, as multiples of an open eye's width and height. */
export const FORMS = {
  open: [1, 1],
  /** A stare: fatter and a little taller. */
  wide: [1.26, 1.1],
  /** Startled, or peering at something far off: big and round. */
  round: [1.36, 0.8],
  /** Narrowed to a slit. */
  squint: [1.2, 0.22],
} as const satisfies Record<string, readonly [number, number]>;
export type EyeForm = keyof typeof FORMS;

/** How far the head turns at most, in degrees: side to side, and up or down. */
export const YAW = 44;
export const PITCH = 36;
/** How far the face stands off the body, in the 100-unit box: what makes it slide as the head turns. */
export const DEPTH = 30;
/** The viewer's distance, in the same units: nearer would exaggerate the perspective. */
export const PERSPECTIVE = 260;
/** How much of the head's turn the body takes: it's one solid thing, but a soft one. */
export const BODY_TURN = 0.42;

/** Where a bot faces and how it carries itself: x and y from -1 to 1 (right and down), the rest optional. */
export interface Pose {
  x: number;
  y: number;
  /** Degrees, clockwise. Left out, it leans a little into the look. */
  roll?: number;
  /** Bigger or smaller, as leaning in or back: 0.1 is a tenth bigger. */
  zoom?: number;
  eyes?: Exclude<EyeForm, "open">;
}

type Point = [number, number];

/** A path of M, L, Q, C and Z commands (what looks.ts draws) as polygons, one for each closed part. */
export function outline(path: string): Point[][] {
  const parts: Point[][] = [];
  // A curve drawn through many points bends little between two of them: one more point each is plenty.
  const steps = (path.match(/C/g)?.length ?? 0) > 30 ? 1 : 3;
  let at: Point = [0, 0];
  for (const [, cmd, rest] of path.matchAll(/([MLQCZ])([^MLQCZ]*)/g)) {
    const n = (rest!.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    if (cmd === "M") parts.push([(at = [n[0]!, n[1]!])]);
    const part = parts.at(-1);
    if (!part) continue;
    if (cmd === "L") for (let i = 0; i + 1 < n.length; i += 2) part.push((at = [n[i]!, n[i + 1]!]));
    if (cmd === "Q")
      for (let i = 0; i + 3 < n.length; i += 4) {
        const [c, to]: [Point, Point] = [[n[i]!, n[i + 1]!], [n[i + 2]!, n[i + 3]!]];
        for (let s = 1; s <= 4; s++) {
          const t = s / 4;
          part.push([(1 - t) ** 2 * at[0] + 2 * (1 - t) * t * c[0] + t * t * to[0], (1 - t) ** 2 * at[1] + 2 * (1 - t) * t * c[1] + t * t * to[1]]);
        }
        at = to;
      }
    if (cmd === "C")
      for (let i = 0; i + 5 < n.length; i += 6) {
        const [c1, c2, to]: [Point, Point, Point] = [[n[i]!, n[i + 1]!], [n[i + 2]!, n[i + 3]!], [n[i + 4]!, n[i + 5]!]];
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const u = 1 - t;
          part.push([u ** 3 * at[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * to[0], u ** 3 * at[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * to[1]]);
        }
        at = to;
      }
  }
  return parts;
}

/** Whether (x, y) is inside any of the polygons. */
export function inside(parts: Point[][], x: number, y: number): boolean {
  for (const p of parts) {
    let hit = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i]!;
      const [xj, yj] = p[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    if (hit) return true;
  }
  return false;
}

/** How finely a body is filled in for `covers`: cells to a unit of the 100-unit box. */
const FINE = 2;
const covered = new Map<string, Uint8Array>();

/**
 * Whether a shape's body is under (x, y): `inside` its outline, read off a grid filled in once for
 * each shape (row by row, between the outline's crossings), so asking costs nothing.
 */
export function covers(shape: Shape, x: number, y: number): boolean {
  let grid = covered.get(shape.id);
  if (!grid) {
    const n = 100 * FINE;
    grid = new Uint8Array(n * n);
    for (const part of outline(shape.path))
      for (let row = 0; row < n; row++) {
        const at = (row + 0.5) / FINE;
        const xs: number[] = [];
        for (let i = 0, j = part.length - 1; i < part.length; j = i++) {
          const [xi, yi] = part[i]!;
          const [xj, yj] = part[j]!;
          if (yi > at !== yj > at) xs.push(((xj - xi) * (at - yi)) / (yj - yi) + xi);
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2)
          for (let col = Math.max(0, Math.ceil(xs[k]! * FINE - 0.5)); col < n && (col + 0.5) / FINE <= xs[k + 1]!; col++) grid[row * n + col] = 1;
      }
    covered.set(shape.id, grid);
  }
  const [col, row] = [Math.floor(x * FINE), Math.floor(y * FINE)];
  return col >= 0 && row >= 0 && col < 100 * FINE && row < 100 * FINE && grid[row * 100 * FINE + col] === 1;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Where a point of the face lands on the body with the head turned `yaw` and `pitch` degrees (right
 * and down) about the box's centre, seen from PERSPECTIVE away. The face stands DEPTH off the body,
 * so it slides across as it turns, and narrows.
 */
export function project(x: number, y: number, yaw: number, pitch: number): Point {
  const k = (PERSPECTIVE - DEPTH) / PERSPECTIVE;
  const [px, py] = [(x - 50) * k, (y - 50) * k];
  const [cy, sy, cp, sp] = [Math.cos(rad(yaw)), Math.sin(rad(yaw)), Math.cos(rad(-pitch)), Math.sin(rad(-pitch))];
  const x1 = px * cy + DEPTH * sy;
  const z1 = -px * sy + DEPTH * cy;
  const y2 = py * cp - z1 * sp;
  const z2 = py * sp + z1 * cp;
  const s = PERSPECTIVE / (PERSPECTIVE - z2);
  return [50 + x1 * s, 50 + y2 * s];
}

/** The eyes of a shape, as drawn: how big, and how far apart. */
export function eyesOf(shape: Shape) {
  const scale = shape.face.scale ?? 1;
  return { w: EYE_W * scale, h: EYE_H * scale, gap: shape.face.gap * 1.14 };
}

/**
 * The points of both eyes that have to stay on the body, in the face's own plane: all but the very
 * ends of each. Swinging past where it's headed, an eye slips under the body's edge, which cuts it off.
 */
function eyePoints(shape: Shape, form: EyeForm): Point[] {
  const { w, h, gap } = eyesOf(shape);
  const [fw, fh] = FORMS[form];
  const [c, s] = [Math.cos(rad(EYE_TILT)), Math.sin(rad(EYE_TILT))];
  const out: Point[] = [];
  for (const side of [-1, 1]) {
    const [cx, cy] = [shape.face.x + (side * gap) / 2, shape.face.y];
    // All over it: a lobed or spiky shape's notches reach in between a few points.
    for (const fy of [-0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4])
      for (const fx of Math.abs(fy) > 0.35 ? [-0.14, 0, 0.14] : Math.abs(fy) > 0.25 ? [-0.3, 0, 0.3] : [-0.42, -0.21, 0, 0.21, 0.42]) {
        const [dx, dy] = [w * fw * fx, h * fh * fy];
        out.push([cx + dx * c - dy * s, cy + dx * s + dy * c]);
      }
  }
  return out;
}

const DIRECTIONS = 36;
const rooms = new Map<string, number[]>();

/**
 * How far a shape's head can turn each way with its eyes still on its body: for each of 36
 * directions round the clock (0 = right, clockwise), the share of a full turn it has room for.
 * Worked out once for each shape and form of eye, from the outline itself.
 */
export function roomOf(shape: Shape, form: EyeForm = "open"): number[] {
  const key = `${shape.id} ${form}`;
  const known = rooms.get(key);
  if (known) return known;
  const points = eyePoints(shape, form);
  const fits = (yaw: number, pitch: number) => points.every(([x, y]) => covers(shape, ...project(x, y, yaw, pitch)));
  const room = Array.from({ length: DIRECTIONS }, (_, i) => {
    const a = (i / DIRECTIONS) * Math.PI * 2;
    const at = (m: number) => fits(Math.cos(a) * YAW * m, Math.sin(a) * PITCH * m);
    // Out from straight ahead a step at a time to the first turn that doesn't fit (a spiky shape can
    // fit again further on, in the next point along: that's no use), then closer in on it.
    let [lo, hi] = [0, 0];
    while (hi < 1 && at((hi = Math.min(1, hi + 1 / 8)))) lo = hi;
    if (lo === 1) return 1;
    for (let n = 0; n < 3; n++) {
      const mid = (lo + hi) / 2;
      if (at(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  });
  rooms.set(key, room);
  return room;
}

/** Where a bot is headed: the head's turn in degrees, the roll, and the zoom. */
export interface Target {
  yaw: number;
  pitch: number;
  roll: number;
  zoom: number;
}
export const REST: Target = { yaw: 0, pitch: 0, roll: 0, zoom: 0 };

/** A turn toward (x, y), -1 to 1 each way, held to what the shape has room for in that direction. */
export function turnTo(shape: Shape, x: number, y: number, form: EyeForm = "open"): [yaw: number, pitch: number] {
  const m = Math.hypot(x, y);
  if (!m) return [0, 0];
  const room = roomOf(shape, form);
  const at = ((Math.atan2(y, x) / (Math.PI * 2)) * DIRECTIONS + DIRECTIONS) % DIRECTIONS;
  const [i, f] = [Math.floor(at), at - Math.floor(at)];
  // Between two directions, what the tighter of them has: a spiky shape's room changes fast.
  const k = Math.min(m, 1, room[i % DIRECTIONS]!, f ? room[(i + 1) % DIRECTIONS]! : 1) / m;
  return [x * k * YAW, y * k * PITCH];
}

/** How far a bot leans (rolls) into a look to one side when the pose doesn't say, in degrees. */
const LEAN = 7;
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/** Where a pose takes a shape. */
export function poseTarget(shape: Shape, pose: Pose): Target {
  const [yaw, pitch] = turnTo(shape, pose.x, pose.y, pose.eyes ?? "open");
  // It leans by where it means to look, so a shape with little room to turn its head still moves.
  return { yaw, pitch, roll: pose.roll ?? clamp1(pose.x) * LEAN, zoom: pose.zoom ?? 0 };
}

/**
 * Where a bot following the pointer turns: straight toward it, (dx, dy) from between its eyes on an
 * avatar `width` across. Most of the way over within a few eye-widths and all of it by the edge,
 * leaning into it as it goes.
 */
export function aimTarget(shape: Shape, dx: number, dy: number, width: number): Target {
  const dist = Math.hypot(dx, dy);
  if (!dist || !width) return REST;
  const k = Math.tanh(dist / (width * 0.32));
  const [yaw, pitch] = turnTo(shape, (dx / dist) * k, (dy / dist) * k);
  return { yaw, pitch, roll: (dx / dist) * k * 11, zoom: 0 };
}

export interface Spring {
  /** How hard it pulls (its natural frequency, rad/s). */
  stiffness: number;
  /** 1 settles without swinging past; less overshoots. */
  damping: number;
}
/** A part's springs: locked onto the pointer, moving to a pose, and coming back to rest. */
export type Springs = { track: Spring; pose: Spring; rest: Spring };
export type Mode = keyof Springs;

/** The eyes dart ahead of the head: quick, and all but dead-beat. */
export const EYES: Springs = { track: { stiffness: 46, damping: 0.8 }, pose: { stiffness: 42, damping: 0.78 }, rest: { stiffness: 24, damping: 1 } };
/** The head turns after them, with a hint of overshoot onto a look, and none coming home. */
export const HEAD: Springs = { track: { stiffness: 30, damping: 0.72 }, pose: { stiffness: 24, damping: 0.66 }, rest: { stiffness: 15, damping: 1 } };
/** The body last, slower and heavier, swaying a little past and back. */
export const BODY: Springs = { track: { stiffness: 15, damping: 0.6 }, pose: { stiffness: 13, damping: 0.58 }, rest: { stiffness: 10, damping: 0.95 } };

export interface Axis {
  x: number;
  v: number;
}
const axis = (): Axis => ({ x: 0, v: 0 });

/** Everything about a bot that moves. Angles in degrees, the eyes' lead in the 100-unit box. */
export interface Rig {
  yaw: Axis;
  pitch: Axis;
  bodyYaw: Axis;
  bodyPitch: Axis;
  roll: Axis;
  zoom: Axis;
  leadX: Axis;
  leadY: Axis;
  /** A turn right round, 0 to 360 while it lasts (the press of a playful bot). */
  spin: number;
}
export const newRig = (): Rig => ({ yaw: axis(), pitch: axis(), bodyYaw: axis(), bodyPitch: axis(), roll: axis(), zoom: axis(), leadX: axis(), leadY: axis(), spin: 0 });

/** How far ahead of the head the eyes dart, in the 100-unit box for each degree it has left to turn. */
const LEAD = 0.13;
const LEAD_MAX = 4.5;

function pull(a: Axis, to: number, { stiffness: w, damping: z }: Spring, h: number) {
  a.v += (w * w * (to - a.x) - 2 * z * w * a.v) * h;
  a.x += a.v * h;
}

/**
 * Moves a rig `dt` ms toward a target. From rest everything eases in rather than jumps, and it comes
 * to rest exactly on the target: true once it has, so the frames can stop.
 */
export function step(rig: Rig, to: Target, dt: number, mode: Mode): boolean {
  // A long frame (a busy main thread, a hidden tab) is taken in short steps, so the springs stay stable.
  for (let left = Math.min(dt, 100) / 1000; left > 1e-9; left -= 1 / 120) {
    const h = Math.min(left, 1 / 120);
    pull(rig.yaw, to.yaw, HEAD[mode], h);
    pull(rig.pitch, to.pitch, HEAD[mode], h);
    pull(rig.bodyYaw, to.yaw, BODY[mode], h);
    pull(rig.bodyPitch, to.pitch, BODY[mode], h);
    pull(rig.roll, to.roll, BODY[mode], h);
    pull(rig.zoom, to.zoom, BODY[mode], h);
    // The eyes go first: as far ahead as the head still has to turn, and back onto it as it arrives.
    const clamp = (n: number) => Math.max(-LEAD_MAX, Math.min(LEAD_MAX, n));
    pull(rig.leadX, clamp((to.yaw - rig.yaw.x) * LEAD), EYES[mode], h);
    pull(rig.leadY, clamp((to.pitch - rig.pitch.x) * LEAD), EYES[mode], h);
  }
  const off = (a: Axis, t: number, near: number) => Math.abs(t - a.x) > near || Math.abs(a.v) > near * 12;
  if (off(rig.yaw, to.yaw, 0.05) || off(rig.pitch, to.pitch, 0.05) || off(rig.bodyYaw, to.yaw, 0.05) || off(rig.bodyPitch, to.pitch, 0.05)) return false;
  if (off(rig.roll, to.roll, 0.05) || off(rig.zoom, to.zoom, 0.0008) || off(rig.leadX, 0, 0.02) || off(rig.leadY, 0, 0.02)) return false;
  settle(rig, to);
  return true;
}

const settle = (rig: Rig, to: Target) => {
  for (const [a, t] of [[rig.yaw, to.yaw], [rig.pitch, to.pitch], [rig.bodyYaw, to.yaw], [rig.bodyPitch, to.pitch], [rig.roll, to.roll], [rig.zoom, to.zoom], [rig.leadX, 0], [rig.leadY, 0]] as [Axis, number][]) {
    a.x = t;
    a.v = 0;
  }
};

/** Puts a rig on a target at once, for when nothing should be seen to move. */
export function snap(rig: Rig, to: Target) {
  rig.spin = 0;
  settle(rig, to);
}

/**
 * A nod: the head is knocked forward and its own springs bring it back, the body dipping after it.
 * Down and back, on top of whatever it's doing; nothing lifts.
 */
export function nod(rig: Rig) {
  rig.pitch.v += 900;
  rig.bodyPitch.v += 430;
  rig.leadY.v += 60;
}

export const atRest = (rig: Rig) => !rig.spin && [rig.yaw, rig.pitch, rig.bodyYaw, rig.bodyPitch, rig.roll, rig.zoom, rig.leadX, rig.leadY].every((a) => a.x === 0 && a.v === 0);

const n = (v: number, digits = 2) => {
  const s = v.toFixed(digits);
  return Number(s) === 0 ? "0" : s;
};

/**
 * A rig as what to draw, for a shape on an avatar `size` px across: the whole bot (rolled, leant and
 * zoomed, about its middle), the body (turned part of the way, in perspective), and each eye where
 * the head's turn puts it on that body: slid across, narrowed, the nearer one a little bigger. The
 * eyes are worked out here (a flat transform each, `project` at the eye and how it stretches there)
 * rather than turned by the browser, so the body stays one layer with the face painted on it. At rest
 * everything is "none". `back` is true while a turn right round shows the body's back, the face out
 * of sight.
 */
export function frame(rig: Rig, shape: Shape, size: number): { whole: string; body: string; left: string; right: string; back: boolean } {
  const u = size / 100;
  // Leaning into a turn, and settling a little to look down: never lifting to look up.
  const tx = (rig.bodyYaw.x / YAW) * 2.6 * u;
  const ty = (Math.max(0, rig.bodyPitch.x) / PITCH) * 1.4 * u;
  const whole = tx || ty || rig.roll.x || rig.zoom.x ? `translate(${n(tx)}px, ${n(ty)}px) rotate(${n(rig.roll.x)}deg) scale(${n(1 + rig.zoom.x, 4)})` : "none";
  const by = rig.bodyYaw.x * BODY_TURN + rig.spin;
  const bp = rig.bodyPitch.x * BODY_TURN;
  const body = by || bp ? `perspective(${n(PERSPECTIVE * u, 1)}px) rotateX(${n(-bp)}deg) rotateY(${n(by)}deg)` : "none";
  const [yaw, pitch, lx, ly] = [rig.yaw.x, rig.pitch.x, rig.leadX.x, rig.leadY.x];
  const facing = ((by % 360) + 360) % 360;
  const back = facing > 90 && facing < 270;
  if (!yaw && !pitch && !lx && !ly) return { whole, body, left: "none", right: "none", back };
  const [c, s] = [Math.cos(rad(EYE_TILT)), Math.sin(rad(EYE_TILT))];
  const eye = (side: number) => {
    const [x, y] = [shape.face.x + (side * eyesOf(shape).gap) / 2, shape.face.y];
    // Where its middle lands (the eyes' lead is a slide within the face), and how the face is stretched there.
    const [px, py] = project(x + lx, y + ly, yaw, pitch);
    const [ax, ay] = project(x + lx + 1, y + ly, yaw, pitch);
    const [bx, by2] = project(x + lx, y + ly + 1, yaw, pitch);
    const [j11, j21, j12, j22] = [ax - px, ay - py, bx - px, by2 - py];
    return `matrix(${n(j11 * c + j12 * s, 4)}, ${n(j21 * c + j22 * s, 4)}, ${n(-j11 * s + j12 * c, 4)}, ${n(-j21 * s + j22 * c, 4)}, ${n((px - x) * u)}, ${n((py - y) * u)})`;
  };
  return { whole, body, left: eye(-1), right: eye(1), back };
}
