// Exercise the real startup tree and transport, with APIs held pending beyond preload's old deadline.
import { expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

test.skipIf(!browser)("/bots paints while thread and bot APIs are pending", async () => {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const server = Bun.spawn([process.execPath, "server/index.ts"], {
    env: { ...process.env, PORT: String(port), NODE_ENV: "development" }, stdout: "ignore", stderr: "ignore",
  });
  let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
  try {
    const url = `http://localhost:${port}`;
    let ready = false;
    for (let i = 0; i < 200; i++) {
      if (await fetch(`${url}/api/auth/status`).then(r => r.ok, () => false)) { ready = true; break; }
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    chrome = await launchChrome();
    const page = await Page.open(chrome.ws, "about:blank", 1200, 800, "true");
    await page.send("Page.enable");
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.releaseBots = [];
      const original = window.fetch;
      window.fetch = (input, init) => {
        const path = new URL(String(input), location.href).pathname;
        if (path === '/api/chats') return new Promise(() => {});
        if (path.endsWith('/api/bots') || path.endsWith('/api/bots/stream'))
          return new Promise(resolve => window.releaseBots.push(() => resolve(original(input, init))));
        return original(input, init);
      };
    ` });
    await page.send("Page.navigate", { url: `${url}/bots` });
    await page.until("document.querySelector('.bots-view [role=status]')?.textContent.includes('Loading OpenBots')");
    expect(await page.eval<string>("document.querySelector('main').innerText")).toContain("Loading OpenBots");
    await page.eval("window.releaseBots.forEach(release => release())");
    // The thread index is still pending: a bot response alone must make the main pane usable.
    await page.until("!!document.querySelector('.bots-hello button, .bots-chat')");
    expect(await page.eval<boolean>("document.querySelector('main').innerText.length > 0")).toBe(true);
  } finally {
    await chrome?.close();
    server.kill();
    await server.exited;
  }
}, 60_000);
