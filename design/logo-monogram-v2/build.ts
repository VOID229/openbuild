// Round 2 of the OpenBuild mark: symbols built on an O+B idea, not letterforms.
// Run: bun design/logo-monogram-v2/build.ts && design/logo-monogram-v2/render.sh
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = import.meta.dir;
mkdirSync(join(out, "svg"), { recursive: true });

type Mark = { id: string; name: string; final: boolean; mark: (ink: string, bg: string) => string };

// Every mark is drawn in a 100×100 box centred on (50, 50). Cuts are masks so exports stay transparent.
const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const hex = (r: number) =>
  [-90, -30, 30, 90, 150, 210]
    .map((a, i) => {
      const t = (a * Math.PI) / 180;
      return `${i ? "L" : "M"}${(50 + r * Math.cos(t)).toFixed(2)} ${(50 + r * Math.sin(t)).toFixed(2)}`;
    })
    .join("") + "Z";
const hexPoint = (r: number, a: number) => {
  const t = (a * Math.PI) / 180;
  return `${(50 + r * Math.cos(t)).toFixed(2)} ${(50 + r * Math.sin(t)).toFixed(2)}`;
};

const marks: Mark[] = [
  {
    // An O whose top-right quadrant is a square block set into it, a brick placed in the ring.
    id: "cornerstone",
    name: "Cornerstone",
    final: true,
    mark: (ink) => `
  <mask id="cs"><g fill="#fff">
    <path d="${circle(50, 50, 42)}"/><rect x="50" y="8" width="42" height="42"/>
  </g><g fill="#000">
    <circle cx="50" cy="50" r="14"/>
    <rect x="47.5" y="0" width="5" height="50"/><rect x="50" y="47.5" width="50" height="5"/>
  </g></mask>
  <rect width="100" height="100" fill="${ink}" mask="url(#cs)"/>`,
  },
  {
    // A block seen corner-on with an O bored through the corner: open + build.
    id: "bore",
    name: "Bore",
    final: true,
    mark: (ink) => `
  <mask id="bo"><path fill="#fff" stroke="#fff" stroke-width="7" stroke-linejoin="round" d="${hex(40)}"/>
  <g stroke="#000" stroke-width="5" fill="none">
    <path d="M50 50L${hexPoint(60, 90)}M50 50L${hexPoint(60, -30)}M50 50L${hexPoint(60, 210)}"/>
  </g><circle cx="50" cy="50" r="13" fill="#000"/></mask>
  <rect width="100" height="100" fill="${ink}" mask="url(#bo)"/>`,
  },
  {
    // Two stacked blocks, flat on the left, round on the right; an O bored through the lower one.
    id: "stack",
    name: "Stack",
    final: false,
    mark: (ink) => `
  <mask id="st"><g fill="#fff">
    <path d="M14 12H55a17 17 0 0 1 0 34H14Z"/><path d="M14 52H67a19 19 0 0 1 0 38H14Z"/>
  </g><circle cx="67" cy="71" r="9" fill="#000"/></mask>
  <rect width="100" height="100" fill="${ink}" mask="url(#st)"/>`,
  },
];

const BLACK = "#000";
const WHITE = "#fff";
const TILE = 512;
const SCALE = 0.7;
const OFFSET = (TILE * (1 - SCALE)) / 2;

const markSvg = (m: Mark, ink: string, size = 512) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">${m.mark(ink, "none")}\n</svg>\n`;
const tileSvg = (m: Mark, bg: string, ink: string, size = 512) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}" width="${size}" height="${size}">
  <rect width="${TILE}" height="${TILE}" rx="112" fill="${bg}"/>
  <g transform="translate(${OFFSET} ${OFFSET}) scale(${(SCALE * TILE) / 100})">${m.mark(ink, bg)}
  </g>
</svg>
`;

for (const m of marks) {
  const files = {
    "mark-black": markSvg(m, BLACK),
    "mark-white": markSvg(m, WHITE),
    "tile-light": tileSvg(m, WHITE, BLACK),
    "tile-dark": tileSvg(m, BLACK, WHITE),
  };
  for (const [v, svg] of Object.entries(files)) writeFileSync(join(out, "svg", `${m.id}-${v}.svg`), svg);
}

// Compact sheet: per mark, large light + dark tiles, then the icon at 64/32/24/16 on both.
const uri = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const row = (m: Mark) => {
  const light = uri(tileSvg(m, WHITE, BLACK));
  const dark = uri(tileSvg(m, BLACK, WHITE));
  const icons = (src: string) => [64, 32, 24, 16].map((s) => `<img src="${src}" width="${s}" height="${s}" alt="">`).join("");
  return `<div class="row" data-id="${m.id}" data-final="${m.final}">
  <img class="big" src="${light}" alt=""><img class="big" src="${dark}" alt="">
  <div class="icons"><div class="on-light">${icons(light)}</div><div class="on-dark">${icons(dark)}</div></div>
</div>`;
};
const sheet = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>OpenBuild Marks</title>
<style>
  body { margin:0; padding:24px; background:#e9e9e9; display:inline-flex; flex-direction:column; gap:24px; }
  .row { display:flex; gap:20px; align-items:center; }
  .big { width:220px; height:220px; display:block; }
  .big:first-child { outline:1px solid #d4d4d4; border-radius:48px; }
  .icons { display:flex; flex-direction:column; gap:12px; }
  .icons div { display:flex; align-items:center; gap:18px; padding:14px 18px; border-radius:16px; }
  .on-light { background:#fff; } .on-dark { background:#000; }
</style></head>
<body>
${marks.map(row).join("\n")}
<script>
  const q = new URLSearchParams(location.search);
  document.querySelectorAll(".row").forEach((r) => {
    if (q.has("final") ? r.dataset.final !== "true" : q.get("only") && r.dataset.id !== q.get("only")) r.remove();
  });
</script>
</body></html>
`;
writeFileSync(join(out, "sheet.html"), sheet);
console.log(`wrote ${marks.length * 4} SVGs and sheet.html`);
