// OpenBots: how a bot's body moves. A bot is one solid thing: a flat shape with its face a little
// proud of it, like eyes painted on a dome. It turns (yaw and pitch, in 3D), rolls and leans as a
// whole, the face sliding across the body and narrowing toward the edge as it turns away. Nothing is
// keyframed: every part rides a spring toward where the bot wants to face, the eyes darting ahead,
// the head after them and the body last, so a change of mind mid-move stays smooth. This file is the
// arithmetic (no DOM), so tests can run it; BotAvatar.tsx writes what it works out to the page.
//
// A shape is drawn upright, facing straight out (lib/bots/looks.ts). That's how a bot looks at you,
// and how it works; left to itself it rests turned up and away to one side and rolled over, which is
// how every still bot in the app is seen.
//
// The body is turned by the browser, in perspective. The face on it is worked out here and painted
// flat inside the body's outline. An eye never comes nearer its edge than MARGIN: where a turn would
// take it nearer, it goes no further while the body turns on under it.
import type { Shape } from "./looks";

/** An open eye's size in the 100-unit box, before the shape's own scale: a tall pill. */
export const EYE_W = 8.6;
export const EYE_H = 18.5;

/** The eyes' forms a pose can ask for, as multiples of an open eye's width and height. */
export const FORMS = {
  open: [1, 1],
  /** A stare: a good deal fatter and a little taller, the eyes of a bot paying attention. */
  wide: [1.2, 1.1],
  /** Startled, or peering at something far off: big and round. */
  round: [1.3, 0.8],
  /** Narrowed to a dash, longer than an open eye is wide. */
  squint: [1.3, 0.24],
  /** At work: much bigger, fat and deep, a quarter of the face between them. */
  big: [1.6, 1.48],
  /** Reading: the big eyes of work with their lids come down a third, onto the page (lowered too: DRAWN.read). */
  read: [1.45, 1],
} as const satisfies Record<string, readonly [number, number]>;
export type EyeForm = keyof typeof FORMS;

/** How far the head turns at most, in degrees: side to side, and up or down. */
export const YAW = 46;
export const PITCH = 42;
/**
 * How far the face stands off the body, in the 100-unit box: what makes it slide as the head turns.
 * Shallow, so a full turn takes the eyes a good way over but not out to the edge.
 */
export const DEPTH = 20;
/** The viewer's distance, in the same units: nearer would exaggerate the perspective. */
export const PERSPECTIVE = 260;
/** How much of the head's turn the body takes: it's one solid thing, but a soft one. */
export const BODY_TURN = 0.42;
/** How much smaller the eyes are at a full turn: turned away, the face is further off, but only a little. */
export const FAR = 0.12;
/** How much of the turn's narrowing an eye takes: under a third, so it stays a full pill turned away. */
export const SOFT = 0.3;
/** How much of an eye, about its middle, has to stay on the body: its ends may slip under the edge. */
export const CORE = 0.75;
/**
 * How near the body's edge an eye ever comes, in the 100-unit box: the same for every shape. Turned
 * further, the eyes stop there and the body turns on under them, so the edge never cuts one.
 */
export const MARGIN = 4;

/**
 * Every form an eye is drawn in (bots.css), for keeping it off the edge: its width and height as
 * multiples of an open eye's; how far its middle sits below where an open eye's does, in open-eye
 * heights; how round its corners are, top and bottom, as a share of its width (a pill's are half: CSS
 * rounds them no further than fits); and how far a doze lowers the whole face, in the 100-unit box.
 */
export interface Drawn {
  w: number;
  h: number;
  drop?: number;
  top?: number;
  bottom?: number;
  nap?: number;
}
export const DRAWN = {
  ...(Object.fromEntries(Object.entries(FORMS).map(([k, [w, h]]) => [k, { w, h }])) as Record<EyeForm, Drawn>),
  /**
   * Its top come well down from a big eye's and its foot only a little up: lowered by an eighth of an
   * open eye. Lower still, a star's eyes would have no room left to read along a line.
   */
  read: { w: FORMS.read[0], h: FORMS.read[1], drop: 0.12 },
  /** Pleased: a thick arch, lifted a little, its feet squarer. */
  happy: { w: 1.36, h: 0.54, drop: -0.08, bottom: 0.22 },
  sleepy: { w: 1.25, h: 0.15 },
  /** In love: a heart, about as wide as tall, its lobes filling out its top corners, its point a little low. */
  love: { w: 1.28, h: 0.58, drop: 0.04, top: 0.15 },
  /** Dozing: shut to a dash a little below the middle, and the face drooped (.bot-nap). */
  asleep: { w: 1.2, h: 0.16, drop: 0.08, nap: 5 },
} satisfies Record<string, Drawn>;
export type EyeLook = keyof typeof DRAWN;

/**
 * The form a bot's eyes are drawn in, as bots.css decides it: hearts in love, a dash dozing, and
 * otherwise what the mood or the pose asks, the later rule in the sheet winning where both do.
 */
export function eyeLook(mood: string | undefined, eyes: EyeForm | undefined, asleep = false): EyeLook {
  if (mood === "love") return "love";
  if (asleep) return "asleep";
  const asked = new Set<EyeLook>([eyes ?? "open"]);
  if (mood === "happy" || mood === "wink") asked.add("happy");
  if (mood === "sleepy") asked.add("sleepy");
  if (mood === "surprised") asked.add("round");
  if (mood === "squint" || mood === "thinking") asked.add("squint");
  return (["happy", "sleepy", "read", "big", "squint", "round", "wide"] as const).find((k) => asked.has(k)) ?? "open";
}


/** Where a bot faces and how it carries itself: x and y from -1 to 1 (right and down), the rest optional. */
export interface Pose {
  x: number;
  y: number;
  /** Degrees, clockwise. Left out, it leans a little into the look. */
  roll?: number;
  /** Bigger or smaller, as leaning in or back: 0.1 is a tenth bigger. */
  zoom?: number;
  eyes?: Exclude<EyeForm, "open" | "big">;
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
 * Where points of the face land on the body with the head turned `yaw` and `pitch` degrees (right and
 * down) about the box's centre, seen from PERSPECTIVE away. The face stands DEPTH off the body, so it
 * slides across as it turns, and narrows.
 */
export function projector(yaw: number, pitch: number): (x: number, y: number) => Point {
  const k = (PERSPECTIVE - DEPTH) / PERSPECTIVE;
  const [cy, sy, cp, sp] = [Math.cos(rad(yaw)), Math.sin(rad(yaw)), Math.cos(rad(-pitch)), Math.sin(rad(-pitch))];
  return (x, y) => {
    const [px, py] = [(x - 50) * k, (y - 50) * k];
    const x1 = px * cy + DEPTH * sy;
    const z1 = -px * sy + DEPTH * cy;
    const y2 = py * cp - z1 * sp;
    const z2 = py * sp + z1 * cp;
    const s = PERSPECTIVE / (PERSPECTIVE - z2);
    return [50 + x1 * s, 50 + y2 * s];
  };
}
/** One point of the face, with the head turned that far. */
export const project = (x: number, y: number, yaw: number, pitch: number): Point => projector(yaw, pitch)(x, y);

/** The eyes of a shape, as drawn: how big, and how far apart. */
export function eyesOf(shape: Shape) {
  const scale = shape.face.scale ?? 1;
  return { w: EYE_W * scale, h: EYE_H * scale, gap: shape.face.gap };
}

/**
 * The points of both eyes that have to stay on the body, in the face's own plane: the middle of each
 * (CORE of it). Looking hard over, the rest of an eye slips under the body's edge, which cuts it off.
 */
function eyePoints(shape: Shape, form: EyeForm): Point[] {
  const { w, h, gap } = eyesOf(shape);
  const [fw, fh] = FORMS[form];
  const out: Point[] = [];
  for (const side of [-1, 1]) {
    const [cx, cy] = [shape.face.x + (side * gap) / 2, shape.face.y];
    // All over it: a lobed or spiky shape's notches reach in between a few points.
    for (const fy of [-0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4])
      for (const fx of Math.abs(fy) > 0.35 ? [-0.14, 0, 0.14] : Math.abs(fy) > 0.25 ? [-0.3, 0, 0.3] : [-0.42, -0.21, 0, 0.21, 0.42]) out.push([cx + w * fw * fx * CORE, cy + h * fh * fy * CORE]);
  }
  return out;
}

/**
 * The outline of an eye as drawn in a form, about the middle of an open eye in the face's own plane:
 * round its four rounded corners in turn (the sides run between them), so it's a convex polygon.
 */
const outlines = new Map<string, Point[]>();
function eyeOutline(shape: Shape, look: EyeLook) {
  const key = `${shape.id} ${look}`;
  let out = outlines.get(key);
  if (out) return out;
  const { w: ew, h: eh } = eyesOf(shape);
  const d: Drawn = DRAWN[look];
  const [w, h, cy] = [ew * d.w, eh * d.h, eh * (d.drop ?? 0)];
  // CSS shrinks corners that don't fit, all by the same share.
  let [rt, rb] = [w * (d.top ?? 0.5), w * (d.bottom ?? 0.5)];
  const fit = Math.min(1, h / (rt + rb), w / (2 * rt), w / (2 * Math.max(rb, 1e-9)));
  [rt, rb] = [rt * fit, rb * fit];
  out = [];
  for (const [sx, sy, r, from] of [[1, -1, rt, -90], [1, 1, rb, 0], [-1, 1, rb, 90], [-1, -1, rt, 180]] as const)
    for (let i = 0; i <= 6; i++) {
      const t = rad(from + i * 15);
      out.push([sx * (w / 2 - r) + r * Math.cos(t), cy + sy * (h / 2 - r) + r * Math.sin(t)]);
    }
  outlines.set(key, out);
  return out;
}

/** A shape's edge as points no more than half a unit apart, for how near an eye comes to it. */
const edges = new Map<string, Point[]>();
function edgeOf(shape: Shape) {
  let edge = edges.get(shape.id);
  if (edge) return edge;
  edge = [];
  for (const part of outline(shape.path))
    for (let i = 0; i < part.length; i++) {
      const [[x0, y0], [x1, y1]] = [part[i]!, part[(i + 1) % part.length]!];
      const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.5));
      for (let k = 0; k < n; k++) edge.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
    }
  edges.set(shape.id, edge);
  return edge;
}

/** How far a point is from a convex polygon (clockwise, as drawn on screen), 0 inside it. */
function apart(poly: Point[], [x, y]: Point): number {
  let least = Infinity;
  let outside = false;
  for (let i = 0; i < poly.length; i++) {
    const [[x0, y0], [x1, y1]] = [poly[i]!, poly[(i + 1) % poly.length]!];
    const [ex, ey] = [x1 - x0, y1 - y0];
    if (ex * (y - y0) - ey * (x - x0) < 0) outside = true;
    const t = Math.max(0, Math.min(1, ((x - x0) * ex + (y - y0) * ey) / (ex * ex + ey * ey || 1)));
    least = Math.min(least, Math.hypot(x - x0 - ex * t, y - y0 - ey * t));
  }
  return outside ? least : 0;
}

/**
 * Where an eye lands with the head turned that far and the eyes leading by (lx, ly): its middle on the
 * body, and how the face is stretched there (a 2×2 matrix, a b c d as in CSS). Some of the narrowing a
 * turn would give it (SOFT), and a little smaller the further it's turned away (FAR).
 */
function eyeAt(shape: Shape, side: number, yaw: number, pitch: number, lx: number, ly: number) {
  const at = projector(yaw, pitch);
  const [x, y] = [shape.face.x + (side * eyesOf(shape).gap) / 2, shape.face.y];
  const [px, py] = at(x + lx, y + ly);
  const [ax, ay] = at(x + lx + 1, y + ly);
  const [bx, by] = at(x + lx, y + ly + 1);
  const m = Math.min(1, Math.hypot(yaw / YAW, pitch / PITCH));
  const far = 1 - FAR * m * m;
  return { x, y, px, py, a: (1 + (ax - px - 1) * SOFT) * far, b: (ay - py) * SOFT * far, c: (bx - px) * SOFT * far, d: (1 + (by - py - 1) * SOFT) * far };
}

/**
 * Whether both eyes, drawn in that form with the head turned that far, are on the body with `margin`
 * to spare all round: no point of its edge is nearer either eye than that.
 */
export function eyesFit(shape: Shape, look: EyeLook, yaw: number, pitch: number, lx = 0, ly = 0, margin = MARGIN): boolean {
  const nap = (DRAWN[look] as Drawn).nap ?? 0;
  const edge = edgeOf(shape);
  for (const side of [-1, 1]) {
    const { px, py, a, b, c, d } = eyeAt(shape, side, yaw, pitch, lx, ly);
    if (!covers(shape, px, py + nap)) return false;
    const eye = eyeOutline(shape, look).map(([ex, ey]): Point => [px + a * ex + c * ey, py + nap + b * ex + d * ey]);
    // Only the edge near it can be too near.
    const xs = eye.map((p) => p[0]);
    const ys = eye.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs) - margin, Math.max(...xs) + margin, Math.min(...ys) - margin, Math.max(...ys) + margin];
    for (const p of edge) if (p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1 && apart(eye, p) < margin) return false;
  }
  return true;
}

/** How far inside the edge an eye is at its nearest, to a tenth of a unit (negative: over it). */
export function clearance(shape: Shape, look: EyeLook, yaw: number, pitch: number, lx = 0, ly = 0): number {
  let [lo, hi] = [-3, 30];
  if (!eyesFit(shape, look, yaw, pitch, lx, ly, lo)) return lo;
  while (hi - lo > 0.1) {
    const mid = (lo + hi) / 2;
    if (eyesFit(shape, look, yaw, pitch, lx, ly, mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const DIRECTIONS = 36;
const rooms = new Map<string, number[]>();

/**
 * How far a shape's head can turn one way (`angle` round the clock in radians, 0 = right, clockwise)
 * with its eyes still on its body: the share of a full turn it has room for, from the outline itself.
 */
function reach(shape: Shape, form: EyeForm, angle: number): number {
  const points = eyePoints(shape, form);
  const fits = (m: number) => {
    const at = projector(Math.cos(angle) * YAW * m, Math.sin(angle) * PITCH * m);
    return points.every(([x, y]) => covers(shape, ...at(x, y)));
  };
  // Out from straight ahead a step at a time to the first turn that doesn't fit (a spiky shape can
  // fit again further on, in the next point along: that's no use), then closer in on it.
  let [lo, hi] = [0, 0];
  while (hi < 1 && fits((hi = Math.min(1, hi + 1 / 8)))) lo = hi;
  if (lo === 1) return 1;
  for (let n = 0; n < 3; n++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * That, for each of 36 directions round the clock. Worked out once for each shape and form of eye
 * (ahead of its first look, when the page has had a moment: see `warm`).
 */
export function roomOf(shape: Shape, form: EyeForm = "open"): number[] {
  const key = `${shape.id} ${form}`;
  let room = rooms.get(key);
  if (!room) rooms.set(key, (room = Array.from({ length: DIRECTIONS }, (_, i) => reach(shape, form, (i / DIRECTIONS) * Math.PI * 2))));
  return room;
}

/** Where a bot is headed: the head's turn in degrees, the roll, and the zoom. */
export interface Target {
  yaw: number;
  pitch: number;
  roll: number;
  zoom: number;
}
/** Upright and facing straight out, as its shape is drawn. */
export const AHEAD: Target = { yaw: 0, pitch: 0, roll: 0, zoom: 0 };

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

/** Where a pose takes a shape. At work its eyes are big whenever the pose would have them open or staring, and need the room. */
export function poseTarget(shape: Shape, pose: Pose, atWork = false): Target {
  const [yaw, pitch] = turnTo(shape, pose.x, pose.y, eyesFor(pose, atWork) ?? "open");
  // It leans by where it means to look, so a shape with little room to turn its head still moves.
  return { yaw, pitch, roll: pose.roll ?? clamp1(pose.x) * LEAN, zoom: pose.zoom ?? 0 };
}

/** The form a pose's eyes take: its own, or at work the big eyes in place of open or staring ones. */
export function eyesFor(pose: Pose | undefined, atWork: boolean): Exclude<EyeForm, "open"> | undefined {
  return atWork && (!pose?.eyes || pose.eyes === "wide") ? "big" : pose?.eyes;
}

/** How a bot rests: turned up and away to its left (our right), rolled over the other way. */
export const RESTING = { x: 0.6, y: -0.3, roll: -21 } satisfies Pose;
const rests = new Map<string, Target>();
/** Where a shape comes to rest: RESTING, as far as it has the room to turn. */
export function restOf(shape: Shape): Target {
  let rest = rests.get(shape.id);
  if (!rest) {
    // Its room that one way only: this is on the way to a bot's first drawing.
    const m = Math.hypot(RESTING.x, RESTING.y);
    const k = Math.min(m, reach(shape, "open", Math.atan2(RESTING.y, RESTING.x))) / m;
    rests.set(shape.id, (rest = { yaw: RESTING.x * k * YAW, pitch: RESTING.y * k * PITCH, roll: RESTING.roll, zoom: 0 }));
  }
  return rest;
}

/**
 * Where a bot following the pointer turns: straight toward it, (dx, dy) from between its eyes on an
 * avatar `width` across. Most of the way over within a few eye-widths and all of it by the edge,
 * leaning into it as it goes.
 */
export function aimTarget(shape: Shape, dx: number, dy: number, width: number): Target {
  const dist = Math.hypot(dx, dy);
  if (!dist || !width) return AHEAD;
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
/** A rig facing straight ahead, or come to rest on a target. */
export function newRig(at: Target = AHEAD): Rig {
  const rig: Rig = { yaw: axis(), pitch: axis(), bodyYaw: axis(), bodyPitch: axis(), roll: axis(), zoom: axis(), leadX: axis(), leadY: axis(), spin: 0 };
  snap(rig, at);
  return rig;
}

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

const n = (v: number, digits = 2) => {
  const s = v.toFixed(digits);
  return Number(s) === 0 ? "0" : s;
};

/**
 * A rig as what to draw, for a shape on an avatar `size` px across, its eyes drawn in `look`: the
 * whole bot (rolled, leant and zoomed, about its middle), the body (turned part of the way, in
 * perspective), and each eye where the head's turn puts it on that body: slid across, narrowed a
 * little, and smaller the further it has turned away (FAR). The eyes are worked out here (a flat
 * transform each, `project` at the eye and how it stretches there) rather than turned by the browser,
 * so the body stays one layer with the face painted on it. Straight ahead everything is "none".
 * `back` is true while a turn right round shows the body's back, the face out of sight.
 *
 * The eyes never go nearer the edge than MARGIN: where the head's turn, a swing past, the eyes darting
 * ahead or a nod would take them nearer, they go only as far along as they still fit, the body
 * turning on under them. Anywhere else this draws them just as it always has.
 */
export function frame(rig: Rig, shape: Shape, size: number, look: EyeLook = "open"): { whole: string; body: string; left: string; right: string; back: boolean } {
  const u = size / 100;
  const rest = restOf(shape);
  // Leaning into a turn from where it rests, and settling a little to look down: never lifting to look up.
  const tx = ((rig.bodyYaw.x - rest.yaw) / YAW) * 2.6 * u;
  const ty = (Math.max(0, rig.bodyPitch.x) / PITCH) * 1.4 * u;
  const move = Number(n(tx)) || Number(n(ty)) ? `translate(${n(tx)}px, ${n(ty)}px) ` : "";
  const whole = move || rig.roll.x || rig.zoom.x ? `${move}rotate(${n(rig.roll.x)}deg) scale(${n(1 + rig.zoom.x, 4)})` : "none";
  const by = rig.bodyYaw.x * BODY_TURN + rig.spin;
  const bp = rig.bodyPitch.x * BODY_TURN;
  const body = by || bp ? `perspective(${n(PERSPECTIVE * u, 1)}px) rotateX(${n(-bp)}deg) rotateY(${n(by)}deg)` : "none";
  let [yaw, pitch, lx, ly] = [rig.yaw.x, rig.pitch.x, rig.leadX.x, rig.leadY.x];
  const facing = ((by % 360) + 360) % 360;
  const back = facing > 90 && facing < 270;
  if (!eyesFit(shape, look, yaw, pitch, lx, ly)) {
    // As far along toward where it is as they fit (nearer straight ahead, where they always do).
    let [lo, hi] = [0, 1];
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      if (eyesFit(shape, look, yaw * mid, pitch * mid, lx * mid, ly * mid)) lo = mid;
      else hi = mid;
    }
    [yaw, pitch, lx, ly] = [yaw * lo, pitch * lo, lx * lo, ly * lo];
  }
  if (!yaw && !pitch && !lx && !ly) return { whole, body, left: "none", right: "none", back };
  const eye = (side: number) => {
    // Where its middle lands (the eyes' lead is a slide within the face), and how the face is stretched there.
    const { x, y, px, py, a, b, c, d } = eyeAt(shape, side, yaw, pitch, lx, ly);
    return `matrix(${n(a, 4)}, ${n(b, 4)}, ${n(c, 4)}, ${n(d, 4)}, ${n((px - x) * u)}, ${n((py - y) * u)})`;
  };
  return { whole, body, left: eye(-1), right: eye(1), back };
}

/**
 * Works out, one at a time, what a shape's first looks would otherwise stop to work out: how far it
 * can turn with its eyes in each form. `later` runs each step when there's time to spare.
 */
export function warm(shape: Shape, later: (step: () => void) => void) {
  const forms = (Object.keys(FORMS) as EyeForm[]).filter((form) => !rooms.has(`${shape.id} ${form}`));
  const next = () => {
    const form = forms.shift();
    if (!form) return;
    roomOf(shape, form);
    if (forms.length) later(next);
  };
  if (forms.length) later(next);
}

const rested = new Map<string, ReturnType<typeof frame>>();
/** How a shape is drawn at rest, at a size: what a still bot shows, with nothing run to put it there. */
export function restFrame(shape: Shape, size: number) {
  const key = `${shape.id} ${size}`;
  let at = rested.get(key);
  if (!at) rested.set(key, (at = frame(newRig(restOf(shape)), shape, size)));
  return at;
}
