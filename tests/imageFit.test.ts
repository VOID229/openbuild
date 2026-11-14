// Pictures fitted into a message in a real Chrome (src/lib/files.ts, fixture tests/fixtures/imageFit):
// whatever OpenBuild's or a bot's composer takes is a data URL the server takes too (MAX_IMAGE_DATA_URL,
// checked in server/bots/service.ts). One that fits as it is stays byte for byte; a larger one is drawn
// smaller and re-encoded until it fits.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MAX_IMAGE_DATA_URL } from "../shared/attachments";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;
let page: Page | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/imageFit/index.html`);
  chrome = await launchChrome();
  page = await Page.open(chrome.ws, server.url.href, 800, 600, "document.body.dataset.ready === '1'");
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

type Look = { mime: string; length: number; width: number; height: number; pixel: number[] };
type Picture = { width: number; height: number; noiseWidth?: number; noiseHeight?: number; type?: string; clear?: boolean; name?: string };

/** Makes `picture` on the page as `window.file`, and gives its size in bytes. */
const make = (picture: Picture) => page!.eval<number>(`lab.picture(${JSON.stringify(picture)}).then((f) => (window.file = f).size)`);

describe.skipIf(!browser)("fitting a picture into a message", () => {
  test("a screenshot OpenBuild's composer takes still fits a bot message, also pasted from a shared stash", async () => {
    // A 1920×1080 PNG of 2.3 MB: under the 2048 px and 3.5 MB OpenBuild's composer let through as it
    // was, but 3 million characters as a data URL, which the server refused once sent from a bot chat.
    const bytes = await make({ width: 1920, height: 1080, noiseWidth: 1000, noiseHeight: 760 });
    expect(bytes).toBeGreaterThan((MAX_IMAGE_DATA_URL * 3) / 4);
    expect(bytes).toBeLessThan(3.5 * 1024 * 1024);
    const pasted = await page!.eval<{ attached: Look; stashed: number[] }>(`(async () => {
      const a = await lab.readAttachment(file);
      // Cross-stashing: the stash OpenBuild's composer saved, pasted into a bot's composer.
      const { images } = lab.pasteBotStash({ text: "", images: [] }, { id: "s", text: "look", files: [a], createdAt: 1 });
      return { attached: await lab.look(a.dataUrl), stashed: images.map((src) => src.length) };
    })()`);
    expect(pasted.attached.length).toBeLessThanOrEqual(MAX_IMAGE_DATA_URL);
    expect(pasted.stashed).toEqual([pasted.attached.length]);
    // Shrunk only as far as it had to be: still full size, as a JPEG once the PNG didn't fit.
    expect(pasted.attached).toMatchObject({ mime: "image/jpeg", width: 1920, height: 1080 });
  }, 30_000);

  test("one that already fits is kept as it is, byte for byte", async () => {
    await make({ width: 1600, height: 900, noiseWidth: 300, noiseHeight: 300 });
    const same = await page!.eval<boolean[]>(`(async () => {
      const original = await lab.readAsDataUrl(file);
      return [(await lab.readAttachment(file)).dataUrl === original, (await lab.fitImage(file)) === original];
    })()`);
    expect(same).toEqual([true, true]);
  }, 30_000);

  test("a PNG that fits once it's 2048 px stays a PNG; a huge noisy one becomes a smaller JPEG", async () => {
    // A Retina screenshot with little in it: halved, and still lossless.
    await make({ width: 4096, height: 2304, noiseWidth: 400, noiseHeight: 400 });
    const flat = await page!.eval<Look>("lab.fitImage(file).then((u) => lab.look(u))");
    expect(flat).toMatchObject({ mime: "image/png", width: 2048, height: 1152 });
    // Nothing but noise: as a JPEG at 2048 px it fits the server's limit at the first quality tried
    // that's low enough...
    await make({ width: 4000, height: 3000 });
    const noisy = await page!.eval<Look>("lab.fitImage(file).then((u) => lab.look(u))");
    expect(noisy).toMatchObject({ mime: "image/jpeg", width: 2048, height: 1536 });
    expect(noisy.length).toBeLessThanOrEqual(MAX_IMAGE_DATA_URL);
    // ...and with less room than that it's drawn a quarter smaller at a time until one does.
    const tight = await page!.eval<Look>("lab.fitImage(file, { limit: 300000 }).then((u) => lab.look(u))");
    expect(tight.mime).toBe("image/jpeg");
    expect(tight.length).toBeLessThanOrEqual(300_000);
    expect(tight.width).toBeLessThan(2048);
    expect(tight.width / tight.height).toBeCloseTo(4 / 3, 2);
  }, 60_000);

  test("what was see-through comes out white in a JPEG, not black", async () => {
    await make({ width: 2000, height: 1200, noiseWidth: 1400, noiseHeight: 1000, clear: true });
    const shot = await page!.eval<Look>("lab.fitImage(file).then((u) => lab.look(u, 1990, 1190))");
    expect(shot.mime).toBe("image/jpeg");
    expect(shot.length).toBeLessThanOrEqual(MAX_IMAGE_DATA_URL);
    for (const channel of shot.pixel.slice(0, 3)) expect(channel).toBeGreaterThan(245);
  }, 30_000);

  test("a picture held as a data URL (a stash, a draft from another device) is fitted the same way", async () => {
    await make({ width: 1920, height: 1080 });
    const fitted = await page!.eval<{ before: number; after: Look; small: boolean; notImage: string }>(`(async () => {
      const big = await lab.readAsDataUrl(file);
      const small = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const notImage = await lab.fitDataUrl("data:text/plain;base64," + "A".repeat(${MAX_IMAGE_DATA_URL})).then(() => "fitted", (e) => e.message);
      return { before: big.length, after: await lab.look(await lab.fitDataUrl(big)), small: (await lab.fitDataUrl(small)) === small, notImage };
    })()`);
    expect(fitted.before).toBeGreaterThan(MAX_IMAGE_DATA_URL);
    expect(fitted.after.mime).toBe("image/jpeg");
    expect(fitted.after.length).toBeLessThanOrEqual(MAX_IMAGE_DATA_URL);
    expect(fitted.small).toBe(true);
    expect(fitted.notImage).toBe("That image is too large to send.");
  }, 30_000);

  test("OpenBuild's composer sends a GIF as a still; a bot's keeps one that fits", async () => {
    const gif = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
    const types = await page!.eval<string[]>(`(async () => {
      const file = new File([Uint8Array.from(atob("${gif}"), (c) => c.charCodeAt(0))], "wave.gif", { type: "image/gif" });
      return [(await lab.readAttachment(file)).mime, (await lab.fitImage(file)).slice(0, 15)];
    })()`);
    expect(types).toEqual(["image/jpeg", "data:image/gif;"]);
  }, 30_000);
});
