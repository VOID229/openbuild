// Writes preview.html: the mark at large and favicon sizes, and both lockups large and at header size.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = import.meta.dir;
const svg = (f: string) => `data:image/svg+xml,${encodeURIComponent(readFileSync(join(dir, "svg", f), "utf8"))}`;
const both = (f: (ink: "black" | "white") => string, attrs: string) =>
  `<div class="dark"><img src="${svg(f("white"))}" ${attrs} alt=""></div><div class="light"><img src="${svg(f("black"))}" ${attrs} alt=""></div>`;
const fav = (ink: "black" | "white") => [64, 32, 24, 16].map((s) => `<img src="${svg(`mark-small-${ink}.svg`)}" width="${s}" height="${s}" alt="">`).join("");
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Brush Mark Preview</title><style>
body{margin:0;padding:20px;background:#d9d9d9;display:inline-flex;flex-direction:column;gap:14px;font:12px system-ui;color:#555}
.row{display:flex;gap:14px;align-items:stretch}.row>div{border-radius:14px;display:flex;align-items:center;justify-content:center;gap:16px;padding:18px}
.dark{background:#141414}.light{background:#fff}
</style></head><body>
<div class="row">${both((i) => `mark-full-${i}.svg`, 'width="200" height="200"')}${both((i) => `mark-small-${i}.svg`, 'width="200" height="200"')}</div>
<div class="row"><div class="dark">${fav("white")}</div><div class="light">${fav("black")}</div></div>
<div class="row">${both((i) => `openbuild-wordmark-full-${i}.svg`, 'height="96"')}</div>
<div class="row">${both((i) => `openbots-wordmark-full-${i}.svg`, 'height="96"')}</div>
<div class="row">${both((i) => `openbuild-wordmark-ui-${i}.svg`, 'height="22"')}${both((i) => `openbots-wordmark-ui-${i}.svg`, 'height="22"')}</div>
</body></html>`;
writeFileSync(join(dir, "preview.html"), html);
