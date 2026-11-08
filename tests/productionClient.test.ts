import { expect, test } from "bun:test";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { productionClient } from "../server/client";

// The app as production serves it (server/client.ts): built here, in this process, from src/.
const client = productionClient();
const get = (path: string, headers: Record<string, string> = {}) => client.serve(new Request(`http://localhost${path}`, { headers }));
const built = await client.built;
const stylesheet = [...built.assets.keys()].find((p) => p.endsWith(".css"))!;
const script = [...built.assets.keys()].find((p) => p.endsWith(".js"))!;

test("fonts are files of their own, not inlined into the stylesheet the first paint waits for", async () => {
  const css = await (await get(stylesheet)).text();
  expect(css).not.toContain("data:font");
  expect(css.length).toBeLessThan(600_000);
  const url = /url\("?(\/fonts\/[^/]+\/inter-latin-wght-normal\.woff2)"?\)/.exec(css)![1]!;
  const font = await get(url);
  expect(font.status).toBe(200);
  expect(font.headers.get("content-type")).toBe("font/woff2");
  expect(font.headers.get("cache-control")).toContain("immutable");
  // A page from before an update still finds its font by name.
  expect((await get("/fonts/older/inter-latin-wght-normal.woff2")).status).toBe(200);
  expect((await get("/fonts/older/no-such-font.woff2")).status).toBe(404);
});

test("the page preloads the font it's set to paint with, before the stylesheet", async () => {
  const html = await (await get("/")).text();
  const preload = html.indexOf('l.rel="preload"');
  expect(preload).toBeGreaterThan(html.indexOf("dataset.font"));
  expect(preload).toBeLessThan(html.indexOf(`href="${stylesheet}"`));
  expect(html).toContain("comic-neue-latin-400-normal.woff2");
});

test("text files are sent compressed when the browser takes it, and each encoding has its own tag", async () => {
  for (let i = 0; i < 200 && !built.assets.get(script)!.gzip; i++) await Bun.sleep(25);
  const plain = new Uint8Array(await (await get(script)).arrayBuffer());
  const gz = await get(script, { "accept-encoding": "gzip, deflate" });
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  expect(gz.headers.get("vary")).toBe("accept-encoding");
  const gzBody = new Uint8Array(await gz.arrayBuffer());
  expect(gzBody.byteLength).toBeLessThan(plain.byteLength / 2);
  expect(gunzipSync(gzBody).equals(Buffer.from(plain))).toBe(true);
  const br = await get(script, { "accept-encoding": "gzip, deflate, br, zstd" });
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(brotliDecompressSync(new Uint8Array(await br.arrayBuffer())).equals(Buffer.from(plain))).toBe(true);
  expect(new Set([gz.headers.get("etag"), br.headers.get("etag"), (await get(script)).headers.get("etag")]).size).toBe(3);
  // The page is checked again on every load, and unchanged costs a 304.
  const page = await get("/", { "accept-encoding": "gzip" });
  expect(page.headers.get("cache-control")).toBe("no-cache");
  expect((await get("/", { "accept-encoding": "gzip", "if-none-match": page.headers.get("etag")! })).status).toBe(304);
});

test("client routes get the page, and an older build's script fails plainly", async () => {
  for (const path of ["/thread-abc", "/bots/thread-abc", "/settings/profile", "/new"]) {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  }
  expect((await get("/chunk-from-an-older-build.js")).status).toBe(404);
  expect((await get("/chunk-from-an-older-build.css")).status).toBe(404);
});
