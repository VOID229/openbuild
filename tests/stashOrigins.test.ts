// The stash in the real app, in a real Chrome, against a throwaway server: what was stashed at one
// address (and what an older build kept only in that address's IndexedDB) is there at another
// address after the server restarts, pictures and held files included, and can be used from there.
// 127.0.0.1 and localhost are the same server at two origins, as a LAN IP and a Tailscale name are.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";
import { ThrowawayServer } from "./stashServer";

const server = new ThrowawayServer();
let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  await server.start();
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server.dispose();
});

const serverIds = async () => (await server.json<{ ids: string[] }>("/api/stashes/threads")).ids;
async function until(check: () => Promise<boolean>, what: string, within = 15_000) {
  for (const deadline = Date.now() + within; Date.now() < deadline; await Bun.sleep(50)) if (await check()) return;
  throw new Error(`Timed out: ${what}`);
}

/**
 * A server without Pi, which is what CI has, greets with a popup (HarnessSetup) that takes the
 * keyboard. It opens whenever the server's answer about what's installed comes back, so it could
 * land before the typing below or in the middle of it, and the typed draft then went to the
 * popup's button instead of the composer: the test passed or failed by that race. The server is
 * asked here the same thing the app asks; when a popup is coming it's waited for and closed, as
 * anyone would close it. Closed in a tab, it stays closed there, reloads included.
 */
async function closeSetupPopup(page: Page) {
  const { runtimes } = await server.json<{ runtimes: { pi?: { installed?: boolean } } }>("/api/runtimes");
  if (!runtimes.pi || runtimes.pi.installed === true) return;
  await page.until("!!document.querySelector('.modal.hs .modal-close')", 30_000);
  await page.eval("document.querySelector('.modal.hs .modal-close').click(), true");
  await page.until("!document.querySelector('.modal.hs')", 30_000);
}

const PICTURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.skipIf(!browser)("a stash made at one address is there at another after a restart, with its picture and its file", async () => {
  const legacyId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  // The server bundles the app for the first page: on a busy machine that alone takes a while.
  const lan = await Page.open(chrome!.ws, `${server.url}/`, 1200, 800, "!!document.querySelector('.composer-input')");
  await closeSetupPopup(lan);
  // What an older build left in this address's IndexedDB: a stash with a picture and a held file.
  await lan.eval(`(async () => {
    const put = (db, store, key, value) => new Promise((resolve, reject) => {
      const open = indexedDB.open(db);
      open.onupgradeneeded = () => open.result.createObjectStore(store);
      open.onsuccess = () => {
        const tx = open.result.transaction(store, "readwrite");
        tx.objectStore(store).put(value, key);
        tx.oncomplete = () => { open.result.close(); resolve(true); };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    await put("openbuild-held-files", "files", ${JSON.stringify(fileId)}, { file: new File(["the archive's bytes"], "notes.zip", { type: "application/zip" }), at: Date.now() });
    await put("openchat-stash", "stash", ${JSON.stringify(legacyId)}, {
      id: ${JSON.stringify(legacyId)}, text: "kept at the LAN address", createdAt: Date.now() - 60000,
      files: [
        { id: "pic", name: "shot.png", mime: "image/png", size: 70, dataUrl: ${JSON.stringify(PICTURE)} },
        { id: ${JSON.stringify(fileId)}, name: "notes.zip", mime: "application/zip", size: 19, dataUrl: "", local: true },
      ],
    });
    return true;
  })()`);
  await lan.send("Page.reload");
  await lan.until("!!document.querySelector('.composer-input')", 30_000);
  await until(async () => (await serverIds()).includes(legacyId), "the older build's stash reaching the server", 30_000);
  expect(await (await fetch(`${server.url}/api/stash-files/${fileId}`)).text()).toBe("the archive's bytes");

  // Stash a draft with the shortcut, as you would.
  await lan.until("document.querySelector('.stash-count')?.textContent === '1'");
  await lan.eval("document.querySelector('.composer-input').focus()");
  await lan.send("Input.insertText", { text: "stashed over the LAN" });
  await lan.until("document.querySelector('.composer-input').value === 'stashed over the LAN'");
  const mod = await lan.eval<number>("/Mac/.test(navigator.platform) ? 4 : 2");
  for (const type of ["rawKeyDown", "keyUp"]) await lan.send("Input.dispatchKeyEvent", { type, key: "s", code: "KeyS", windowsVirtualKeyCode: 83, modifiers: mod });
  // Stashed: the box is empty again.
  await lan.until("document.querySelector('.composer-input').value === '' && document.querySelector('.stash-count')?.textContent === '2'");
  await until(async () => (await serverIds()).length === 2, "the new stash reaching the server", 30_000);

  await server.restart();

  // Another address, opened for the first time: a browser storage of its own, empty.
  const tail = await Page.open(chrome!.ws, `http://localhost:${server.port}/`, 1200, 800, "!!document.querySelector('.composer-input')");
  // A new address is a new tab's storage: the popup greets there too.
  await closeSetupPopup(tail);
  await tail.until("document.querySelector('.stash-count')?.textContent === '2'", 30_000);
  // Clicked in the page: where the tab is on screen can still move while the app finishes loading.
  await tail.eval("document.querySelector('.stash-tab-btn').click(), true");
  await tail.until("document.querySelectorAll('.stash-row').length === 2");
  expect(await tail.eval<string[]>("[...document.querySelectorAll('.stash-row .queued-text')].map((e) => e.textContent)")).toEqual(["stashed over the LAN", "kept at the LAN address"]);
  expect(await tail.eval<string | null>("document.querySelectorAll('.stash-row')[1].querySelector('.queued-thumb')?.getAttribute('src') ?? null")).toBe(PICTURE);

  // Use the one with the file: it's in the box, and this browser can send the file (the server has it).
  await tail.eval("document.querySelectorAll('.stash-row .stash-use')[1].click(), true");
  await tail.until("document.querySelector('.composer-input').value === 'kept at the LAN address'");
  await tail.until("document.body.innerText.includes('notes.zip')");
  await tail.settle();
  await Bun.sleep(300);
  expect(await tail.eval<boolean>("document.body.innerText.includes('Not on this device')")).toBe(false);
  // Used is gone, everywhere.
  await until(async () => !(await serverIds()).includes(legacyId), "the used stash leaving the server", 30_000);
  expect((await serverIds()).length).toBe(1);
}, 180_000);
