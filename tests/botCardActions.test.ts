// A message's actions (react, reply, copy) and the hover zone kept for them sit right beside its bubble,
// whatever the bubble holds. A card (a question, a poll, a plan) used to set its line as wide as its
// widest choice on one row would be, so the actions came up far off to the side of a narrower card.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botScroll/index.html`);
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

type Box = { left: number; right: number; top: number; bottom: number };
type Row = { id: string; mine: boolean; bubble: Box; line: Box; actions: Box | null };

const IMAGE = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#888"/></svg>');
const LONG = "Comment only: part 1 (the web machine picker) is merged and releasing, part 2 is split out and tied to the chat relay plan";

/** Every kind of bubble, from a bot and from the user, in a group. */
const MESSAGES = [
  { id: "c-question", author: "manager", text: "", question: { title: "Update the issue for you?", hint: "It's assigned to you, in progress, with no comments yet.", options: [{ key: "A", label: LONG }, { key: "B", label: "Comment, plus a new issue for part 2, linked" }, { key: "C", label: "Don't touch it, I'll do it myself" }], answer: "B" } },
  { id: "c-short", author: "manager", text: "", question: { title: "Which branch?", options: [{ key: "A", label: "main" }, { key: "B", label: "dev" }] } },
  { id: "c-poll", author: "helper", text: "", poll: { question: "Lunch?", options: [{ key: "A", label: `Pizza: ${LONG}` }, { key: "B", label: "Sushi" }], votes: [] } },
  { id: "c-plan", author: "manager", text: "", plan: { title: "Ship it", steps: [{ text: LONG, bot: "manager", status: "todo" }, { text: "Bump the version", bot: "helper", status: "todo" }] } },
  { id: "c-connect", author: "manager", text: "", connect: { app: "github" } },
  { id: "c-page", author: "manager", text: "", html: { title: "Chart", html: "<p>A chart</p>", height: 120 } },
  { id: "c-image", author: "helper", text: "", images: [IMAGE] },
  { id: "c-captioned", author: "helper", text: "The layout", images: [IMAGE] },
  { id: "c-file", author: "manager", text: "", files: [{ id: "f1", name: "report.pdf", mime: "application/pdf", size: 12345 }] },
  { id: "c-text", author: "manager", text: "Done." },
  { id: "c-my-poll", author: "me", text: "", poll: { question: "Who takes the release?", options: [{ key: "A", label: `Manager: ${LONG}` }, { key: "B", label: "Helper" }], votes: [] } },
  { id: "c-my-image", author: "me", text: "", images: [IMAGE] },
  { id: "c-my-text", author: "me", text: "Thanks." },
];

const open = async (hover: boolean, width: number) => {
  const page = await Page.open(chrome!.ws, server!.url.href, width, 900, "!!document.querySelector('.bots-messages')");
  if (hover) await page.emulateHover();
  await page.eval(`document.head.append(Object.assign(document.createElement("style"), { textContent: ".bots-sync-status { display: none !important; }" }))`);
  await page.eval(`(() => {
    const start = Date.now() - 600_000;
    const messages = ${JSON.stringify(MESSAGES)}.map((m, i) => ({ ...m, at: start + i * 1000 }));
    const chat = { id: "c", kind: "group", name: "Crew", botIds: ["manager", "helper"], createdAt: start, updatedAt: start, messages };
    bots.setState((s) => ({ conversations: [...s.conversations.filter((c) => c.id !== "c"), chat] }));
    bots.getState().select("c");
    return true;
  })()`);
  await page.until(`document.querySelector('[data-id="c-question"]') !== null && document.querySelector('[data-id="c-my-text"]') !== null`);
  await page.finished();
  return page;
};

const row = (page: Page, id: string) =>
  page.eval<Row>(`(() => {
    const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
    const row = document.querySelector('[data-id="${id}"]');
    row.scrollIntoView({ block: "center" });
    const actions = row.querySelector('.bm-actions');
    return { id: row.dataset.id, mine: !!row.closest('.bm-mine'), bubble: box(row.querySelector('.bm-bubble')), line: box(row.querySelector('.bm-line')), actions: actions && getComputedStyle(actions).display !== 'none' ? box(actions) : null };
  })()`);

/** Whether the message's actions are up, once their fade is over. */
const actionsShown = async (page: Page, id: string) => {
  const opacity = `getComputedStyle(document.querySelector('[data-id="${id}"] .bm-actions')).opacity`;
  await page.until(`["0", "1"].includes(${opacity}) && !document.querySelector('[data-id="${id}"] .bm-actions').getAnimations().length`);
  return page.eval<boolean>(`${opacity} === "1"`);
};

const move = async (page: Page, x: number, y: number) => {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.settle();
};

describe.skipIf(!browser)("with a mouse", () => {
  for (const width of [1400, 1000, 640]) {
    test(`${width}px: every bubble's actions, and the zone that shows them, sit right beside it`, async () => {
      const page = await open(true, width);
      for (const { id } of MESSAGES) {
        const r = await row(page, id);
        // The line is the bubble's own box: the actions and the zone are placed against it.
        expect([id, r.line.left, r.line.right]).toEqual([id, r.bubble.left, r.bubble.right]);
        // A page as wide as the column has its actions past the window's edge at 640px, as before.
        if (id === "c-page" && width < 1000) continue;
        expect(r.actions).not.toBeNull();
        const gap = r.mine ? r.bubble.left - r.actions!.right : r.actions!.left - r.bubble.right;
        expect([id, Math.round(gap)]).toEqual([id, 0]);
        // Pointing just beside the bubble, where the actions come up, shows them; well past them, nothing does.
        const y = (r.bubble.top + r.bubble.bottom) / 2;
        const beside = r.mine ? r.bubble.left - 3 : r.bubble.right + 3;
        const away = r.mine ? r.actions!.left - 12 : r.actions!.right + 12;
        await move(page, away, y);
        expect([id, await actionsShown(page, id)]).toEqual([id, false]);
        await move(page, beside, y);
        expect([id, await actionsShown(page, id)]).toEqual([id, true]);
        expect(await page.eval<string | null>(`document.elementFromPoint(${beside}, ${y})?.closest('.bm-row')?.dataset.id ?? null`)).toBe(id);
        await move(page, away, y);
      }
    }, 60_000);
  }

  test("a card is as wide as its choices need, up to 480px", async () => {
    const page = await open(true, 1400);
    for (const id of ["c-question", "c-poll", "c-plan", "c-my-poll"]) {
      const r = await row(page, id);
      expect([id, Math.round(r.bubble.right - r.bubble.left)]).toEqual([id, 480]);
    }
    const short = await row(page, "c-short");
    expect(short.bubble.right - short.bubble.left).toBeLessThan(400);
  }, 60_000);
});

describe.skipIf(!browser)("on a phone", () => {
  test("cards keep the width of the screen, and their line is the bubble's own box", async () => {
    const page = await open(false, 390);
    for (const { id } of MESSAGES) {
      const r = await row(page, id);
      expect(r.actions).toBeNull();
      expect([id, r.line.left, r.line.right]).toEqual([id, r.bubble.left, r.bubble.right]);
    }
    // Short or long, a card fills the column beside the bots' avatars.
    const widths: number[] = [];
    for (const id of ["c-question", "c-short", "c-poll", "c-plan"]) {
      const r = await row(page, id);
      widths.push(Math.round(r.bubble.right - r.bubble.left));
    }
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeGreaterThan(300);
  }, 60_000);
});
