// Run from the repo root after `bun add potrace@2.1.8 opentype.js@1.3.4 @fontsource/oswald@5.2.5` in a scratch dir
// (set NODE_PATH or copy these tools there): bun trace.ts <each>.json, then bun outline.ts design/brush-mark/source/glyphs.json
// Outlines the Oswald lettering at the reference's positions and bundles it with the traced brush glyphs.
import opentype from "opentype.js";
const fontDir = "node_modules/@fontsource/oswald/files";
const load = async (w: number) => opentype.parse((await Bun.file(`${fontDir}/oswald-latin-${w}-normal.woff`).arrayBuffer()));
const bold = await load(700), light = await load(300);

// Set `text` with its cap height `cap`, baseline `base`, spanning exactly [x0, x1] (tracking solved to fit).
function set(font: opentype.Font, text: string, cap: number, base: number, x0: number, x1: number) {
  const size = cap / (font.tables.os2.sCapHeight / font.unitsPerEm);
  const width = (ls: number) => { const b = font.getPath(text, 0, base, size, { letterSpacing: ls }).getBoundingBox(); return [b.x1, b.x2]; };
  let lo = -0.2, hi = 0.5;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; const [a, b] = width(m); (b - a < x1 - x0 ? (lo = m) : (hi = m)); }
  const [a] = width(lo);
  const p = font.getPath(text, x0 - a, base, size, { letterSpacing: lo });
  return { d: p.toPathData(1), tracking: +lo.toFixed(4) };
}
const round = (d: string) => d.replace(/-?\d+\.\d+/g, (n) => (+n).toFixed(1));
const traced = async (n: string) => round((await Bun.file(`design/brush-mark/source/tools/${n}.out`).json()).d);

const glyphs = {
  // Brush glyphs, in the pixel space of the reference images.
  brushO: await traced("o2"), brushOUi: await traced("o2ui"),
  brushB: await traced("b2"), brushBUi: await traced("b2ui"),
  markB: await traced("m1"), markBSmall: await traced("m1s"),
  // Lettering: OPENBUILD caps sit on the brush O's baseline; P starts just past the O's bowl.
  penbuild: set(bold, "PENBUILD", 156, 225, 252, 252 + 741),
  open: set(light, "OPEN", 154, 453, 281, 675),
  ots: set(light, "OTS", 154, 453, 862, 1159),
};
await Bun.write(process.argv[2], JSON.stringify(glyphs, null, 1));
console.log(Object.entries(glyphs).map(([k, v]) => `${k}:${(typeof v === "string" ? v : v.d).length}`).join(" "), glyphs.penbuild.tracking, glyphs.open.tracking);
