// SVG markup for the mark and the icon tiles built from it.
import { FULL, GRADIENT, SMALL, paths } from "./geometry";

export const full = paths(FULL);
export const small = paths(SMALL);

/** The grain: fractal noise added to the shading, then cut back to the shape. Its size is in mark units. */
export const GRAIN = { frequency: 1.4, amount: 0.42 };
/** The small mark's shaded half is flat, at this share of the ink. */
export const SMALL_SHADE = 0.45;

const [[gx1, gy1], [gx2, gy2]] = GRADIENT;
const num = (v: number) => +v.toFixed(2);

/** The large mark's defs and shapes (ids prefixed by `id`), drawn in `ink`. */
export function fullMark(ink: string, id = "ob") {
  return `<defs>
  <linearGradient id="${id}-shade" gradientUnits="userSpaceOnUse" x1="${num(gx1)}" y1="${num(gy1)}" x2="${num(gx2)}" y2="${num(gy2)}"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient>
  <filter id="${id}-grain" x="-100" y="-100" width="200" height="200" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="${GRAIN.frequency}" numOctaves="2" seed="4" stitchTiles="stitch"/>
    <feColorMatrix values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1" result="noise"/>
    <feComposite in="SourceGraphic" in2="noise" operator="arithmetic" k2="1" k3="${GRAIN.amount}" k4="${num(-GRAIN.amount / 2 - 0.02)}"/>
    <feComposite in2="SourceAlpha" operator="in"/>
  </filter>
  <mask id="${id}-mask" maskUnits="userSpaceOnUse" x="-100" y="-100" width="200" height="200"><path d="${full.left}" fill="url(#${id}-shade)" filter="url(#${id}-grain)"/></mask>
</defs>
<g fill="${ink}"><rect x="-100" y="-100" width="200" height="200" mask="url(#${id}-mask)"/><path d="${full.right}"/><path d="${full.slash}"/></g>`;
}

/** The small mark: flat, heavier, for 16–32 px. */
export function smallMark(ink: string) {
  return `<g fill="${ink}"><path d="${small.left}" fill-opacity="${SMALL_SHADE}"/><path d="${small.right}"/><path d="${small.slash}"/></g>`;
}

const svg = (viewBox: string, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;

/** The mark alone on a transparent background. */
export const markSvg = (kind: "full" | "small", ink: string) =>
  svg("-100 -100 200 200", kind === "full" ? fullMark(ink) : smallMark(ink));

/**
 * The mark on a black tile, white on black like the reference: it reads on light and dark tabs and
 * home screens alike. `radius` rounds the tile (0 for platforms that mask it themselves); `scale` is
 * the ring's diameter as a share of the tile.
 */
export function tileSvg(kind: "full" | "small", { radius, scale }: { radius: number; scale: number }) {
  const mark = kind === "full" ? fullMark("#fff") : smallMark("#fff");
  return svg("0 0 200 200", `<rect width="200" height="200" rx="${radius}" fill="#000"/><g transform="translate(100 100) scale(${scale})">${mark}</g>`);
}

export const TILES = {
  /** Browser tabs: a rounded square, the ring nearly filling it so it holds up at 16 px. */
  favicon: { kind: "small", radius: 44, scale: 0.86 },
  /** iOS rounds the corners itself and won't take transparency. */
  appleTouch: { kind: "full", radius: 0, scale: 0.62 },
  /** Installed app (purpose "any"): shown as is, so it brings its own corners. */
  app: { kind: "full", radius: 45, scale: 0.62 },
  /** Android masks it to a circle or squircle: the ring stays inside the 80% safe zone. */
  maskable: { kind: "full", radius: 0, scale: 0.52 },
} as const;
