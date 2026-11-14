// The browser's side of fitting pictures into a message (src/lib/files.ts), for tests/imageFit.test.ts.
// `picture()` makes a test image: a flat canvas with a block of noise, which no encoder can squeeze,
// so its size in bytes is set by how much of it is noise.
import { fitDataUrl, fitImage, readAttachment } from "../../../src/lib/files";
import { pasteBotStash } from "../../../src/lib/stash";

/** The same noise every run. */
function noise(seed: number) {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x & 255;
  };
}

interface Picture {
  width: number;
  height: number;
  /** The noisy block, from the top left. */
  noiseWidth?: number;
  noiseHeight?: number;
  type?: string;
  /** See-through outside the noise, instead of grey. */
  clear?: boolean;
  name?: string;
}

async function picture({ width, height, noiseWidth = width, noiseHeight = height, type = "image/png", clear = false, name = "shot.png" }: Picture) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  if (!clear) {
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, width, height);
  }
  const block = ctx.createImageData(noiseWidth, noiseHeight);
  const next = noise(width * 31 + height);
  for (let i = 0; i < block.data.length; i += 4) {
    block.data[i] = next();
    block.data[i + 1] = next();
    block.data[i + 2] = next();
    block.data[i + 3] = 255;
  }
  ctx.putImageData(block, 0, 0);
  const blob = await new Promise<Blob>((done) => canvas.toBlob((b) => done(b!), type, 1));
  return new File([blob], name, { type });
}

/** A data URL's picture: its type, size, and the colour of one pixel. */
async function look(dataUrl: string, x = 0, y = 0) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
  return { mime: dataUrl.slice(5, dataUrl.indexOf(";")), length: dataUrl.length, width: img.naturalWidth, height: img.naturalHeight, pixel: [r, g, b, a] };
}

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(blob);
  });

Object.assign(window, { lab: { picture, look, readAsDataUrl, readAttachment, fitImage, fitDataUrl, pasteBotStash } });
document.body.dataset.ready = "1";
