// The app's icons at fixed URLs. index.html links its own through the bundle, but the web manifest is
// copied as is, so its icons need addresses that don't change with a build; and browsers and iOS ask
// for /favicon.ico and /apple-touch-icon.png by themselves. Built by design/ring-slash/build.ts.
import { join } from "node:path";

const DIR = join(import.meta.dir, "../src/icons");
const TYPES: Record<string, string> = { ico: "image/x-icon", png: "image/png", svg: "image/svg+xml" };
const FILES = new Set(["favicon.ico", "favicon.svg", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]);

function icon(name: string): Response {
  if (!FILES.has(name)) return new Response("Not found", { status: 404 });
  return new Response(Bun.file(join(DIR, name)), {
    headers: { "content-type": TYPES[name.split(".").pop()!]!, "cache-control": "public, max-age=86400" },
  });
}

export const iconRoutes = {
  "/favicon.ico": () => icon("favicon.ico"),
  "/apple-touch-icon.png": () => icon("apple-touch-icon.png"),
  "/apple-touch-icon-precomposed.png": () => icon("apple-touch-icon.png"),
  "/icons/:file": (req: Bun.BunRequest<"/icons/:file">) => icon(req.params.file),
};
