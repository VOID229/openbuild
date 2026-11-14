// The side panel's browser tab on a localhost dev server, in Chrome, through a real preview
// (server/preview.ts): it keeps its page while other tabs show, reloads without blanking, waits for a
// dev server that isn't up yet, and opens a fresh preview by itself when its cookie is gone.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";
import { createPreview, stopPreviews } from "../server/preview";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;
const stops: (() => void)[] = [];

/** A dev server that counts the times its page was loaded. Its page reloads itself when the panel asks. */
function devServer(port = 0) {
  const counts = { loads: 0 };
  const dev = Bun.serve({
    hostname: "127.0.0.1", port,
    fetch(req) {
      if (new URL(req.url).pathname !== "/") return new Response("Not found", { status: 404 });
      counts.loads++;
      return new Response(`<!doctype html><body style="background:#fff">dev page<script>addEventListener("message", (e) => { if (e.data === "reload") location.reload(); });</script></body>`, { headers: { "content-type": "text/html" } });
    },
  });
  stops.push(() => dev.stop(true));
  return Object.assign(counts, { port: dev.port! });
}

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/browserPanel/index.html`, {
    "/api/preview": async (req) => {
      const body = await req.json();
      try {
        return Response.json({ url: createPreview(new URL(body.url), new URL(req.url)) });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }
    },
  });
  chrome = await launchChrome();
}, 60_000);

afterEach(() => { stopPreviews(); for (const stop of stops.splice(0)) stop(); });
afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const visible = ".side-keep:not([hidden])";
const until = async (check: () => boolean, what: string, within = 10_000) => {
  for (const end = Date.now() + within; Date.now() < end; await Bun.sleep(25)) if (check()) return;
  throw new Error(`Timed out: ${what}`);
};
/** The showing tab's page has loaded: its frame is up and the loading bar is gone. */
const loaded = (page: Page) => page.until(`!!document.querySelector('${visible} iframe.bv-frame:not(.bv-frame-loading)') && !document.querySelector('${visible} .bv-progress')`, 10_000);

test.skipIf(!browser)("a localhost page keeps running while other tabs show, and reloads without blanking", async () => {
  const dev = devServer();
  const page = await Page.open(chrome!.ws, server!.url.href, 1000, 700, "!!window.panel");
  await page.eval(`panel.getState().openBrowser("http://localhost:${dev.port}/"), true`);
  await loaded(page);
  expect(dev.loads).toBe(1);
  expect(await page.eval(`new URL(document.querySelector('${visible} iframe').src).port`)).not.toBe(String(dev.port));

  // Another tab, then back: the same page, not loaded again.
  await page.eval(`(window.first = panel.getState().activeBrowser, panel.getState().openBrowser(""), true)`);
  await page.until(`!document.querySelector('${visible} iframe') && document.querySelectorAll('iframe.bv-frame').length === 1`);
  await page.eval(`panel.getState().activateBrowser(window.first), true`);
  await page.until(`!!document.querySelector('${visible} iframe')`);
  await Bun.sleep(300);
  expect(dev.loads).toBe(1);

  // Reload: the page comes again, and the panel never falls back to "Connecting…" meanwhile.
  await page.eval(`(window.blanked = false, new MutationObserver(() => { if (document.querySelector('${visible} .bv-empty')) window.blanked = true; }).observe(document.body, { subtree: true, childList: true }), true)`);
  await page.click(`${visible} button[aria-label="Reload"]`);
  await until(() => dev.loads === 2, "the reload");
  await loaded(page);
  expect(await page.eval<boolean>("window.blanked")).toBe(false);
}, 40_000);

test.skipIf(!browser)("a page opened before its dev server is up loads by itself once it is", async () => {
  const free = devServer().port;
  stops.splice(0).forEach((stop) => stop());
  const page = await Page.open(chrome!.ws, server!.url.href, 1000, 700, "!!window.panel");
  await page.eval(`panel.getState().openBrowser("http://localhost:${free}/"), true`);
  await loaded(page);
  await Bun.sleep(500);
  const dev = devServer(free);
  await until(() => dev.loads >= 1, "the waiting page to load the dev server's page", 15_000);
}, 40_000);

test.skipIf(!browser)("a preview whose cookie is gone opens afresh by itself", async () => {
  const dev = devServer();
  const page = await Page.open(chrome!.ws, server!.url.href, 1000, 700, "!!window.panel");
  await page.eval(`panel.getState().openBrowser("http://localhost:${dev.port}/"), true`);
  await loaded(page);
  expect(dev.loads).toBe(1);
  await page.send("Network.clearBrowserCookies");
  // The page reloads itself (as a dev server's hot reload does): the preview refuses it without its
  // cookie, and the panel opens it again through a fresh entry.
  await page.eval(`document.querySelector('${visible} iframe').contentWindow.postMessage("reload", "*"), true`);
  await until(() => dev.loads === 2, "the preview to open again");
}, 40_000);
