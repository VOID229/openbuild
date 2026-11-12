// OpenBots: the shapes and colours a bot can wear. Each shape is an SVG path in a 100×100 box, drawn
// upright and facing straight out, plus where its face sits on it. How a bot stands at rest (turned
// a little and rolled over) and how it moves are lib/bots/rig.ts's.
//
// The thirteen outlines are traced: each is a list of radii from the middle of the box, evenly spaced
// clockwise from the top, folded by the shape's own symmetry (a flower is one half-petal, twelve
// times) and joined into one smooth closed curve. The square and the triangle are drawn rounder than
// their tracings, to sit with the rest. They all cover the same area, so no bot looks
// bigger than another, and each sits by the middle of its bounding box.

export interface Face {
  /** Centre between the eyes. */
  x: number;
  y: number;
  /** Distance between the eyes' centres. */
  gap: number;
  /** Eye size, 1 = the default (EYE_W × EYE_H in rig.ts). How far the head can turn is worked out from the outline. */
  scale?: number;
}

export interface Shape {
  id: string;
  label: string;
  path: string;
  face: Face;
}

type Point = [number, number];

const TAU = Math.PI * 2;
const r1 = (n: number) => Math.round(n * 10) / 10;

/** A smooth closed curve through the points (Catmull-Rom, drawn as cubic Béziers). */
function smooth(points: Point[]): string {
  const n = points.length;
  const at = (i: number) => points[((i % n) + n) % n]!;
  let d = `M${r1(at(0)[0])} ${r1(at(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${r1(c1[0])} ${r1(c1[1])} ${r1(c2[0])} ${r1(c2[1])} ${r1(p2[0])} ${r1(p2[1])}`;
  }
  return `${d}Z`;
}

/**
 * An outline from its radii about (50, 50), evenly spaced clockwise from straight up. The radii
 * cover one part of it, repeated `fold` times round; unless `mirror` is off, each part is its own
 * mirror image and they cover half of it, both ends included. A fold of 0 is a circle of the one radius.
 */
function traced(radii: number[], fold = 1, mirror = true): string {
  const part = fold === 0 ? Array.from({ length: 48 }, () => radii[0]!) : mirror ? [...radii, ...radii.slice(1, -1).reverse()] : radii;
  const all = Array.from({ length: Math.max(fold, 1) }, () => part).flat();
  return smooth(all.map((r, i) => { const t = (i / all.length) * TAU; return [50 + Math.sin(t) * r, 50 - Math.cos(t) * r] as Point; }));
}

export const SHAPES: Shape[] = [
  {
    id: "blob",
    label: "Blob",
    // A plain disc.
    path: traced([35.8], 0),
    face: { x: 50, y: 50.2, gap: 22.3, scale: 1.11 },
  },
  {
    id: "cloud",
    label: "Cloud",
    // Three puffs over a flatter, bumpy underside; a little lopsided, as drawn.
    path: traced([31.4, 30.4, 29.6, 28.7, 28.8, 29.9, 31.1, 32, 32.9, 33.8, 34.3, 34.9, 35.3, 35.5, 35.6, 35.6, 35.5, 35.2, 34.8, 34.3, 33.5, 34, 35.7, 37.6, 38.9, 40, 40.9, 41.5, 42.2, 42.4, 42.3, 42.2, 41.9, 41.1, 40.2, 39.1, 37.8, 36.2, 34.5, 32.4, 31.1, 31.3, 31.8, 32.1, 32.4, 32.7, 32.8, 33, 33, 33, 32.6, 32.6, 32.4, 32.1, 31.7, 31.2, 31.3, 33.3, 35.4, 37, 38.6, 39.8, 40.9, 41.6, 42.2, 42.6, 42.9, 42.8, 42.5, 42, 41.4, 40.5, 39.4, 38, 36.5, 34.7, 32.7, 31.8, 32.5, 33.1, 33.9, 34.4, 34.8, 35.2, 35.5, 35.6, 35.6, 35.7, 35.6, 35.3, 35.1, 34.5, 34.2, 33.5, 32.9, 32.2], 1, false),
    face: { x: 50, y: 52.7, gap: 19.3, scale: 1.06 },
  },
  {
    id: "square",
    label: "Square",
    // A square with round corners and a little give in its sides (a squircle), softer than traced.
    path: traced([32.9, 33, 33.2, 33.5, 34, 34.6, 35.4, 36.2, 37, 37.8, 38.5, 39, 39.1], 4),
    face: { x: 50, y: 53.6, gap: 16.8 },
  },
  {
    id: "sparkle",
    label: "Sparkle",
    // A four-pointed sparkle, its arms uneven and leaning.
    path: traced([39.6, 41.7, 43.5, 44.5, 44.9, 44.6, 43.5, 41.6, 39.6, 37.2, 35, 32.8, 30.6, 29, 27.2, 26.1, 25, 26.2, 27.4, 29.1, 31, 32.8, 35, 37.3, 39.5, 41.7, 43.4, 44.6, 45, 44.5, 43.5, 41.6, 39.5, 37.2, 34.8, 32.8, 30.9, 29.1, 27.6, 26.1, 24.9, 26.2, 27.4, 29.1, 31, 32.8, 34.9, 37.3, 39.6, 41.7, 43.3, 44.5, 44.9, 44.6, 43.4, 41.6, 39.5, 37.1, 34.8, 32.8, 30.6, 28.8, 27.2, 26.1, 25, 26.2, 27.4, 28.9, 31, 32.8, 34.9, 37.3, 39.5, 41.7, 43.3, 44.5, 45, 44.6, 43.5, 41.6, 39.5, 37.3, 34.8, 32.8, 30.9, 29.2, 27.6, 26.1, 25, 26.2, 27.4, 29.1, 31, 32.8, 34.9, 37.3], 1, false),
    face: { x: 50, y: 49.8, gap: 19.2, scale: 1.03 },
  },
  {
    id: "clover",
    label: "Clover",
    // Four round leaves.
    path: traced([29, 30.4, 31.8, 33.2, 34.4, 35.6, 36.5, 37.3, 38, 38.5, 39, 39.2, 39.2], 4),
    face: { x: 50, y: 49.1, gap: 19, scale: 0.96 },
  },
  {
    id: "heart",
    label: "Heart",
    // A heart, wide and soft at the point.
    path: traced([29, 30.1, 31.5, 32.8, 34.1, 35.3, 36.4, 37.5, 38.7, 39.6, 40.6, 41.4, 42.1, 42.6, 43.1, 43.4, 43.6, 43.5, 43.3, 43, 42.5, 41.8, 41.1, 40, 39, 37.8, 36.3, 35, 33.6, 32.4, 31.1, 30.4, 29.8, 29.4, 29, 28.7, 28.5, 28.5, 28.7, 29, 29.4, 29.8, 30.6, 31.5, 32.2, 32.9, 33.3, 33.6, 33.8]),
    face: { x: 50, y: 52, gap: 18.8, scale: 0.96 },
  },
  {
    id: "flower",
    label: "Flower",
    // Six round petals.
    path: traced([39.1, 38.9, 38.5, 37.7, 36.6, 35.2, 33.4, 31.2, 28.6], 6),
    face: { x: 50, y: 54.9, gap: 16.4 },
  },
  {
    id: "teardrop",
    label: "Teardrop",
    // A drop: round below, coming to a soft point on top.
    path: traced([40.8, 40.6, 39.9, 38.6, 37.2, 35.8, 34.6, 33.4, 32.5, 31.8, 31.2, 30.8, 30.5, 30.3, 30.3, 30.4, 30.6, 31, 31.3, 31.7, 32.1, 32.4, 32.9, 33.3, 33.6, 34, 34.3, 34.8, 35.2, 35.7, 36.1, 36.6, 37, 37.3, 37.7, 38, 38.3, 38.7, 39, 39.3, 39.5, 39.7, 39.9, 40.1, 40.3, 40.4, 40.4, 40.5, 40.6]),
    face: { x: 50, y: 56.9, gap: 18.1, scale: 1.03 },
  },
  {
    id: "tablet",
    label: "Tablet",
    // A lozenge lying on its side.
    path: traced([27.5, 27.6, 27.8, 28, 28.5, 29.1, 29.8, 30.7, 31.8, 32.9, 34, 35, 36, 36.9, 37.8, 38.7, 39.4, 40.1, 40.8, 41.3, 41.7, 42.1, 42.3, 42.4, 42.6], 2),
    face: { x: 50, y: 50.6, gap: 25.2, scale: 1.09 },
  },
  {
    id: "wedge",
    label: "Wedge",
    // A triangle with round corners and gently curved sides, wide at the base: the traced one softened.
    path: traced([34.7, 34.7, 34.4, 34, 33.6, 33, 32.3, 31.6, 30.9, 30.3, 29.7, 29.1, 28.7, 28.3, 28.1, 27.9, 27.9, 28.1, 28.4, 28.8, 29.4, 30.1, 31.1, 32.2, 33.5, 35, 36.6, 38.3, 40, 41.7, 43.1, 44.3, 45.1, 45.5, 45.5, 45.1, 44.3, 43.3, 42.1, 40.9, 39.7, 38.6, 37.6, 36.7, 36, 35.4, 35, 34.7, 34.7]),
    face: { x: 50, y: 57.2, gap: 19, scale: 1.06 },
  },
  {
    id: "house",
    label: "House",
    // A square with a roof.
    path: traced([35.5, 35.3, 34.8, 33.9, 33.1, 32.2, 31.6, 31, 30.8, 30.5, 30.4, 30.5, 30.7, 30.9, 31.4, 32, 32.6, 33.1, 33.5, 33.8, 33.8, 33.9, 33.9, 33.8, 33.7, 33.8, 34, 34.4, 34.9, 35.6, 36.5, 37.6, 38.9, 40.5, 42.5, 44.2, 45.2, 45.4, 44.4, 42.6, 41, 39.5, 38.4, 37.4, 36.7, 36.2, 35.8, 35.5, 35.5]),
    face: { x: 50, y: 56.4, gap: 18.2 },
  },
  {
    id: "star",
    label: "Star",
    // Six stubby points.
    path: traced([43.7, 43.2, 41.8, 38.2, 34.5, 31.6, 29.4, 28.4, 28], 6),
    face: { x: 50, y: 55.3, gap: 19.2, scale: 1.04 },
  },
  {
    id: "hex",
    label: "Hex",
    // A hexagon standing on a point.
    path: traced([37.8, 37.6, 37, 36.2, 35.5, 35, 34.6, 34.3, 34.3], 6),
    face: { x: 50, y: 54.3, gap: 24.1, scale: 1.19 },
  },
];

/**
 * The shapes bots wore before these, by the one that takes each one's place: a bot saved (or sent by
 * a friend's server) as one of them keeps a look, the nearest to what it had.
 */
const FORMER: Record<string, string> = {
  orb: "blob", puff: "cloud", tile: "square", spark: "sparkle", bean: "tablet", drop: "teardrop", egg: "teardrop", pill: "tablet",
  pebble: "wedge", gem: "house", burst: "star", jelly: "house", kitty: "blob", sprout: "blob",
};

/** Every shape by its id, and by the ids of the former shapes it stands in for. */
export const SHAPE_BY_ID = new Map<string, Shape>(SHAPES.map((s) => [s.id, s]));
for (const [was, now] of Object.entries(FORMER)) SHAPE_BY_ID.set(was, SHAPE_BY_ID.get(now)!);

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
/** A one-off move, always in place (never a hop): a turn right round, a rock from side to side, a swell, a nod. A stretch is waking up from a doze, and a jelly is the wobble of a bot that's pleased: squashed wide, then tall, then settled. */
export type Action = "spin" | "wiggle" | "pop" | "nod" | "stretch" | "jelly";

export interface BotLook {
  shape: string;
  color: string;
}

export const shapeOf = (look: BotLook): Shape => SHAPE_BY_ID.get(look.shape) ?? SHAPES[0]!;
export const colorOf = (look: BotLook): BotColor => COLOR_BY_ID.get(look.color) ?? COLORS[7]!;

/** A look for a new bot: any shape, any colour but white and gray (they read as disabled). */
export function randomLook(): BotLook {
  const shapes = SHAPES;
  const colors = COLORS.filter((c) => c.id !== "white" && c.id !== "gray");
  return { shape: shapes[Math.floor(Math.random() * shapes.length)]!.id, color: colors[Math.floor(Math.random() * colors.length)]!.id };
}
