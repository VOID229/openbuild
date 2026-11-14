// The ring-slash mark: a ring cut by an S-shaped slash. Everything is drawn around (0, 0) with the
// ring's outer radius 100, so a mark's viewBox is "-100 -100 200 200".
//
// The numbers come from the reference image (reference/source.jpg, ring centre (640, 359.5), outer
// radius 105.5 px): the slash's centre line is a cubic Bézier fitted to its edges within 0.33 px RMS,
// it is 13.2 px thick, a 4.9 px black gap parts it from the right half, its ends are cut by two
// slanted lines, and the left half's shading is a linear gradient at 124.8° (black on the centre line,
// white at the rim), measured by a least-squares fit with 0.03 RMS error.

export type V = [number, number];

export interface Shape {
  /** Inner radius of the ring (outer is 100). */
  inner: number;
  /** Half the slash's thickness. */
  half: number;
  /** The black gap between the slash and the right half. */
  gap: number;
}

/** Faithful to the reference. */
export const FULL: Shape = { inner: 60, half: 6.26, gap: 4.65 };
/** For 16 and 32 px: a heavier ring, slash and gap, so each is at least a pixel wide at 16 px. */
export const SMALL: Shape = { inner: 48, half: 12, gap: 15 };

/** The slash's centre line, top-left to bottom-right. */
const CURVE: V[] = [[-66.59, -78.54], [-42.64, -11.28], [54.15, 10.69], [64.65, 86.7]];
/** The slash's ends are cut along these lines, each given by two points. */
const TOP_CUT: [V, V] = [[-71.75, -80.85], [-58.77, -78.58]];
const BOTTOM_CUT: [V, V] = [[57.82, 83.89], [69.67, 89.38]];
/** The left half's gradient runs from black at GRADIENT[0] to white at GRADIENT[1]. */
const DIR: V = [-0.5704, 0.8213];
export const GRADIENT: [V, V] = [[-2.2 * DIR[0], -2.2 * DIR[1]], [99.7 * DIR[0], 99.7 * DIR[1]]];

const add = (a: V, b: V, k = 1): V => [a[0] + k * b[0], a[1] + k * b[1]];
const cross = (a: V, b: V) => a[0] * b[1] - a[1] * b[0];
const len = (a: V) => Math.hypot(a[0], a[1]);

function point(t: number): V {
  const u = 1 - t;
  const w = [u * u * u, 3 * t * u * u, 3 * t * t * u, t * t * t];
  return [0, 1].map((d) => w.reduce((s, k, i) => s + k * CURVE[i]![d]!, 0)) as V;
}

function tangent(t: number): V {
  const u = 1 - t;
  const [p0, p1, p2, p3] = CURVE as [V, V, V, V];
  const d = [0, 1].map((k) => 3 * (u * u * (p1[k]! - p0[k]!) + 2 * t * u * (p2[k]! - p1[k]!) + t * t * (p3[k]! - p2[k]!))) as V;
  const l = len(d);
  return [d[0] / l, d[1] / l];
}

/** The curve moved `d` along its normal: positive is the right half's side (up and right). */
export function offset(t: number, d: number): V {
  const [tx, ty] = tangent(t);
  return add(point(t), [ty, -tx], d);
}

/** The t in [a, b] where f changes sign, closest to a (f is sampled, then bisected). */
function root(f: (t: number) => number, a: number, b: number): number {
  const steps = 2000;
  let prev = f(a);
  for (let i = 1; i <= steps; i++) {
    const t = a + ((b - a) * i) / steps;
    const v = f(t);
    if (Math.sign(v) !== Math.sign(prev)) {
      let lo = t - (b - a) / steps, hi = t;
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        if (Math.sign(f(mid)) === Math.sign(f(lo))) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    prev = v;
  }
  throw new Error("no root");
}

/** Where the offset curve meets a circle: [top crossing, bottom crossing]. */
function crossings(d: number, radius: number): [number, number] {
  const f = (t: number) => len(offset(t, d)) - radius;
  // Scanned from each end inwards: the first crossing from either end.
  return [root(f, -0.3, 0.5), 1.3 - root((s) => f(1.3 - s), 0, 0.8)];
}

function onLine(d: number, [a, b]: [V, V], from: number, to: number) {
  return root((t) => cross(add(b, a, -1), add(offset(t, d), a, -1)), from, to);
}

const n = (v: number) => (Math.abs(v) < 0.005 ? "0" : v.toFixed(2).replace(/\.?0+$/, ""));
const pt = (p: V) => `${n(p[0])} ${n(p[1])}`;

/** The offset curve from t0 to t1 as smooth cubic segments (Catmull-Rom through samples). */
function curveTo(d: number, t0: number, t1: number, segments = 10): string {
  const at = (i: number) => offset(t0 + ((t1 - t0) * i) / segments, d);
  let s = "";
  for (let i = 0; i < segments; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    s += `C${pt(add(p1, add(p2, p0, -1), 1 / 6))} ${pt(add(p2, add(p3, p1, -1), -1 / 6))} ${pt(p2)}`;
  }
  return s;
}

const angle = (p: V) => Math.atan2(p[1], p[0]);
/** An arc of the circle through `from` to `to`; sweep 1 turns clockwise on screen. */
function arc(radius: number, from: V, to: V, sweep: 0 | 1): string {
  let span = angle(to) - angle(from);
  if (sweep === 0) span = -span;
  span = ((span % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return `A${n(radius)} ${n(radius)} 0 ${span > Math.PI ? 1 : 0} ${sweep} ${pt(to)}`;
}

export interface Paths {
  /** The shaded half, left of the slash. Its cut edge sits under the slash. */
  left: string;
  /** The solid half, right of the gap. */
  right: string;
  slash: string;
}

export function paths(shape: Shape): Paths {
  const R = 100, r = shape.inner;
  // Right half: the ring beyond the gap.
  const dr = shape.half + shape.gap;
  const [ro0, ro1] = crossings(dr, R), [ri0, ri1] = crossings(dr, r);
  const right =
    `M${pt(offset(ro0, dr))}${arc(R, offset(ro0, dr), offset(ro1, dr), 1)}` +
    `L${pt(offset(ro1, dr))}${curveTo(dr, ro1, ri1, 4)}` +
    `${arc(r, offset(ri1, dr), offset(ri0, dr), 0)}${curveTo(dr, ri0, ro0, 4)}Z`;
  // Left half: up to the middle of the slash's left side, so no seam shows between them.
  const dl = -shape.half / 2;
  const [lo0, lo1] = crossings(dl, R), [li0, li1] = crossings(dl, r);
  const left =
    `M${pt(offset(lo0, dl))}${curveTo(dl, lo0, li0, 4)}` +
    `${arc(r, offset(li0, dl), offset(li1, dl), 0)}${curveTo(dl, li1, lo1, 4)}` +
    `${arc(R, offset(lo1, dl), offset(lo0, dl), 1)}Z`;
  // Slash: both edges, between the two cuts.
  const [a0, a1] = [onLine(-shape.half, TOP_CUT, -0.3, 0.5), onLine(-shape.half, BOTTOM_CUT, 0.5, 1.3)];
  const [b0, b1] = [onLine(shape.half, TOP_CUT, -0.3, 0.5), onLine(shape.half, BOTTOM_CUT, 0.5, 1.3)];
  const slash =
    `M${pt(offset(a0, -shape.half))}${curveTo(-shape.half, a0, a1, 12)}` +
    `L${pt(offset(b1, shape.half))}${curveTo(shape.half, b1, b0, 12)}Z`;
  return { left, right, slash };
}
