// The app as production serves it. Bun's HTML route (development, with hot reloading) inlines every
// font into the stylesheet: 2 MB of it, mostly subsets and fallbacks a browser never uses, that has
// to arrive and be parsed before anything paints. Here fonts stay files of their own, the page
// preloads the ones its font setting paints with, and each file is compressed once per encoding
// rather than sent as is (over Tailscale or a LAN, ~5.5 MB of assets becomes ~1 MB).
//
// Still one script, as before: a tab left open across an update never needs a chunk the new
// server doesn't have.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { BunPlugin } from "bun";

const ROOT = join(import.meta.dir, "..");
/** Stylesheets that bring fonts: the @fontsource packages and KaTeX's. */
const FONT_CSS = /node_modules\/(?:@fontsource(?:-variable)?\/[^/]+|katex\/dist)\/[^/]*\.css$/;
const FONT_URL = /url\(\s*(["']?)([^"')]+\.(?:woff2?|ttf))\1\s*\)/g;
/** The files each font setting (styles.css, data-font) paints the first screen with. */
const FIRST_PAINT: Record<string, string[]> = {
  normal: ["inter-latin-opsz-normal.woff2"],
  fun: ["comic-neue-latin-400-normal.woff2", "comic-neue-latin-700-normal.woff2"],
  serif: ["newsreader-latin-wght-normal.woff2"],
  mono: ["geist-mono-latin-wght-normal.woff2"],
};
const FONT_TYPES: Record<string, string> = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf" };
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)/;
const IMMUTABLE = "public, max-age=31536000, immutable";

interface Asset {
  body: Uint8Array<ArrayBuffer>;
  type: string;
  etag: string;
  cache: string;
  /** Compressed copies, filled in the background after the build. */
  br?: Uint8Array<ArrayBuffer>;
  gzip?: Uint8Array<ArrayBuffer>;
}

interface Built {
  assets: Map<string, Asset>;
  /** Fonts by file name: a URL's hash only busts caches, so an older page's URL still finds its font. */
  fonts: Map<string, Asset>;
  page: Asset;
}

const etagOf = (body: Uint8Array) => `"${Bun.hash(body).toString(36)}"`;

/** Rewrites font stylesheets to point at /fonts/<hash>/<file>, served by this module. */
function fontFiles(fonts: Map<string, Asset>): BunPlugin {
  return {
    name: "openbuild-font-files",
    setup(build) {
      build.onLoad({ filter: FONT_CSS }, async (args) => {
        const css = (await Bun.file(args.path).text()).replace(FONT_URL, (_, _quote, url: string) => {
          const name = basename(url);
          let font = fonts.get(name);
          if (!font) {
            const body = new Uint8Array(readFileSync(join(dirname(args.path), url)));
            font = { body, type: FONT_TYPES[name.split(".").pop()!] ?? "application/octet-stream", etag: etagOf(body), cache: IMMUTABLE };
            fonts.set(name, font);
          }
          return `url("/fonts/${font.etag.slice(1, -1)}/${name}")`;
        });
        return { contents: css, loader: "css" };
      });
      build.onResolve({ filter: /^\/fonts\// }, (args) => ({ path: args.path, external: true }));
    },
  };
}

/** Starts the preloads for the page's font setting before the stylesheet, so text never paints in a fallback first. */
function preloadScript(fonts: Map<string, Asset>) {
  const urls = Object.fromEntries(Object.entries(FIRST_PAINT).map(([setting, names]) => [
    setting,
    names.flatMap((name) => { const font = fonts.get(name); return font ? [`/fonts/${font.etag.slice(1, -1)}/${name}`] : []; }),
  ]));
  return `(function(){var f=${JSON.stringify(urls)}[document.documentElement.dataset.font]||[];for(var i=0;i<f.length;i++){var l=document.createElement("link");l.rel="preload";l.as="font";l.type="font/woff2";l.crossOrigin="anonymous";l.href=f[i];document.head.appendChild(l);}})();`;
}

async function compress(asset: Asset) {
  if (!COMPRESSIBLE.test(asset.type) || asset.body.byteLength < 1024) return;
  // zlib's async API runs on the thread pool, so requests keep being answered meanwhile.
  const [br, gz] = await Promise.all([
    promisify(brotliCompress)(asset.body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: asset.body.byteLength } }),
    promisify(gzip)(asset.body, { level: 9 }),
  ]);
  asset.br = new Uint8Array(br);
  asset.gzip = new Uint8Array(gz);
}

async function build(): Promise<Built> {
  const fonts = new Map<string, Asset>();
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/index.html")],
    target: "browser",
    minify: true,
    // Pages live at nested paths (/bots/thread-…), so assets are addressed from the root.
    publicPath: "/",
    plugins: [fontFiles(fonts)],
  });
  if (!result.success) throw new AggregateError(result.logs, "Couldn't build the app");
  const assets = new Map<string, Asset>();
  let page: Asset | undefined;
  for (const output of result.outputs) {
    const path = `/${output.path.replace(/^\.\//, "")}`;
    let body = new Uint8Array(await output.arrayBuffer());
    if (path === "/index.html") {
      const html = await new HTMLRewriter()
        .on('link[rel="stylesheet"]', { element: (el) => void el.before(`<script>${preloadScript(fonts)}</script>`, { html: true }) })
        .transform(new Response(body))
        .text();
      body = new TextEncoder().encode(html);
      page = { body, type: "text/html;charset=utf-8", etag: etagOf(body), cache: "no-cache" };
      continue;
    }
    assets.set(path, { body, type: output.type, etag: etagOf(body), cache: IMMUTABLE });
  }
  if (!page) throw new Error("The app's build has no index.html");
  void Promise.all([...assets.values(), page].map(compress)).catch((err) => console.warn("[client] Couldn't compress the app:", (err as Error).message));
  return { assets, fonts, page };
}

function respond(req: Request, asset: Asset): Response {
  // Browsers offer br over HTTPS only; plain http:// (a LAN, a tailnet address) gets gzip.
  const accepts = req.headers.get("accept-encoding") ?? "";
  const encoding = asset.br && /\bbr\b/.test(accepts) ? "br" : asset.gzip && /\bgzip\b/.test(accepts) ? "gzip" : undefined;
  // Each encoding is a representation of its own, with its own tag.
  const etag = encoding ? `${asset.etag.slice(0, -1)}-${encoding}"` : asset.etag;
  const headers: Record<string, string> = { "content-type": asset.type, "cache-control": asset.cache, etag };
  if (COMPRESSIBLE.test(asset.type)) headers.vary = "accept-encoding";
  if (req.headers.get("if-none-match")?.split(/\s*,\s*/).includes(etag)) return new Response(null, { status: 304, headers });
  if (encoding) headers["content-encoding"] = encoding;
  return new Response(encoding ? asset[encoding]! : asset.body, { headers });
}

/** The production app: building starts now, and requests wait for it only until it's done. */
export function productionClient() {
  const built = build();
  built.catch((err) => console.error("[client]", err));
  return {
    built,
    async serve(req: Request): Promise<Response> {
      const { assets, fonts, page } = await built;
      const path = new URL(req.url).pathname;
      const asset = assets.get(path);
      if (asset) return respond(req, asset);
      const font = /^\/fonts\/[^/]+\/([^/]+)$/.exec(path);
      if (font) {
        const file = fonts.get(font[1]!);
        return file ? respond(req, file) : new Response("Not found", { status: 404 });
      }
      // A script or stylesheet that isn't in this build is from an older one (a tab left open across
      // an update): fail plainly instead of answering with the page. Anything else is a client route.
      if (/\.(?:js|css|map)$/.test(path)) return new Response("Not found", { status: 404 });
      return respond(req, page);
    },
  };
}
