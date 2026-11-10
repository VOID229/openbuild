// The machines bots reach, in a real Chrome on a desktop and a phone, light and dark: Settings →
// Bots lists every machine read-only, with what each allows; a machine opens that device's page in
// Settings → Devices, marked; and each device there says what this server's bots may do on it, with
// the isolation chosen per machine on its page. The server is faked (fixtures/botMachines/page.tsx).
// Set OPENBUILD_SCREENSHOTS to a folder to keep a picture of each state.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const shots = process.env.OPENBUILD_SCREENSHOTS;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/botMachines/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page } });
  chrome = await launchChrome();
  if (shots) await mkdir(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const LISTED = "document.querySelectorAll('.bot-machine').length === 4";

async function shoot(page: Page, name: string) {
  if (!shots) return;
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(shots, `machines-${name}.png`), Buffer.from(data, "base64"));
}

/** Whether anything spills sideways, out of the page or the settings pane. */
const spill = (page: Page) =>
  page.eval<{ page: number; pane: number; outside: string[] }>(`(() => {
    const pane = document.querySelector('.settings-content');
    const box = pane.getBoundingClientRect();
    const outside = [...pane.querySelectorAll('.bot-machine, .device-row, .bot-on-device, .select-trigger')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.left < box.left - 0.5 || r.right > box.right + 0.5); })
      .map((el) => el.className);
    return { page: document.documentElement.scrollWidth - innerWidth, pane: pane.scrollWidth - pane.clientWidth, outside };
  })()`);

const sizes = [["desktop", 1280, 860], ["phone", 390, 844]] as const;

for (const [device, width, height] of sizes) {
  for (const theme of ["light", "dark"] as const) {
    test.skipIf(!browser)(`on a ${device} in ${theme}: a bot's settings list every machine, read-only, and fit`, async () => {
      const page = await Page.open(chrome!.ws, `${server!.url}?theme=${theme}`, width, height, LISTED);
      await page.settle();
      await shoot(page, `${device}-${theme}-bots`);
      const rows = await page.eval<{ name: string; status: string; text: string; note: string }[]>(
        `[...document.querySelectorAll('.bot-machine')].map((r) => ({ name: r.querySelector('.pi-row-name').firstChild.textContent, status: r.querySelector('.device-status').textContent, text: r.textContent, note: r.querySelector('.bot-machine-note')?.dataset.tooltip ?? '' }))`,
      );
      expect(rows.map((r) => [r.name, r.status])).toEqual([
        ["Studio iMac", "This server"],
        ["MacBook Pro of someone with a long machine name", "Doesn't allow bots"],
        ["Cloud VM", "Allows bots"],
        ["Old Mini", "Unreachable"],
      ]);
      // How to allow it is a few words in the row, the steps in their tooltip.
      expect(rows[1]!.text).toContain("How to allow");
      expect(rows[1]!.note).toContain("Settings → Devices → Using this device → Studio iMac");
      expect(rows[2]!.text).toContain("Files and terminal · Container");
      // Nothing to choose: no select at all, and every machine is a link to its device.
      expect(await page.eval<number>("document.querySelectorAll('.settings-content [aria-haspopup=\"listbox\"]').length")).toBe(0);
      expect(await page.eval<number>("document.querySelectorAll('.bot-machine button.bot-machine-link').length")).toBe(4);
      expect(await spill(page)).toEqual({ page: expect.any(Number), pane: expect.any(Number), outside: [] });
      const { page: wide, pane } = await spill(page);
      expect(wide).toBeLessThanOrEqual(0);
      expect(pane).toBeLessThanOrEqual(0);
      // The links are big enough to hit with a finger.
      const heights = await page.eval<number[]>("[...document.querySelectorAll('.bot-machine-link')].map((b) => b.getBoundingClientRect().height)");
      for (const h of heights) expect(h).toBeGreaterThanOrEqual(32);
    });

    test.skipIf(!browser)(`on a ${device} in ${theme}: a machine opens its device's page in Settings → Devices, marked, where its isolation is chosen`, async () => {
      const page = await Page.open(chrome!.ws, `${server!.url}?theme=${theme}`, width, height, LISTED);
      await page.settle();
      await page.click(".bot-machine:nth-child(3) .bot-machine-link");
      await page.until("!!document.querySelector('#device-vm .bot-on-device')");
      await page.settle();
      await shoot(page, `${device}-${theme}-devices`);
      const look = await page.eval<Record<string, any>>(`(() => {
        const pane = document.querySelector('.settings-content').getBoundingClientRect();
        const row = document.querySelector('#device-vm').getBoundingClientRect();
        return {
          section: store.getState().settingsSection,
          page: store.getState().settingsPage,
          title: document.querySelector('.subpage-title').textContent,
          focused: document.activeElement?.id,
          marked: [...document.querySelectorAll('.device-row-focused')].map((e) => e.id),
          inView: row.top >= pane.top - 0.5 && row.bottom <= pane.bottom + 0.5,
          ring: getComputedStyle(document.querySelector('#device-vm')).boxShadow,
          vm: document.querySelector('#device-vm').textContent,
          rows: document.querySelectorAll('.device-row').length,
        };
      })()`);
      // The device's own page, with only that device on it.
      expect(look.section).toBe("devices");
      expect(look.page).toBe("device/vm");
      expect(look.title).toBe("Cloud VM");
      expect(look.rows).toBe(1);
      expect(look.focused).toBe("device-vm");
      expect(look.marked).toEqual(["device-vm"]);
      expect(look.inView).toBe(true);
      expect(look.ring).not.toBe("none");
      expect(look.vm).toContain("Studio iMac's bots · Allows bots · Files and terminal · Container");
      expect(look.vm).toContain("Container only: Cloud VM hasn't allowed Unisolated");
      // The VM offers only a container.
      expect(await page.eval<boolean>(`document.querySelector('[aria-label="Isolation on Cloud VM"]').disabled`)).toBe(true);
      const { page: wide, outside } = await spill(page);
      expect(wide).toBeLessThanOrEqual(0);
      expect(outside).toEqual([]);

      // Back on the list, each device says what this server's bots may do there, and opens its own page.
      await page.eval("store.setState({ settingsPage: undefined })");
      await page.until("!!document.querySelector('#device-local .device-link')");
      expect(await page.eval<string>("document.querySelector('#device-local').textContent")).toContain("Bots always allowed");
      expect(await page.eval<string>("document.querySelector('#device-vm').textContent")).toContain("Allows bots · Files and terminal · Container");
      expect((await spill(page)).outside).toEqual([]);
      await page.click("#device-local .device-link");
      await page.until("!!document.querySelector('#device-local .bot-on-device')");
      await page.settle();
      expect(await page.eval<string>("document.querySelector('#device-local').textContent")).toContain("This server's bots · always allowed");

      // This server takes Host, saved for this server alone.
      await page.click('[aria-label="Isolation on Studio iMac"]');
      await page.until(`!!document.querySelector('[role="listbox"][aria-label="Isolation on Studio iMac"]')`);
      expect(await page.eval<string[]>(`[...document.querySelectorAll('[role="listbox"][aria-label="Isolation on Studio iMac"] [role="option"]')].map((o) => o.textContent)`)).toEqual(["Container", "Host (unisolated)"]);
      await page.click('[role="listbox"][aria-label="Isolation on Studio iMac"] [role="option"]:nth-child(2)');
      await page.until(`document.querySelector('[aria-label="Isolation on Studio iMac"]').textContent === "Host (unisolated)"`);
      expect(await page.eval<unknown>("window.saved")).toEqual([{ device: "local", isolation: "host" }]);
      expect(await page.eval<string>(`document.querySelector('#device-local .bot-access-title').textContent`)).toContain("Host (unisolated)");
    });
  }
}
