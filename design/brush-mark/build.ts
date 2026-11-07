// Composes the brush mark, the favicon, the GitHub App icon and the OpenBuild/OpenBots lockups from source/glyphs.json.
// Run: bun design/brush-mark/build.ts && design/brush-mark/render.sh
// source/glyphs.json comes from source/tools (potrace traces of Outis's references + Oswald outlines).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = import.meta.dir;
const indexHtml = join(out, "../../src/index.html");
mkdirSync(join(out, "svg"), { recursive: true });
const g = await Bun.file(join(out, "source/glyphs.json")).json();

// Bounding box of every coordinate pair in absolute path data (control points included, so it errs wide).
function bbox(...ds: string[]) {
  let [x1, y1, x2, y2] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const d of ds) {
    const n = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    for (let i = 0; i + 1 < n.length; i += 2) {
      x1 = Math.min(x1, n[i]); x2 = Math.max(x2, n[i]);
      y1 = Math.min(y1, n[i + 1]); y2 = Math.max(y2, n[i + 1]);
    }
  }
  return { x1, y1, x2, y2 };
}
const box = (b: ReturnType<typeof bbox>, pad: number) =>
  `${(b.x1 - pad).toFixed(0)} ${(b.y1 - pad).toFixed(0)} ${(b.x2 - b.x1 + 2 * pad).toFixed(0)} ${(b.y2 - b.y1 + 2 * pad).toFixed(0)}`;

const svg = (viewBox: string, paths: string[], ink: string, size?: [number, number], label?: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${size ? ` width="${size[0]}" height="${size[1]}"` : ""}${
    label ? ` role="img" aria-label="${label}"` : ""
  } fill="${ink}" fill-rule="evenodd">\n${paths.map((d) => `  <path d="${d}"/>`).join("\n")}\n</svg>\n`;

// ---- mark: geometric O ring (measured from the reference) around the traced brush B ----
const ring = (inner: number) => {
  const [cx, cy, R] = [515.5, 264, 194];
  const c = (r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  return c(R) + c(inner);
};
const MARK_BOX = "315.5 64 400 400";
const marks = {
  // Reference ring weight and every bristle.
  full: [ring(157.5), g.markB],
  // 16–32px: heavier ring, bristles merged into a solid brush B that keeps the flick and drip.
  small: [ring(146), g.markBSmall],
};
for (const [name, paths] of Object.entries(marks)) {
  writeFileSync(join(out, "svg", `mark-${name}-black.svg`), svg(MARK_BOX, paths, "#000", [512, 512]));
  writeFileSync(join(out, "svg", `mark-${name}-white.svg`), svg(MARK_BOX, paths, "#fff", [512, 512]));
}

// ---- lockups ----
// The full versions keep every bristle; the UI versions merge them so the header stays crisp at ~22px.
const lockups = {
  openbuild: { label: "OpenBuild", full: [g.brushO, g.penbuild.d], ui: [g.brushOUi, g.penbuild.d] },
  openbots: { label: "OpenBots", full: [g.open.d, g.brushB, g.ots.d], ui: [g.open.d, g.brushBUi, g.ots.d] },
};
const sizes: Record<string, string> = {};
for (const [name, l] of Object.entries(lockups)) {
  const vb = box(bbox(...l.full), 6);
  const [, , w, h] = vb.split(" ").map(Number);
  sizes[name] = `${w}x${h}`;
  for (const v of ["full", "ui"] as const) {
    writeFileSync(join(out, "svg", `${name}-wordmark-${v}-black.svg`), svg(vb, l[v], "#000", [w, h]));
    writeFileSync(join(out, "svg", `${name}-wordmark-${v}-white.svg`), svg(vb, l[v], "#fff", [w, h]));
  }
}
console.log("lockup viewBoxes", sizes);

// ---- favicon and GitHub App icon: the small mark in the reference's ivory on its near-black ----
// Sampled from source/reference/mark.png: the ring body and the field around it.
const IVORY = "#ece5d5";
const NEAR_BLACK = "#1f201d";
// Centres the mark on a `tile` px square with its ring `ring` px across.
const onTile = (tile: number, rx: number, ring: number) => {
  const k = ring / 388;
  const [x, y] = [tile / 2 - 515.5 * k, tile / 2 - 264 * k];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${tile} ${tile}"><rect width="${tile}" height="${tile}"${rx ? ` rx="${rx}"` : ""} fill="${NEAR_BLACK}"/><g fill="${IVORY}" fill-rule="evenodd" transform="translate(${+x.toFixed(3)} ${+y.toFixed(3)}) scale(${+k.toFixed(5)})">${marks.small.map((d) => `<path d="${d}"/>`).join("")}</g></svg>`;
};
// Same 32px tile as the old favicon; the ring fills 26px so it stays a clean O with a B at 16px.
const favicon = onTile(32, 8, 26);
writeFileSync(join(out, "svg", "favicon.svg"), favicon + "\n");
// GitHub rounds the avatar itself, so the App icon is a full-bleed square.
writeFileSync(join(out, "svg", "github-app-icon.svg"), onTile(512, 0, 380) + "\n");

const dataUri = `data:image/svg+xml,${favicon.replace(/"/g, "'").replace(/[%#<>]/g, encodeURIComponent)}`;
const html = await Bun.file(indexHtml).text();
writeFileSync(indexHtml, html.replace(/(rel="icon"\s+href=")[^"]*"/, `$1${dataUri}"`));
