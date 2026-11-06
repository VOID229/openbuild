// OpenBots: the shapes and colours a bot can wear. Each shape is an SVG path in a 100×100 box plus
// where its face sits, so the eyes land on the body however it's drawn (some shapes lean or tilt).
// Most outlines are generated: a radius around the centre (a puff's lobes, a star's points) or a
// polygon with soft corners, then smoothed into one closed curve. A little wobble keeps them from
// looking machine-made.

export interface Face {
  /** Centre between the eyes. */
  x: number;
  y: number;
  /** Distance between the eyes' centres. */
  gap: number;
  /** Eye size, 1 = the default 7.5 × 16. */
  scale?: number;
}

export interface Shape {
  id: string;
  label: string;
  path: string;
  /** Drawn on top of the body in a fixed colour (a sprout's leaf). */
  extra?: { path: string; fill: string };
  face: Face;
  /** Special shapes sit at the end of the picker, like seasonal ones. */
  special?: boolean;
}

type Point = [number, number];

const TAU = Math.PI * 2;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** A smooth closed curve through the points (Catmull-Rom, drawn as cubic Béziers). */
function smooth(points: Point[], tension = 1): string {
  const n = points.length;
  const at = (i: number) => points[((i % n) + n) % n]!;
  let d = `M${r1(at(0)[0])} ${r1(at(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1: Point = [p1[0] + ((p2[0] - p0[0]) / 6) * tension, p1[1] + ((p2[1] - p0[1]) / 6) * tension];
    const c2: Point = [p2[0] - ((p3[0] - p1[0]) / 6) * tension, p2[1] - ((p3[1] - p1[1]) / 6) * tension];
    d += `C${r1(c1[0])} ${r1(c1[1])} ${r1(c2[0])} ${r1(c2[1])} ${r1(p2[0])} ${r1(p2[1])}`;
  }
  return `${d}Z`;
}

/** Points around (cx, cy) at the radius `r(θ)`, θ = 0 pointing right, turning clockwise. */
function polar(r: (t: number) => number, { n = 72, rotate = 0, cx = 50, cy = 50, sx = 1, sy = 1 } = {}): Point[] {
  const rot = (rotate * Math.PI) / 180;
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * TAU;
    const rr = r(t);
    return [cx + Math.cos(t + rot) * rr * sx, cy + Math.sin(t + rot) * rr * sy] as Point;
  });
}

/** A gentle irregularity, the same every time for the same seed. */
const wobble = (seed: number, amount = 1.2) => (t: number) => amount * (Math.sin(3 * t + seed) * 0.6 + Math.cos(2 * t + seed * 1.7) * 0.4);

/** A polygon with rounded corners: each corner is cut back by `round` and bent through the vertex. */
function roundedPolygon(vertices: Point[], round: number): string {
  const n = vertices.length;
  const at = (i: number) => vertices[((i % n) + n) % n]!;
  const toward = (a: Point, b: Point, dist: number): Point => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.min(dist, len / 2) / len;
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
  };
  let d = "";
  for (let i = 0; i < n; i++) {
    const v = at(i);
    const a = toward(v, at(i - 1), round);
    const b = toward(v, at(i + 1), round);
    d += `${i === 0 ? "M" : "L"}${r1(a[0])} ${r1(a[1])}Q${r1(v[0])} ${r1(v[1])} ${r1(b[0])} ${r1(b[1])}`;
  }
  return `${d}Z`;
}

/** The corners of a regular polygon around (50, 50). */
function regular(sides: number, radius: number, rotate: number, cx = 50, cy = 50): Point[] {
  const rot = (rotate * Math.PI) / 180;
  return Array.from({ length: sides }, (_, i) => {
    const t = rot + (i / sides) * TAU - Math.PI / 2;
    return [cx + Math.cos(t) * radius, cy + Math.sin(t) * radius] as Point;
  });
}

/** A rectangle's corners, turned about its centre. */
function rect(w: number, h: number, rotate: number, cx = 50, cy = 50): Point[] {
  const rot = (rotate * Math.PI) / 180;
  return ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as Point[]).map(([x, y]) => [
    cx + x * Math.cos(rot) - y * Math.sin(rot),
    cy + x * Math.sin(rot) + y * Math.cos(rot),
  ]);
}

const w = wobble;

export const SHAPES: Shape[] = [
  {
    id: "orb",
    label: "Orb",
    path: smooth(polar((t) => 39 + w(1, 1)(t), { n: 48 })),
    face: { x: 57, y: 45, gap: 15 },
  },
  {
    id: "puff",
    label: "Puff",
    // Five lobes with soft dips between them, like a cloud.
    path: smooth(polar((t) => 32 + 9 * Math.pow(Math.abs(Math.cos(2.5 * t)), 0.7) + w(2, 1.4)(t), { n: 90, rotate: 8 })),
    face: { x: 56, y: 47, gap: 15 },
  },
  {
    id: "tile",
    label: "Tile",
    path: roundedPolygon(rect(64, 60, -14), 17),
    face: { x: 55, y: 48, gap: 15 },
  },
  {
    id: "spark",
    label: "Spark",
    path: smooth(polar((t) => 30 + 15 * Math.pow((Math.cos(4 * t) + 1) / 2, 1.6) + w(3, 0.8)(t), { n: 96, rotate: 12 })),
    face: { x: 52, y: 48, gap: 13 },
  },
  {
    id: "clover",
    label: "Clover",
    path: smooth(polar((t) => 30 + 11 * Math.pow(Math.abs(Math.cos(2 * t)), 0.55) + w(4, 1)(t), { n: 96, rotate: 22 })),
    face: { x: 54, y: 48, gap: 14 },
  },
  {
    id: "bean",
    label: "Bean",
    // A lying-down kidney: wide, with a dent in its top edge.
    path: smooth(polar((t) => 37 - 9 * Math.exp(-Math.pow(Math.atan2(Math.sin(t + Math.PI / 2), Math.cos(t + Math.PI / 2)), 2) / 0.18) + w(5, 1)(t), { n: 72, sx: 1.12, sy: 0.82, rotate: -10 })),
    face: { x: 60, y: 52, gap: 15 },
  },
  {
    id: "flower",
    label: "Flower",
    path: smooth(polar((t) => 33 + 8.5 * Math.cos(6 * t) + w(6, 1)(t), { n: 96, rotate: 4 })),
    face: { x: 53, y: 49, gap: 13 },
  },
  {
    id: "drop",
    label: "Drop",
    // A droplet tipped over to the upper left.
    path: smooth(polar((t) => 33 + 14 * Math.pow(Math.max(0, Math.cos(t - (-2.4))), 5) + w(7, 0.8)(t), { n: 80, cy: 53 })),
    face: { x: 56, y: 52, gap: 14 },
  },
  {
    id: "egg",
    label: "Egg",
    // Narrower at the top than the bottom.
    path: smooth(Array.from({ length: 64 }, (_, i) => {
      const t = (i / 64) * TAU;
      return [50 + Math.cos(t) * 33 * (1 + 0.2 * Math.sin(t)), 51 + Math.sin(t) * 41] as Point;
    })),
    face: { x: 55, y: 56, gap: 14 },
  },
  {
    id: "pill",
    label: "Pill",
    path: roundedPolygon(rect(78, 48, -10), 24),
    face: { x: 58, y: 47, gap: 15 },
  },
  {
    id: "pebble",
    label: "Pebble",
    path: roundedPolygon(regular(3, 47, -24, 48, 54), 17),
    face: { x: 54, y: 50, gap: 13 },
  },
  {
    id: "gem",
    label: "Gem",
    path: roundedPolygon(regular(5, 42, 12, 50, 52), 14),
    face: { x: 55, y: 50, gap: 15 },
  },
  {
    id: "burst",
    label: "Burst",
    // A wobbly splat: eight soft points of uneven length.
    path: smooth(polar((t) => 31 + 9 * Math.cos(7 * t) + 2.5 * Math.sin(3 * t + 1) + w(8, 1)(t), { n: 112, rotate: -6 })),
    face: { x: 52, y: 50, gap: 13 },
  },
  {
    id: "jelly",
    label: "Jelly",
    // Rounded on top, a little skirt of bumps along the bottom.
    path: smooth(
      ([...polar(() => 36, { n: 28, cy: 50 }).filter(([, y]) => y <= 50), [86, 62], [84, 77], [76, 82], [68, 76], [59, 83], [50, 77], [41, 83], [32, 76], [24, 82], [16, 77], [14, 62]] as Point[]).sort(
        (a, b) => Math.atan2(a[1] - 55, a[0] - 50) - Math.atan2(b[1] - 55, b[0] - 50),
      ),
      0.9,
    ),
    face: { x: 55, y: 47, gap: 15 },
  },
  {
    id: "kitty",
    label: "Kitty",
    special: true,
    path:
      smooth(polar((t) => 34 + w(9, 0.8)(t), { n: 48, cy: 56, sx: 1.08, sy: 0.96 })) +
      roundedPolygon([[19, 40], [24, 12], [44, 30]], 6) +
      roundedPolygon([[56, 30], [76, 12], [81, 40]], 6),
    face: { x: 52, y: 58, gap: 16 },
  },
  {
    id: "sprout",
    label: "Sprout",
    special: true,
    path: smooth(polar((t) => 35 + w(10, 1)(t), { n: 48, cy: 56 })),
    extra: {
      // A stem and one leaf, curling off to the right.
      path: "M50 23c-1-6 1-11 5-14 1 4 0 9-3 14zM54 16c6-7 16-8 22-4-4 7-14 10-22 4z",
      fill: "#4fae55",
    },
    face: { x: 56, y: 56, gap: 15 },
  },
];

export const SHAPE_BY_ID = new Map(SHAPES.map((s) => [s.id, s]));

export interface BotColor {
  id: string;
  label: string;
  hex: string;
}

export const COLORS: BotColor[] = [
  { id: "white", label: "White", hex: "#f2f2ef" },
  { id: "brown", label: "Brown", hex: "#a06d43" },
  { id: "red", label: "Red", hex: "#ec4a48" },
  { id: "orange", label: "Orange", hex: "#f06c32" },
  { id: "amber", label: "Amber", hex: "#f2a03c" },
  { id: "green", label: "Green", hex: "#4cc172" },
  { id: "teal", label: "Teal", hex: "#40b5a6" },
  { id: "blue", label: "Blue", hex: "#3f87f5" },
  { id: "purple", label: "Purple", hex: "#8b5cf6" },
  { id: "pink", label: "Pink", hex: "#ea4f9b" },
  { id: "gray", label: "Gray", hex: "#8b8b88" },
];

export const COLOR_BY_ID = new Map(COLORS.map((c) => [c.id, c]));

/** An expression a bot can hold or flash. */
export type Mood = "idle" | "happy" | "thinking" | "sleepy" | "surprised" | "love" | "wink" | "squint";
/** A one-off move. */
export type Action = "hop" | "spin" | "wiggle" | "squish" | "nod";

export interface BotLook {
  shape: string;
  color: string;
}

export const shapeOf = (look: BotLook): Shape => SHAPE_BY_ID.get(look.shape) ?? SHAPES[0]!;
export const colorOf = (look: BotLook): BotColor => COLOR_BY_ID.get(look.color) ?? COLORS[7]!;

/** A look for a new bot: any regular shape, any colour but white and gray (they read as disabled). */
export function randomLook(): BotLook {
  const shapes = SHAPES.filter((s) => !s.special);
  const colors = COLORS.filter((c) => c.id !== "white" && c.id !== "gray");
  return { shape: shapes[Math.floor(Math.random() * shapes.length)]!.id, color: colors[Math.floor(Math.random() * colors.length)]!.id };
}
