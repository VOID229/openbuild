// bun trace.ts <config.json>  -> prints {d, box} with path in source-image pixel coordinates.
import Jimp from "jimp";
import potrace from "potrace";
const cfg = await Bun.file(process.argv[2]).json();
const img = await Jimp.read(cfg.src);
const keep = new Function("x", "y", `return (${cfg.keep});`) as (x: number, y: number) => boolean;
img.greyscale();
img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (x, y, i) {
  if (!keep(x, y)) { this.bitmap.data[i] = this.bitmap.data[i + 1] = this.bitmap.data[i + 2] = 0; }
});
const [cx, cy, cw, ch] = cfg.crop;
img.crop(cx, cy, cw, ch);
const S = cfg.scale ?? 4;
img.resize(cw * S, ch * S, Jimp.RESIZE_BICUBIC);
if (cfg.blur) img.blur(cfg.blur);
if (cfg.debug) await img.clone().writeAsync(cfg.debug);
const p = new potrace.Potrace();
p.setParameters({ blackOnWhite: false, threshold: cfg.threshold ?? 128, turdSize: cfg.turdSize ?? 30, optTolerance: cfg.optTolerance ?? 0.4, alphaMax: cfg.alphaMax ?? 1 });
await new Promise<void>((res, rej) => p.loadImage(img, (e: unknown) => (e ? rej(e) : res())));
const svg: string = p.getSVG();
const d = svg.match(/ d="([^"]+)"/)![1];
// Map back to source pixels.
const nums = d.replace(/-?\d+(\.\d+)?/g, "§$&§");
let k = 0;
const mapped = nums.replace(/§(-?\d+(?:\.\d+)?)§/g, (_m, n) => { const v = +n / S + (k++ % 2 === 0 ? cx : cy); return (Math.round(v * 100) / 100).toString(); });
await Bun.write(cfg.out, JSON.stringify({ d: mapped }));
console.log(cfg.out, mapped.length, "chars");
