// Build the hosted website for Vercel (https://openchat.shade-io.com), in Vercel's Build Output API
// format (.vercel/output), which Vercel deploys as-is:
//
//   static/              the app (index.html + hashed JS/CSS/fonts), served from Vercel's CDN
//   static/api/config.json   tells the app it's the hosted site, and which sync service to use
//   functions/api/chat   the chat relay   ┐ Edge Functions: they forward each request with the
//   functions/api/models key check        │ keys it carries, and store or log nothing
//   functions/api/verify-search           ┘ search key / SearXNG check
//   config.json          routes and security headers
//
//   bun run build
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CLOUD_URL } from "../shared/cloud";

const root = join(import.meta.dir, "..");
const out = join(root, ".vercel", "output");
const cloudUrl = process.env.OPENCHAT_CLOUD_URL || CLOUD_URL;

async function check(result: Awaited<ReturnType<typeof Bun.build>>, what: string) {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Building ${what} failed`);
  }
}

await rm(out, { recursive: true, force: true });

// 1. The app.

await check(
  await Bun.build({
    entrypoints: [join(root, "src", "index.html")],
    outdir: join(out, "static"),
    minify: true,
    publicPath: "/",
    naming: { entry: "[name].[ext]", chunk: "assets/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },

    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  }),
  "the app",
);
// Bun's CSS bundler inlines every font as base64, which made the stylesheet ~1.8 MB. Move them out
// to cacheable files: the browser then downloads only the few (woff2) faces a page actually uses.
for (const css of new Bun.Glob("assets/*.css").scanSync(join(out, "static"))) {
  const path = join(out, "static", css);
  const source = await Bun.file(path).text();
  const fonts = new Map<string, string>();
  for (const [, mime, data] of source.matchAll(/url\(data:font\/([a-z0-9]+);base64,([A-Za-z0-9+/=]+)\)/g)) {
    const bytes = Buffer.from(data!, "base64");
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 12);
    const name = `assets/font-${hash}.${mime}`;
    if (!fonts.has(name)) await Bun.write(join(out, "static", name), bytes);
    fonts.set(name, name);
  }
  await Bun.write(path, source.replace(/url\(data:font\/([a-z0-9]+);base64,([A-Za-z0-9+/=]+)\)/g, (_, mime: string, data: string) => {
    const hash = new Bun.CryptoHasher("sha256").update(Buffer.from(data, "base64")).digest("hex").slice(0, 12);
    return `url(/assets/font-${hash}.${mime})`;
  }));
}

await Bun.write(join(out, "static", "api", "config.json"), JSON.stringify({ mode: "hosted", convexUrl: cloudUrl || null }));

// 2. The relay functions, each bundled into one self-contained file.
for (const name of ["chat", "models", "verify-search"]) {
  const dir = join(out, "functions", "api", `${name}.func`);
  await check(
    await Bun.build({
      entrypoints: [join(root, "server", "vercel", `${name}.ts`)],
      outdir: dir,
      target: "browser",
      format: "esm",
      minify: true,
      naming: "index.js",
    }),
    `the ${name} function`,
  );
  await Bun.write(join(dir, ".vc-config.json"), JSON.stringify({ runtime: "edge", entrypoint: "index.js" }));
}

// 3. Routes and headers. The CSP only lets the page talk to this site and the sync service, and
// load nothing from anywhere else (no third-party scripts, fonts or images: nothing to track you).
const html = await Bun.file(join(out, "static", "index.html")).text();
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
const hashes = await Promise.all(
  inline.map(async (code) => `'sha256-${Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))).toString("base64")}'`),
);
const sync = cloudUrl ? new URL(cloudUrl) : undefined;
const csp = [
  "default-src 'self'",
  `script-src 'self' ${hashes.join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${sync ? ` https://${sync.host} wss://${sync.host}` : ""}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

const security = {
  "Content-Security-Policy": csp,
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
};

await Bun.write(
  join(out, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: "/(.*)", headers: security, continue: true },
        { src: "/assets/(.*)", headers: { "Cache-Control": "public, max-age=31536000, immutable" }, continue: true },
        { src: "/api/config", dest: "/api/config.json", headers: { "Cache-Control": "no-cache" } },
        { handle: "filesystem" },
        { src: "/api/(.*)", status: 404, dest: "/404" },
        { src: "/(.*)", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);

console.log(`Built the hosted site into .vercel/output${cloudUrl ? ` (sync: ${cloudUrl})` : " (no sync service configured)"}`);
