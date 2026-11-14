import { useId } from "react";
import { MARK } from "./markPaths";

/** From this size the shaded, grainy mark; below it the flat one, which stays crisp down to 16 px. */
const FULL_FROM = 40;

/**
 * OpenBuild's mark, a ring cut by an S-shaped slash, in the text colour: light on the dark theme,
 * dark on the light one. The left half fades into the background, so it suits either.
 * Drawn by design/ring-slash.
 */
export function OpenBuildMark({ size, className }: { size: number; className?: string }) {
  // Ids for the shading's defs: useId's own characters aren't all safe inside url(#…).
  const id = `ob-mark-${useId().replace(/[^\w-]/g, "")}`;
  const svg = { width: size, height: size, viewBox: "-100 -100 200 200", className, "aria-hidden": true, focusable: false, fill: "currentColor" } as const;
  if (size < FULL_FROM) {
    return (
      <svg {...svg}>
        <path d={MARK.small.left} fillOpacity={MARK.smallShade} />
        <path d={MARK.small.right} />
        <path d={MARK.small.slash} />
      </svg>
    );
  }
  const [x1, y1, x2, y2] = MARK.gradient;
  return (
    <svg {...svg}>
      <defs>
        <linearGradient id={`${id}-shade`} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
          <stop offset="0" stopColor="#000" />
          <stop offset="1" stopColor="#fff" />
        </linearGradient>
        <filter id={`${id}-grain`} x="-100" y="-100" width="200" height="200" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency={MARK.grain.frequency} numOctaves={2} seed={4} stitchTiles="stitch" />
          <feColorMatrix values="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1" result="noise" />
          <feComposite in="SourceGraphic" in2="noise" operator="arithmetic" k2={1} k3={MARK.grain.amount} k4={-MARK.grain.amount / 2 - 0.02} />
          <feComposite in2="SourceAlpha" operator="in" />
        </filter>
        <mask id={`${id}-mask`} maskUnits="userSpaceOnUse" x="-100" y="-100" width="200" height="200">
          <path d={MARK.full.left} fill={`url(#${id}-shade)`} filter={`url(#${id}-grain)`} />
        </mask>
      </defs>
      <rect x="-100" y="-100" width="200" height="200" mask={`url(#${id}-mask)`} />
      <path d={MARK.full.right} />
      <path d={MARK.full.slash} />
    </svg>
  );
}
