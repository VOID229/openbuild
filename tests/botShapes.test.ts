// The shapes a bot can wear: the thirteen, each drawn upright in its box and all the same size by
// area, with a face that sits on it; and a bot saved with one of the former shapes keeps a look.
import { expect, test } from "bun:test";
import { COLOR_BY_ID, randomLook, SHAPE_BY_ID, SHAPES, shapeOf } from "../src/lib/bots/looks";
import { eyesOf, FORMS, inside, outline } from "../src/lib/bots/rig";

/** A shape's outline as one polygon, with its bounding box and area. */
function measure(path: string) {
  const [points] = outline(path);
  const xs = points!.map((p) => p[0]);
  const ys = points!.map((p) => p[1]);
  let area = 0;
  for (let i = 0; i < points!.length; i++) {
    const [x0, y0] = points![i]!;
    const [x1, y1] = points![(i + 1) % points!.length]!;
    area += (x0 * y1 - x1 * y0) / 2;
  }
  return { points: points!, left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), area: Math.abs(area) };
}

test("there are thirteen shapes, each one closed curve", () => {
  expect(SHAPES.map((s) => s.id)).toEqual(["blob", "cloud", "square", "sparkle", "clover", "heart", "flower", "teardrop", "tablet", "wedge", "house", "star", "hex"]);
  expect(new Set(SHAPES.map((s) => s.label)).size).toBe(13);
  for (const shape of SHAPES) {
    expect(shape.path).toMatch(/^M[\d. -]+(C[\d. -]+)+Z$/);
    expect(outline(shape.path).length).toBe(1);
  }
});

test("they're all the same size by area, sit by the middle of their bounding box, and stay inside the box", () => {
  const blob = measure(SHAPES[0]!.path);
  for (const shape of SHAPES) {
    const m = measure(shape.path);
    // No bot looks bigger than another: within a few percent of the disc's area.
    expect(Math.abs(m.area / blob.area - 1)).toBeLessThan(0.05);
    expect((m.left + m.right) / 2).toBeCloseTo(50, 0);
    expect((m.top + m.bottom) / 2).toBeCloseTo(50, 0);
    for (const edge of [m.left, m.top]) expect(edge).toBeGreaterThan(4);
    for (const edge of [m.right, m.bottom]) expect(edge).toBeLessThan(96);
    // Rolled over about the middle, as it rests and as it works, no corner swings far out of the box.
    expect(Math.max(...m.points.map(([x, y]) => Math.hypot(x - 50, y - 50)))).toBeLessThan(51);
  }
});

test("each has its own proportions: a disc, a square, a lozenge twice as wide as tall, a tall star", () => {
  const size = Object.fromEntries(SHAPES.map((s) => { const m = measure(s.path); return [s.id, { w: m.right - m.left, h: m.bottom - m.top }]; }));
  const ratio = (id: string) => size[id]!.w / size[id]!.h;
  expect(ratio("blob")).toBeCloseTo(1, 2);
  expect(ratio("square")).toBeCloseTo(1, 1);
  expect(ratio("clover")).toBeCloseTo(1, 1);
  expect(ratio("tablet")).toBeGreaterThan(1.5);
  expect(ratio("cloud")).toBeGreaterThan(1.2);
  expect(ratio("heart")).toBeGreaterThan(1.15);
  expect(ratio("wedge")).toBeGreaterThan(1.1);
  // A hexagon, a star and a flower stand on a point: taller than wide, as six-fold things are.
  for (const id of ["hex", "star", "flower"]) expect(ratio(id)).toBeCloseTo(Math.sqrt(3) / 2, 1);
  expect(ratio("teardrop")).toBeLessThan(0.9);
  // The disc is about 72 across; the pointed ones reach further to cover the same area, and the
  // triangle, rounder, a little less far.
  expect(size.blob!.w).toBeCloseTo(71.6, 0);
  for (const id of ["star", "sparkle", "tablet"]) expect(Math.max(size[id]!.w, size[id]!.h)).toBeGreaterThan(size.blob!.w + 8);
  expect(size.wedge!.w).toBeGreaterThan(size.blob!.w + 6);
});

/** How tightly an outline bends at its sharpest: the radius of the circle through points 6 units of its length apart. */
function tightest(path: string) {
  const [points] = outline(path);
  const lengths = [0];
  for (let i = 1; i <= points!.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(points![i % points!.length]![0] - points![i - 1]![0], points![i % points!.length]![1] - points![i - 1]![1]));
  const total = lengths.at(-1)!;
  const at = (s: number): [number, number] => {
    s = ((s % total) + total) % total;
    const i = lengths.findIndex((l) => l > s) - 1;
    const f = (s - lengths[i]!) / (lengths[i + 1]! - lengths[i]!);
    const [a, b] = [points![i]!, points![(i + 1) % points!.length]!];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  let least = Infinity;
  for (let s = 0; s < total; s += 0.5) {
    const [a, b, c] = [at(s - 6), at(s), at(s + 6)];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    // Only where it bends outward, round a corner: a notch between petals doesn't count.
    if (cross <= 0) continue;
    least = Math.min(least, (Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1]) * Math.hypot(c[0] - a[0], c[1] - a[1])) / (2 * cross));
  }
  return least;
}

test("the square and the triangle have round corners, softer than the house's or the hexagon's", () => {
  const bend = Object.fromEntries(SHAPES.map((s) => [s.id, tightest(s.path)]));
  // A disc bends the same all round, by its radius.
  expect(bend.blob!).toBeGreaterThan(30);
  for (const id of ["square", "wedge"]) {
    expect(bend[id]!).toBeGreaterThan(12);
    expect(bend[id]!).toBeGreaterThan(bend.house!);
    expect(bend[id]!).toBeGreaterThan(bend.hex!);
  }
  // Still a square, though: its corners stand out from its sides, as a disc's don't.
  const [square] = outline(SHAPES.find((s) => s.id === "square")!.path);
  const reach = square!.map(([x, y]) => Math.hypot(x - 50, y - 50));
  expect(Math.max(...reach) / Math.min(...reach)).toBeGreaterThan(1.15);
});

test("all but the cloud and the sparkle are their own mirror image", () => {
  // How much of the box is in the shape on one side of the middle and not on the other.
  const lopsided = (path: string) => {
    const parts = outline(path);
    let off = 0;
    for (let x = 0.5; x < 50; x++) for (let y = 0.5; y < 100; y++) if (inside(parts, x, y) !== inside(parts, 100 - x, y)) off++;
    return off / 5000;
  };
  for (const shape of SHAPES) {
    const even = shape.id !== "cloud" && shape.id !== "sparkle";
    expect({ id: shape.id, even: lopsided(shape.path) < (even ? 0.004 : 1) && (even || lopsided(shape.path) > 0.02) }).toEqual({ id: shape.id, even: true });
  }
});

test("every face sits on its shape, level and in the middle, with room for its eyes at their biggest", () => {
  for (const shape of SHAPES) {
    const parts = outline(shape.path);
    const { w, h, gap } = eyesOf(shape);
    expect(shape.face.x).toBe(50);
    expect(Math.abs(shape.face.y - 50)).toBeLessThan(8);
    // Apart, even at work when they're big.
    expect(gap).toBeGreaterThan(w * FORMS.big[0] + 1);
    for (const side of [-1, 1])
      for (const [dx, dy] of [[0, 0], [-w / 2, 0], [w / 2, 0], [0, -h / 2], [0, h / 2], [(-w * FORMS.big[0]) / 2, 0], [(w * FORMS.big[0]) / 2, 0], [0, (-h * FORMS.big[1]) / 2], [0, (h * FORMS.big[1]) / 2]] as const)
        expect({ id: shape.id, on: inside(parts, shape.face.x + (side * gap) / 2 + dx, shape.face.y + dy) }).toEqual({ id: shape.id, on: true });
  }
});

test("a bot saved with one of the former shapes keeps a look: the shape that took its place", () => {
  const was = { orb: "blob", puff: "cloud", tile: "square", spark: "sparkle", clover: "clover", bean: "tablet", flower: "flower", drop: "teardrop", egg: "teardrop", pill: "tablet", pebble: "wedge", gem: "house", burst: "star", jelly: "house", kitty: "blob", sprout: "blob" };
  for (const [former, now] of Object.entries(was)) {
    expect(SHAPE_BY_ID.has(former)).toBe(true);
    expect(shapeOf({ shape: former, color: "blue" }).id).toBe(now);
  }
  // One nobody ever had falls back to the first, and isn't taken for a shape.
  expect(SHAPE_BY_ID.has("ghost")).toBe(false);
  expect(shapeOf({ shape: "ghost", color: "blue" }).id).toBe("blob");
});

test("a new bot gets one of the thirteen, in a colour that doesn't read as switched off", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const look = randomLook();
    seen.add(look.shape);
    expect(COLOR_BY_ID.has(look.color)).toBe(true);
    expect(["white", "gray"]).not.toContain(look.color);
  }
  expect([...seen].sort()).toEqual(SHAPES.map((s) => s.id).sort());
});
