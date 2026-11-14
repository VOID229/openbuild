import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { iconRoutes } from "../server/icons";
import { MARK } from "../src/components/markPaths";
import { full, small } from "../design/ring-slash/svg";

const src = join(import.meta.dir, "../src");
const pngSize = (file: string) => {
  const png = readFileSync(file);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};
const fileRoute = (file: string) => iconRoutes["/icons/:file"]({ params: { file } } as Parameters<(typeof iconRoutes)["/icons/:file"]>[0]);

test("every icon the page links is in the app", () => {
  const html = readFileSync(join(src, "index.html"), "utf8");
  const links = [...html.matchAll(/<link rel="(icon|apple-touch-icon|manifest)" href="\.\/([^"]+)"/g)].map((m) => [m[1], m[2]!]);
  expect(links.map(([rel]) => rel).sort()).toEqual(["apple-touch-icon", "icon", "icon", "manifest"]);
  for (const [, href] of links) expect(existsSync(join(src, href!))).toBe(true);
  // The SVG is the tab's icon wherever it's supported; the ICO says it's 32 px so it isn't preferred.
  expect(html).toContain('href="./icons/favicon.svg" type="image/svg+xml"');
  expect(html).toContain('href="./icons/favicon.ico" sizes="32x32"');
  expect(pngSize(join(src, "icons/apple-touch-icon.png"))).toEqual([180, 180]);
});

test("the manifest's icons are served at fixed addresses, at the sizes it says", async () => {
  const manifest = JSON.parse(readFileSync(join(src, "manifest.webmanifest"), "utf8")) as { icons: { src: string; sizes: string; type: string; purpose: string }[] };
  expect(manifest.icons.map((i) => i.purpose).sort()).toEqual(["any", "any", "maskable"]);
  for (const icon of manifest.icons) {
    const file = icon.src.replace(/^\/icons\//, "");
    const res = fileRoute(file);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(icon.type);
    const [w, h] = pngSize(join(src, "icons", file));
    expect(`${w}x${h}`).toBe(icon.sizes);
  }
});

test("browsers' own guesses find the icons, and nothing else is served from there", async () => {
  const ico = iconRoutes["/favicon.ico"]();
  expect(ico.headers.get("content-type")).toBe("image/x-icon");
  const body = Buffer.from(await ico.arrayBuffer());
  // An ICO of PNGs: 16, 32 and 48 px.
  expect(body.readUInt16LE(2)).toBe(1);
  expect(Array.from({ length: body.readUInt16LE(4) }, (_, i) => body[6 + 16 * i])).toEqual([16, 32, 48]);
  expect(iconRoutes["/apple-touch-icon.png"]().headers.get("content-type")).toBe("image/png");
  expect(fileRoute("favicon.svg").headers.get("content-type")).toBe("image/svg+xml");
  for (const file of ["nope.png", "..", "../index.html", "%2e%2e%2findex.html"]) expect(fileRoute(file).status).toBe(404);
});

test("the in-app mark draws the design's current shapes", () => {
  // src/components/markPaths.ts is written by design/ring-slash/build.ts: run it after changing the design.
  expect<object>(MARK.full).toEqual(full);
  expect<object>(MARK.small).toEqual(small);
});
