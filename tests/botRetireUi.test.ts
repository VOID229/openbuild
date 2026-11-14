// Retiring a bot in the app, in a real Chrome: the confirmation that asks first, the collapsed
// "Retired" section its chat moves to, the chat left to read with a clear mark and no composer, the
// mention picker and group without it, and the way back or on to deleting it for good.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botRetire/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const open = () => Page.open(chrome!.ws, server!.url.href, 1280, 860, "document.querySelectorAll('.bots-row, .bots-tile').length >= 3 && !!document.querySelector('.bots-chat')");

/** The sidebar row of the chat called `name`. */
const row = (name: string) => `[...document.querySelectorAll('.bots-row')].find((r) => r.querySelector('.bots-row-title')?.textContent === ${JSON.stringify(name)})`;
/** Right-clicks that row, and waits for its menu. */
async function menu(page: Page, name: string) {
  await page.eval(`(() => { const r = ${row(name)}.getBoundingClientRect(); ${row(name)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.y + 10 })); return true; })()`);
  await page.until("document.querySelector('.bots-menu')?.dataset.state === 'open'");
  return page.eval<{ label: string; disabled: boolean; danger: boolean }[]>(`[...document.querySelectorAll('.bots-menu > .menu-item, .bots-menu > .filter-row > .menu-item')].map((b) => ({ label: b.textContent.trim(), disabled: b.disabled, danger: b.classList.contains('menu-item-danger') }))`);
}
const pick = (page: Page, label: string) => page.eval(`[...document.querySelectorAll('.bots-menu .menu-item')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`);
/** The open confirmation: its words, and how its buttons read. */
const dialog = (page: Page) =>
  page.eval<{ title: string; body: string; buttons: { text: string; tone: string; icon: string }[] } | null>(`(() => {
    const d = document.querySelector('dialog.confirm-dialog[open]');
    return d && { title: d.querySelector('h2').textContent, body: d.querySelector('p').textContent, buttons: [...d.querySelectorAll('.confirm-actions .btn')].map((b) => ({ text: b.textContent.trim(), tone: b.classList.contains('btn-danger') ? 'danger' : b.classList.contains('btn-calm') ? 'calm' : 'plain', icon: [...(b.querySelector('svg')?.classList ?? [])].find((c) => c.startsWith('lucide-') && c !== 'lucide-icon') ?? '' })) };
  })()`);
const press = (page: Page, text: string) => page.eval(`[...document.querySelectorAll('dialog.confirm-dialog[open] .btn')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`);
/** The sidebar as it reads: the rows in the open list, and the Retired section. */
const sidebar = (page: Page) =>
  page.eval<{ listed: string[]; retired: string[]; open: boolean; count: string; last: boolean }>(`(() => {
    const section = document.querySelector('.bots-section[data-section="retired"]');
    const inSection = (r) => !!r.closest('.bots-section[data-section="retired"]');
    const title = (r) => r.querySelector('.bots-row-title').textContent;
    const rows = [...document.querySelectorAll('.bots-row')];
    return {
      listed: [...document.querySelectorAll('.bots-tile-name')].map((t) => t.textContent).concat(rows.filter((r) => !inSection(r)).map(title)),
      retired: rows.filter(inSection).map(title),
      open: section?.querySelector('.history-heading-toggle').getAttribute('aria-expanded') === 'true',
      count: section?.querySelector('.bots-section-count')?.textContent ?? '',
      last: !!section && !section.nextElementSibling,
    };
  })()`);
const calls = (page: Page) => page.eval<string[]>("workspace.calls");
const members = (page: Page, id: string) => page.eval<string[]>(`bots.getState().conversations.find((c) => c.id === ${JSON.stringify(id)}).botIds`);

describe.skipIf(!browser)("retiring a bot in the app", () => {
  test("Retire asks first, in the delete dialog's shape, with an archive icon and a calm button, not the red one", async () => {
    const page = await open();
    // A retired bot is already there: filed last, under Retired, folded until it's opened.
    expect(await sidebar(page)).toEqual({ listed: ["Dr Eggbot", "Team", "obsidian", "Tracer"], retired: ["Scout"], open: false, count: "1", last: true });
    expect(await page.eval<boolean>(`${row("Scout")}.closest('.collapse').inert`)).toBe(true);

    // A bot's menu offers Retire where Delete was; deleting isn't offered on a bot at work.
    const items = await menu(page, "obsidian");
    expect(items.map((i) => i.label)).toContain("Retire bot");
    expect(items.some((i) => /Delete/.test(i.label))).toBe(false);
    expect(items.find((i) => i.label === "Retire bot")).toEqual({ label: "Retire bot", disabled: false, danger: false });
    await pick(page, "Retire bot");
    await page.until("!!document.querySelector('dialog.confirm-dialog[open]')");
    expect(await dialog(page)).toEqual({
      title: "Retire “obsidian”?",
      body: "It keeps its memory, instructions and routines, but can't be mentioned or used until you rehire it. Your other bots will be told. You can rehire it or delete it for good anytime.",
      buttons: [
        { text: "Cancel", tone: "plain", icon: "" },
        { text: "Retire", tone: "calm", icon: "lucide-archive" },
      ],
    });
    // The same component as the delete dialog: same box, the button in the page's own ink where Delete's is red.
    const look = await page.eval<{ box: string; color: string; danger: string; text: string }>(`(() => {
      const d = document.querySelector('dialog.confirm-dialog[open]');
      const root = getComputedStyle(document.documentElement);
      const probe = document.body.appendChild(document.createElement('i'));
      const as = (v) => { probe.style.color = v; return getComputedStyle(probe).color; };
      const out = { box: d.className, color: getComputedStyle(d.querySelector('.btn-calm')).color, danger: as(root.getPropertyValue('--danger')), text: as(root.getPropertyValue('--text')) };
      probe.remove();
      return out;
    })()`);
    expect(look.box).toBe("confirm-dialog bots-small-dialog");
    expect(look.color).toBe(look.text);
    expect(look.color).not.toBe(look.danger);
    // Cancel leaves it as it was, and nothing is asked of the workspace.
    await press(page, "Cancel");
    await page.until("!document.querySelector('dialog.confirm-dialog[open]')");
    expect(await calls(page)).toEqual([]);
    expect((await sidebar(page)).retired).toEqual(["Scout"]);

    // The primary bot can't be retired.
    const primary = await menu(page, "Tracer");
    expect(primary.find((i) => i.label === "Retire bot")?.disabled).toBe(false);
    await page.eval("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await page.eval("bots.getState().togglePin('egg-chat')");
    await page.until(`!!${row("Dr Eggbot")}`);
    expect((await menu(page, "Dr Eggbot")).find((i) => i.label === "Retire bot")?.disabled).toBe(true);
  }, 60_000);

  test("retired, its chat moves under Retired and stays to read: marked, with no composer, out of the group and the mention picker", async () => {
    const page = await open();
    expect(await page.eval<boolean>("!!document.querySelector('.bots-composer')")).toBe(true);
    await menu(page, "obsidian");
    await pick(page, "Retire bot");
    await page.until("!!document.querySelector('dialog.confirm-dialog[open]')");
    await press(page, "Retire");
    await page.until("!document.querySelector('dialog.confirm-dialog[open]') && !!document.querySelector('.bots-retired-note')");
    expect(await calls(page)).toEqual(["POST /api/bots/obsidian/retire"]);

    // Out of the list, into the section at the bottom, which stays folded.
    expect(await sidebar(page)).toEqual({ listed: ["Dr Eggbot", "Team", "Tracer"], retired: ["obsidian", "Scout"], open: false, count: "2", last: true });
    // Its chat is still open and readable: every message is there, under a clear mark.
    const chat = await page.eval<{ texts: string[]; mark: string; note: string; rehire: boolean; composer: boolean; field: boolean; question: boolean; actions: number }>(`(() => ({
      texts: [...document.querySelectorAll('.bots-chat .bm-text')].map((t) => t.textContent),
      mark: document.querySelector('.bots-head .bots-head-retired')?.textContent ?? '',
      note: document.querySelector('.bots-retired-note-text')?.textContent ?? '',
      rehire: [...document.querySelectorAll('.bots-retired-note .btn')].some((b) => b.textContent.trim() === 'Rehire'),
      composer: !!document.querySelector('.bots-composer'),
      field: !!document.querySelector('.bots-chat textarea'),
      question: !!document.querySelector('.bm-card-frozen[inert] .bm-question'),
      actions: document.querySelectorAll('.bots-chat .bm-actions').length,
    }))()`);
    expect(chat).toEqual({
      texts: ["Can you file yesterday's meeting notes?", "Filed under Meetings, with the action items pulled out at the top."],
      mark: "Retired",
      note: "obsidian is retired. This chat is read-only until you rehire it.",
      rehire: true,
      composer: false,
      field: false,
      // Its unanswered question shows what was asked and takes no answer; no message offers a reply or a reaction.
      question: true,
      actions: 0,
    });
    // The mark shows without hovering the header, unlike the name beside it.
    expect(await page.eval<boolean>(`(() => { const r = document.querySelector('.bots-head-retired').getBoundingClientRect(); return r.width > 20 && r.height > 8 && getComputedStyle(document.querySelector('.bots-head-retired')).opacity === '1'; })()`)).toBe(true);

    // It left the group, so the group's mention picker doesn't offer it.
    expect(await members(page, "team")).toEqual(["egg", "tracer"]);
    await page.eval("bots.getState().select('team')");
    await page.until("!!document.querySelector('.bots-composer textarea')");
    await page.click(".bots-composer textarea");
    await page.send("Input.insertText", { text: "@" });
    await page.until("!!document.querySelector('.bots-mentions')");
    const offered = await page.eval<string[]>("[...document.querySelectorAll('.bots-mentions [role=option]')].map((o) => o.textContent.trim())");
    expect(offered.some((o) => o.includes("Dr Eggbot"))).toBe(true);
    expect(offered.some((o) => o.includes("Tracer"))).toBe(true);
    expect(offered.some((o) => /obsidian|Scout/.test(o))).toBe(false);
    // Its routines are paused, and can't be turned on while it's away.
    expect(await page.eval<boolean[]>("bots.getState().bots.find((b) => b.id === 'obsidian').routines.map((r) => r.enabled)")).toEqual([false]);

    // Opened, the section lists the retired bots, each marked.
    await page.eval(`document.querySelector('.bots-section[data-section="retired"] .history-heading-toggle').click()`);
    await page.until(`document.querySelector('.bots-section[data-section="retired"] .history-heading-toggle').getAttribute('aria-expanded') === 'true'`);
    expect(await page.eval<string[]>(`[...document.querySelectorAll('.bots-section[data-section="retired"] .bots-row')].map((r) => r.querySelector('.bots-row-title').textContent + ': ' + (r.querySelector('.bots-retired-pill')?.textContent ?? ''))`)).toEqual(["obsidian: Retired", "Scout: Retired"]);
  }, 60_000);

  test("Delete permanently shows only on a retired bot, with a dialog to match; Rehire brings it back", async () => {
    const page = await open();
    await page.eval(`document.querySelector('.bots-section[data-section="retired"] .history-heading-toggle').click()`);
    await page.finish(".bots-sidebar");
    // A retired bot's menu is the way back, or on: nothing else.
    const items = await menu(page, "Scout");
    expect(items).toEqual([
      { label: "Rehire", disabled: false, danger: false },
      { label: "Mark as unread", disabled: false, danger: false },
      { label: "Rename bot", disabled: false, danger: false },
      { label: "Copy conversation ID", disabled: false, danger: false },
      { label: "Delete permanently", disabled: false, danger: true },
    ]);
    await pick(page, "Delete permanently");
    await page.until("!!document.querySelector('dialog.confirm-dialog[open]')");
    expect(await dialog(page)).toEqual({
      title: "Delete “Scout” permanently?",
      body: "This retired bot, its memory, instructions, routines and conversation are deleted for good. It can't be rehired after this.",
      buttons: [
        { text: "Cancel", tone: "plain", icon: "" },
        { text: "Delete permanently", tone: "danger", icon: "lucide-trash" },
      ],
    });
    await press(page, "Cancel");
    await page.until("!document.querySelector('dialog.confirm-dialog[open]')");
    expect(await calls(page)).toEqual([]);

    // Its chat, opened, offers the way back where the composer was.
    await page.eval("bots.getState().select('scout-chat')");
    await page.until("!!document.querySelector('.bots-retired-note')");
    expect(await page.eval<string>("document.querySelector('.bots-retired-note-text').textContent")).toBe("Scout is retired. This chat is read-only until you rehire it.");
    await page.eval("[...document.querySelectorAll('.bots-retired-note .btn')].find((b) => b.textContent.trim() === 'Rehire').click()");
    await page.until("!!document.querySelector('.bots-composer textarea') && !document.querySelector('.bots-retired-note')");
    expect(await calls(page)).toEqual(["POST /api/bots/scout/rehire"]);
    // Back in the list and in the group it left, and nothing is left under Retired.
    expect(await sidebar(page)).toEqual({ listed: ["Dr Eggbot", "Team", "obsidian", "Tracer", "Scout"], retired: [], open: false, count: "", last: false });
    expect(await members(page, "team")).toEqual(["egg", "obsidian", "tracer", "scout"]);
    expect(await page.eval<boolean>("!!document.querySelector('.bots-head-retired')")).toBe(false);
    // Its routine stays paused until it's turned on.
    expect(await page.eval<boolean[]>("bots.getState().bots.find((b) => b.id === 'scout').routines.map((r) => r.enabled)")).toEqual([false]);

    // Deleting for good, from Retired: the workspace is asked to delete, and the bot and its chat go.
    await menu(page, "obsidian");
    await pick(page, "Retire bot");
    await page.until("!!document.querySelector('dialog.confirm-dialog[open]')");
    await press(page, "Retire");
    await page.until(`(${row("obsidian")})?.closest('.bots-section')?.dataset.section === 'retired'`);
    await menu(page, "obsidian");
    await pick(page, "Delete permanently");
    await page.until("!!document.querySelector('dialog.confirm-dialog[open]')");
    await press(page, "Delete permanently");
    await page.until("!bots.getState().bots.some((b) => b.id === 'obsidian')");
    expect(await calls(page)).toEqual(["POST /api/bots/scout/rehire", "POST /api/bots/obsidian/retire", "DELETE /api/bots/obsidian"]);
    expect(await page.eval<boolean>("bots.getState().conversations.some((c) => c.id === 'obsidian-chat')")).toBe(false);
  }, 60_000);
});
