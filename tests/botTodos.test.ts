// OpenBots' to-do lists and pages, in a real Chrome: a group's list under its goal, with its progress in
// the chat's header (a click there opens it); read-only for the user, since only bots change it; a bot's own chat
// keeping its list on a Tasks tab; and a page a bot showed, drawn in OpenBuild's sandboxed frame.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botTodos/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

const open = async (query: string, width = 1280, height = 800) => {
  const page = await Page.open(chrome!.ws, "about:blank", width, height, "true");
  await page.send("Page.navigate", { url: `${server!.url.href}?${query}` });
  await page.until("!!document.querySelector('.bots-head-pill')");
  await page.settle();
  return page;
};

const todos = (page: Page, id: string) => page.eval<{ id: string; text: string; status: string; bot?: string }[]>(`bots.getState().conversations.find((c) => c.id === ${JSON.stringify(id)}).todos ?? []`);

describe.skipIf(!browser)("to-do lists", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`a group's list sits under its goal, with its progress in the header (${theme})`, async () => {
      const page = await open(`theme=${theme}&details=closed`);
      // The header: a ring and the count, inside the pill.
      expect(await page.eval<string>("document.querySelector('.bots-head-pill .bots-head-tasks')?.textContent")).toBe("1/5");
      await page.click(".bots-head-tasks");
      await page.until("!!document.querySelector('.bots-todos')");
      expect(await page.eval<boolean>("bots.getState().detailsOpen")).toBe(true);
      expect(await page.eval<string>("document.querySelector('.bots-tab[aria-selected=true]').textContent")).toBe("Goal");
      // Below the goal, not instead of it.
      const order = await page.eval<number>("document.querySelector('.bots-instructions').compareDocumentPosition(document.querySelector('.bots-todos'))");
      expect(order & 4).toBeTruthy(); // DOCUMENT_POSITION_FOLLOWING
      expect(await page.eval<string>("document.querySelector('.bots-todos-count').textContent")).toBe("1/5");
      expect(await page.eval<string>("document.querySelector('.bots-todos-bar').getAttribute('aria-valuenow')")).toBe("1");
      // Rows of 32px, a done one dim and struck through, each one's state on its checkbox.
      const rows = await page.eval<{ h: number; checked: string; line: string; text: string; color: string }[]>(`[...document.querySelectorAll('.bots-todo')].map((r) => {
        const t = r.querySelector('.bots-todo-text'), s = getComputedStyle(t);
        return { h: r.getBoundingClientRect().height, checked: r.querySelector('.bots-todo-check').getAttribute('aria-label'), line: s.textDecorationLine, text: t.textContent, color: s.color };
      })`);
      expect(rows.map((r) => r.checked)).toEqual(["Done", "In progress", "In progress", "To do", "To do"]);
      for (const r of rows) expect(r.h).toBeGreaterThanOrEqual(32);
      expect(rows[0]!.line).toBe("line-through");
      expect(rows[3]!.line).toBe("none");
      expect(rows[0]!.color).not.toBe(rows[3]!.color);
      // In a group, who's on an item shows beside it.
      expect(await page.eval<number>("document.querySelectorAll('.bots-todo-bot').length")).toBe(3);
      // Nothing in it animates layout.
      const moving = await page.eval<string[]>("document.querySelector('.bots-todos').getAnimations({ subtree: true }).map((a) => a.transitionProperty ?? '')");
      for (const p of moving) expect(["width", "height", "grid-template-rows", "top", "left"]).not.toContain(p);
    }, 30_000);
  }

  test("the list is read-only for the user: no checkboxes, no adding, removing or clearing", async () => {
    const page = await open("theme=dark");
    await page.eval("[...document.querySelectorAll('.bots-tab')].find((b) => b.textContent === 'Goal').click()");
    await page.until("!!document.querySelector('.bots-todos')");
    const before = await todos(page, "crew");
    // Nothing in it can be pressed or typed into.
    expect(await page.eval<number>("document.querySelectorAll('.bots-todos button, .bots-todos input, .bots-todos [role=checkbox]').length")).toBe(0);
    // Clicking an item's circle changes nothing.
    await page.eval("[...document.querySelectorAll('.bots-todo')].find((r) => r.textContent.includes('Deploy')).querySelector('.bots-todo-check').click()");
    await page.settle();
    expect(await todos(page, "crew")).toEqual(before);
    expect(await page.eval<string>("document.querySelector('.bots-head-tasks').textContent")).toBe("1/5");
  }, 30_000);

  test("a bot's own chat keeps its list on a Tasks tab, and shows no progress until it has one", async () => {
    const page = await open("theme=light&chat=dm");
    expect(await page.eval<boolean>("!!document.querySelector('.bots-head-tasks')")).toBe(false);
    await page.eval("[...document.querySelectorAll('.bots-tab')].find((b) => b.textContent === 'Tasks').click()");
    await page.until("!!document.querySelector('.bots-todos')");
    // Empty until the bot starts one.
    expect(await page.eval<string>("document.querySelector('.bots-todos-empty')?.textContent")).toContain("No tasks yet");
    // The bot adds an item (as its todo tool's sync would).
    await page.eval(`bots.setState((s) => ({ conversations: s.conversations.map((c) => c.id === "dm" ? { ...c, todos: [{ id: "t1", text: "Find a venue", status: "todo", by: "egg", at: Date.now() }] } : c) }))`);
    await page.settle();
    expect(await page.eval<string>("document.querySelector('.bots-head-tasks').textContent")).toBe("0/1");
    // From another tab, the header's progress brings the list back.
    await page.eval("[...document.querySelectorAll('.bots-tab')].find((b) => b.textContent === 'Instructions').click()");
    await page.settle();
    await page.click(".bots-head-tasks");
    expect(await page.eval<string>("document.querySelector('.bots-tab[aria-selected=true]').textContent")).toBe("Tasks");
  }, 30_000);
});

describe.skipIf(!browser)("pages in a bot chat", () => {
  test("a page a bot showed is drawn in OpenBuild's sandboxed frame, on the bubble column, with its download and full screen", async () => {
    const page = await open("theme=dark&chat=dm&details=closed");
    await page.until("!!document.querySelector('.bm-page iframe.html-render-frame')");
    const frame = await page.eval<{ sandbox: string; title: string; card: number; column: number }>(`(() => {
      const f = document.querySelector('.bm-page iframe');
      return { sandbox: f.getAttribute('sandbox'), title: document.querySelector('.bm-page .html-render-title').textContent, card: document.querySelector('.bm-page').getBoundingClientRect().width, column: document.querySelector('.bots-messages-inner').getBoundingClientRect().width };
    })()`);
    // Exactly OpenBuild's sandbox: scripts, but never the app's origin.
    expect(frame.sandbox).toBe("allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox");
    expect(frame.title).toBe("Weekly signups");
    expect(frame.card).toBeLessThanOrEqual(frame.column);
    expect(frame.card).toBeGreaterThan(400);
    // The page ran, with no origin, storage or reach into the app, and got the app's theme.
    await page.until("window.probes.length > 0");
    const probe = await page.eval<{ origin: string; storage: string; parentDom: string; background: string }>("window.probes[0]");
    expect(probe).toMatchObject({ origin: "null", storage: "blocked", parentDom: "blocked" });
    expect(probe.background).not.toBe("");
    // It fits the page's height (180px), not the default.
    await page.until("Math.abs(document.querySelector('.bm-page .html-render-page').getBoundingClientRect().height - 180) < 4");
    expect(await page.eval<string[]>("[...document.querySelectorAll('.bm-page .html-render-action')].map((b) => b.getAttribute('aria-label'))")).toEqual(["Download HTML", "Full screen", "Close preview"]);
    await page.eval("document.querySelectorAll('.bm-page .html-render-action')[1].click()");
    await page.until("!!document.querySelector('.html-render-full[data-state=open] iframe')");
    expect(await page.eval<string>("document.querySelector('.html-render-full iframe').getAttribute('sandbox')")).toBe(frame.sandbox);
  }, 30_000);

  test("fits a phone's width", async () => {
    const page = await open("theme=light&chat=dm&details=closed", 390, 844);
    await page.until("!!document.querySelector('.bm-page iframe')");
    const [card, view] = await page.eval<[number, number]>("[document.querySelector('.bm-page').getBoundingClientRect().right, innerWidth]");
    expect(card).toBeLessThanOrEqual(view);
  }, 30_000);
});
