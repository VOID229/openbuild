// Generates the O+B monogram concepts: standalone SVGs and the comparison board.
// Run: bun design/logo-monogram/build.ts && design/logo-monogram/render.sh
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = import.meta.dir;
mkdirSync(join(out, "svg"), { recursive: true });

type Concept = { id: string; name: string; rationale: string; mark: (ink: string) => string };

// Every mark is drawn in a 100×100 box, centred on (50, 50).
const circle = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
// D-shaped counter: flat left edge at x0, round right end.
const dee = (x0: number, y0: number, y1: number, xr: number) => {
  const r = (y1 - y0) / 2;
  return `M${x0} ${y0}H${xr}a${r} ${r} 0 0 1 0 ${2 * r}H${x0}Z`;
};

const concepts: Concept[] = [
  {
    id: "a-split",
    name: "Split",
    rationale: "One shared stem: the left half is the O's arc and the right half is the B's two bowls, so the mark reads O|B in a single stroke weight.",
    mark: (ink) => `
  <path transform="translate(6.5 0)" fill="none" stroke="${ink}" stroke-width="11" stroke-linejoin="miter"
    d="M50 13A37 37 0 0 0 50 87M50 13V87M50 13H56a18.5 18.5 0 0 1 0 37H50M50 50H57a18.5 18.5 0 0 1 0 37H50"/>`,
  },
  {
    id: "b-counter",
    name: "Counter",
    rationale: "A solid O disc with the B carved out as negative space, so the silhouette stays a plain dot at 16px.",
    mark: (ink) => `
  <path fill="${ink}" fill-rule="evenodd" d="${circle(50, 50, 44)}${dee(36, 21, 45, 56)}${dee(36, 53, 79, 58)}"/>`,
  },
  {
    id: "c-belly",
    name: "Belly",
    rationale: "A geometric B whose lower bowl is a perfect O, so both letters read in one glyph: the B shape, the O counter.",
    mark: (ink) => `
  <g transform="translate(1 0)" fill="none" stroke="${ink}" stroke-width="12">
    <path stroke-linejoin="miter" d="M24 63V12H44a13 13 0 0 1 0 26H24"/>
    <circle cx="49" cy="63" r="25"/>
    <path d="M24 57V88H49"/>
  </g>`,
  },
];

const BLACK = "#000";
const WHITE = "#fff";
// Tiles are 512 units, rx ≈ 22%, mark at 72% so it stays legible on a 16px favicon.
const TILE = 512;
const SCALE = 0.72;
const OFFSET = (TILE - 100 * SCALE * (TILE / 100)) / 2;

const markSvg = (c: Concept, ink: string, size = 512) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}">${c.mark(ink)}\n</svg>\n`;

const tileSvg = (c: Concept, bg: string, ink: string, size = 512) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}" width="${size}" height="${size}">
  <rect width="${TILE}" height="${TILE}" rx="112" fill="${bg}"/>
  <g transform="translate(${OFFSET} ${OFFSET}) scale(${(SCALE * TILE) / 100})">${c.mark(ink)}
  </g>
</svg>
`;

const variants = (c: Concept) => ({
  "mark-black": markSvg(c, BLACK),
  "mark-white": markSvg(c, WHITE),
  "tile-light": tileSvg(c, WHITE, BLACK),
  "tile-dark": tileSvg(c, BLACK, WHITE),
});

for (const c of concepts) {
  for (const [v, svg] of Object.entries(variants(c))) writeFileSync(join(out, "svg", `${c.id}-${v}.svg`), svg);
}

// ---- comparison board ----
const uri = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const current = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1e1e1e"/><circle cx="16" cy="16" r="7" fill="none" stroke="white" stroke-width="3"/></svg>`;

const sizes = (src: string) =>
  [32, 24, 16].map((s) => `<img src="${src}" width="${s}" height="${s}" alt="">`).join("");

const row = (c: Concept, i: number) => {
  const light = uri(tileSvg(c, WHITE, BLACK));
  const dark = uri(tileSvg(c, BLACK, WHITE));
  return `
<section class="row" data-id="${c.id}">
  <div class="meta">
    <div class="num">${String.fromCharCode(65 + i)}</div>
    <h2>${c.name}</h2>
    <p>${c.rationale}</p>
    <code>${c.id}</code>
  </div>
  <div class="hero light"><img src="${uri(markSvg(c, BLACK))}" alt=""></div>
  <div class="hero dark"><img src="${uri(markSvg(c, WHITE))}" alt=""></div>
  <div class="small">
    <div class="strip light">${sizes(light)}<canvas data-src="${light}"></canvas></div>
    <div class="strip dark">${sizes(dark)}<canvas data-src="${dark}"></canvas></div>
    <div class="cap">32 · 24 · 16 px actual &nbsp;|&nbsp; 16 px raster, 5× zoom</div>
  </div>
  <div class="gh">
    <div class="gh-card light">
      <img class="av sq" src="${light}" alt=""><img class="av ci" src="${light}" alt="">
      <span><b>openbuild</b><i>bot</i><br><img class="av xs" src="${light}" alt=""> opened #66</span>
    </div>
    <div class="gh-card dark">
      <img class="av sq" src="${dark}" alt=""><img class="av ci" src="${dark}" alt="">
      <span><b>openbuild</b><i>bot</i><br><img class="av xs" src="${dark}" alt=""> opened #66</span>
    </div>
    <div class="cap">GitHub app avatar · square, round crop, 20 px inline</div>
  </div>
</section>`;
};

const board = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenBuild Monogram Concepts</title>
<style>
  :root { --bg:#f4f4f4; --fg:#111; --muted:#777; --line:#ddd; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 ui-sans-serif, system-ui, sans-serif; padding:36px 40px 40px; width:1440px; }
  header { display:flex; align-items:center; gap:18px; margin-bottom:26px; }
  header h1 { font-size:22px; margin:0; letter-spacing:-.01em; }
  header p { margin:0; color:var(--muted); }
  header .ref { margin-left:auto; display:flex; align-items:center; gap:10px; color:var(--muted); font-size:12px; }
  .row { display:grid; grid-template-columns: 300px 200px 200px 1fr 330px; gap:20px; align-items:center;
         padding:22px 0; border-top:1px solid var(--line); }
  .meta .num { font:600 12px ui-monospace, monospace; color:var(--muted); }
  .meta h2 { margin:2px 0 6px; font-size:20px; }
  .meta p { margin:0 0 8px; color:#333; }
  .meta code { font-size:11px; color:var(--muted); }
  .hero { width:200px; height:200px; border-radius:28px; display:grid; place-items:center; }
  .hero img { width:136px; height:136px; }
  .light { background:#fff; outline:1px solid var(--line); }
  .dark { background:#000; }
  .small { display:flex; flex-direction:column; gap:8px; }
  .strip { display:flex; align-items:center; gap:18px; padding:12px 16px; border-radius:12px; }
  .strip canvas { width:80px; height:80px; image-rendering:pixelated; margin-left:auto; }
  .cap { font-size:11px; color:var(--muted); }
  .gh { display:flex; flex-direction:column; gap:8px; }
  .gh-card { display:flex; align-items:center; gap:12px; padding:10px 14px; border-radius:12px; font-size:13px; }
  .gh-card.dark { color:#e6e6e6; background:#0d0d0d; }
  .gh-card i { font-style:normal; font-size:10px; border:1px solid currentColor; border-radius:99px; padding:0 6px; margin-left:6px; opacity:.6; }
  .av.sq { width:56px; height:56px; border-radius:12px; }
  .av.ci { width:40px; height:40px; border-radius:50%; }
  .av.xs { width:20px; height:20px; border-radius:5px; vertical-align:-5px; }
</style>
</head>
<body>
<header>
  <h1>OpenBuild — O+B monogram concepts</h1>
  <p>Monochrome, original vector geometry. Each row: light, dark, small sizes, GitHub avatar.</p>
  <div class="ref">current favicon (reference) <img src="${uri(current)}" width="32" height="32" alt=""><img src="${uri(current)}" width="16" height="16" alt=""></div>
</header>
${concepts.map(row).join("")}
<script>
  const only = new URLSearchParams(location.search).get("only");
  if (only) document.querySelectorAll(".row").forEach((r) => { if (!r.dataset.id.startsWith(only)) r.remove(); });
  // Rasterise at true 16px, then show it enlarged with hard pixels.
  for (const cv of document.querySelectorAll("canvas[data-src]")) {
    cv.width = cv.height = 16;
    const img = new Image();
    img.onload = () => cv.getContext("2d").drawImage(img, 0, 0, 16, 16);
    img.src = cv.dataset.src;
  }
</script>
</body>
</html>
`;
writeFileSync(join(out, "board.html"), board);
console.log(`wrote ${concepts.length * 4} SVGs and board.html`);
