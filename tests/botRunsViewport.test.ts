// Opening and folding a run of background actions in an OpenBots chat, in a real Chrome with the whole
// app on a fake server (fixtures/groupThreads): the toggle stays exactly where it is on screen every
// frame, mid-chat and at the very bottom, and the lines ease open and fold away rather than jump.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/groupThreads/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page, "/bots": page, "/bots/*": page } });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

const READY = "window.store?.getState().chatsLoaded && window.bots?.getState().loaded";
const TOGGLE = ".bots-messages .bm-events-toggle";

/** The group chat, long, with a run of 24 background actions `after` messages from its end; each is `ran` (a JS expression of `i`) when given. */
async function open(after: number, { width = 1280, height = 800, ran: each }: { width?: number; height?: number; ran?: string } = {}) {
  const page = await Page.open(chrome!.ws, `${server!.url.href}bots`, width, height, READY);
  await page.eval(`(() => {
    const s = bots.getState();
    const chat = s.conversations.find((c) => c.kind === 'group');
    const bot = chat.botIds[0];
    const t0 = Date.now() - 3_600_000;
    const said = (i) => ({ id: 'm' + i, author: i % 2 ? bot : 'me', at: t0 + i * 1000, text: 'Message ' + i + ' about the build, long enough to take a line or two in the chat.' });
    const ran = (i) => ({ id: 'e' + i, author: bot, at: t0 + 60_000 + i * 1000, text: '', event: ${each ?? "{ kind: 'routine', text: 'Ran a routine', detail: 'Routine ' + (i % 3) }"} });
    const messages = [...Array.from({ length: 40 }, (_, i) => said(i)), ...Array.from({ length: 24 }, (_, i) => ran(i)), ...Array.from({ length: ${after} }, (_, i) => ({ ...said(100 + i), at: t0 + 120_000 + i * 1000 }))];
    bots.setState({ conversations: s.conversations.map((c) => (c.id === chat.id ? { ...c, messages, more: false } : c)), activeId: chat.id });
    // On a phone the sidebar is the list of chats, over the chat: closed, the chat is what shows.
    store.setState({ botsOpen: true, botsSidebarOpen: ${width > 700} });
    return true;
  })()`);
  await page.until(`!!document.querySelector(${JSON.stringify(TOGGLE)})`);
  await page.settle();
  return page;
}

/** Clicks the toggle, then records its top on screen, the chat's scroll and the run's height, every frame. */
const clickAndWatch = (page: Page, ms = 700) =>
  page.eval<{ top: number; scroll: number; body: number }[]>(`new Promise((resolve) => {
    const toggle = document.querySelector(${JSON.stringify(TOGGLE)});
    const chat = document.querySelector('.bots-messages');
    const body = toggle.closest('.bm-events').querySelector('.bm-events-body');
    const frames = [];
    const start = performance.now();
    const read = () => frames.push({ top: toggle.getBoundingClientRect().top, scroll: chat.scrollTop, body: body.getBoundingClientRect().height });
    read();
    toggle.click();
    const tick = () => {
      read();
      if (performance.now() - start < ${ms}) requestAnimationFrame(tick);
      else resolve(frames);
    };
    requestAnimationFrame(tick);
  })`);

describe.skipIf(!browser)("a run of background actions holds the view", () => {
  test("mid-chat: opening and folding it never moves the toggle, and the height eases both ways", async () => {
    const page = await open(30);
    // Bring the toggle to the middle of the view.
    await page.eval(`(() => { const t = document.querySelector(${JSON.stringify(TOGGLE)}); const c = document.querySelector('.bots-messages'); c.scrollTop += t.getBoundingClientRect().top - c.getBoundingClientRect().top - c.clientHeight / 2; return true; })()`);
    await page.settle();
    for (const step of ["open", "fold"]) {
      const frames = await clickAndWatch(page);
      const first = frames[0]!.top;
      expect({ step, moved: Math.max(...frames.map((f) => Math.abs(f.top - first))) }).toEqual({ step, moved: expect.any(Number) });
      expect(Math.max(...frames.map((f) => Math.abs(f.top - first)))).toBeLessThan(1);
      // In between: part-way open, not all at once.
      const heights = frames.map((f) => f.body);
      const end = step === "open" ? Math.max(...heights) : 0;
      expect(end > 100 || step === "fold").toBe(true);
      expect(heights.some((h) => h > 20 && h < Math.max(...heights) - 20)).toBe(true);
      expect(Math.round(heights.at(-1)!)).toBe(Math.round(end));
    }
  }, 60_000);

  test("at the very bottom: folding a long run doesn't pull the view up, nor throw it to the top", async () => {
    const page = await open(2);
    await page.eval("(() => { const c = document.querySelector('.bots-messages'); c.scrollTop = c.scrollHeight; return true; })()");
    await page.settle();
    await clickAndWatch(page);
    await page.eval("(() => { const c = document.querySelector('.bots-messages'); c.scrollTop = c.scrollHeight; return true; })()");
    await page.settle();
    const frames = await clickAndWatch(page);
    const first = frames[0]!;
    expect(Math.max(...frames.map((f) => Math.abs(f.top - first.top)))).toBeLessThan(1);
    expect(Math.min(...frames.map((f) => f.scroll))).toBeGreaterThan(first.scroll - 2);
    expect(frames.at(-1)!.body).toBe(0);

    // Once it's folded, the room kept is only what the view stands on: nothing blank to scroll down into.
    await Bun.sleep(150);
    expect(await page.eval<number>("(() => { const c = document.querySelector('.bots-messages'); return Math.round(c.scrollHeight - c.scrollTop - c.clientHeight); })()")).toBeLessThanOrEqual(1);
    // Scrolling up as a trackpad does, a pixel or two at first: everything moves by just that, never a snap.
    for (const step of [1, 1, 2, 1, 30, 60, 120, 200]) {
      const before = await page.eval<number>(`document.querySelector(${JSON.stringify(TOGGLE)}).getBoundingClientRect().top`);
      await page.eval(`(() => { document.querySelector('.bots-messages').scrollTop -= ${step}; return true; })()`);
      await page.settle();
      await page.settle();
      const after = await page.eval<number>(`document.querySelector(${JSON.stringify(TOGGLE)}).getBoundingClientRect().top`);
      expect({ step, moved: Math.round(after - before) }).toEqual({ step, moved: step });
    }
  }, 60_000);

  test("its label says what was done, and on a phone a long one ends in an ellipsis inside the chat", async () => {
    const page = await open(2, { ran: "{ kind: 'thread', text: 'Closed a thread', detail: 'Thread ' + i, threadId: 't' + i }" });
    expect(await page.eval<string>(`document.querySelector(${JSON.stringify(TOGGLE)}).textContent`)).toBe("Closed 24 threads");

    // Answered, merged and stopped, all with long nouns: too long for a phone's line.
    const mixed = "[{ kind: 'thread', text: 'Answered a permission prompt' }, { kind: 'thread', text: 'Merged a pull request', detail: '#' + i }, { kind: 'thread', text: 'Stopped a thread', detail: 'T' }][i % 3]";
    const phone = await open(2, { width: 360, height: 720, ran: mixed });
    const fit = await phone.eval<{ text: string; one: boolean; clipped: boolean; inside: boolean }>(`(() => {
      const toggle = document.querySelector(${JSON.stringify(TOGGLE)});
      const label = toggle.querySelector('.bm-events-label');
      const chat = document.querySelector('.bots-messages').getBoundingClientRect();
      const box = toggle.getBoundingClientRect();
      return { text: label.textContent, one: box.height <= 24.5, clipped: label.scrollWidth > label.clientWidth, inside: box.left >= chat.left && box.right <= chat.right };
    })()`);
    expect(fit).toEqual({ text: "Answered 8 permission prompts, merged 8 pull requests, stopped 8 threads", one: true, clipped: true, inside: true });
  }, 60_000);

  test("a label cut off shows whole: in a tooltip on hover, to a screen reader, and wrapped once the run is opened", async () => {
    const full = "Answered 8 permission prompts, merged 8 pull requests, stopped 8 threads";
    const mixed = "[{ kind: 'thread', text: 'Answered a permission prompt' }, { kind: 'thread', text: 'Merged a pull request', detail: '#' + i }, { kind: 'thread', text: 'Stopped a thread', detail: 'T' }][i % 3]";
    const phone = await open(2, { width: 360, height: 720, ran: mixed });
    const tip = () => phone.eval<string | null>("document.querySelector('.tooltip')?.textContent ?? null");
    const hover = async () => {
      const [x, y] = await phone.eval<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(TOGGLE)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      await phone.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
      await phone.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    };
    await hover();
    await phone.until(`document.querySelector('.tooltip')?.textContent === ${JSON.stringify(full)}`);
    expect(await tip()).toBe(full);

    // A screen reader hears the whole label as the button's name: the ellipsis is only drawn.
    const { root } = await phone.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await phone.send("DOM.querySelector", { nodeId: root.nodeId, selector: TOGGLE });
    const { nodes } = await phone.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    expect(nodes[0].name.value).toBe(full);

    // Opened (a tap, on a phone), the label wraps onto a second line and nothing of it is cut.
    await phone.click(TOGGLE);
    const opened = await phone.eval<{ text: string; lines: number; clipped: boolean; inside: boolean }>(`(() => {
      const toggle = document.querySelector(${JSON.stringify(TOGGLE)});
      const label = toggle.querySelector('.bm-events-label');
      const chat = document.querySelector('.bots-messages').getBoundingClientRect();
      const box = toggle.getBoundingClientRect();
      return { text: label.textContent, lines: label.getClientRects().length && Math.round(label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight)), clipped: label.scrollWidth > label.clientWidth || label.scrollHeight > label.clientHeight, inside: box.left >= chat.left && box.right <= chat.right };
    })()`);
    expect(opened).toEqual({ text: full, lines: 2, clipped: false, inside: true });
    // Nothing's cut any more, so hovering again brings no tooltip.
    await hover();
    await Bun.sleep(700);
    expect(await tip()).toBeNull();

    // On a desktop the same label fits, and has no tooltip to repeat it.
    const desktop = await open(2, { ran: mixed });
    const [x, y] = await desktop.eval<[number, number]>(`(() => { const r = document.querySelector(${JSON.stringify(TOGGLE)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await desktop.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await Bun.sleep(700);
    expect(await desktop.eval<unknown>(`[document.querySelector(${JSON.stringify(TOGGLE)}).textContent, document.querySelector('.tooltip')]`)).toEqual([full, null]);
  }, 60_000);
});
