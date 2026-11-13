// OpenBots never cuts its words off, in a real Chrome at desktop and phone widths: a bot waiting on a
// coding thread names it in full under the chat (or in its own few words, which fit a phone's
// header), and a question card shows its whole hint, wrapping as it needs to, long links included.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";
import { threadAbout, waitingOnThreads, type BotMessage, type BotStatus } from "../shared/bots";

const bot = { id: "builder", name: "Builder", look: { shape: "ghost", color: "blue" }, instructions: "", memory: [], routines: [], createdAt: 1 };
const lettered = (labels: string[]) => labels.map((label, i) => ({ key: String.fromCharCode(65 + i), label }));

/** The thread title the status once cut off at "Waiting on Tell the primary bot when a bot is dele…". */
const TITLE = "Tell the primary bot when a bot is deleted";
/** A hint as a bot writes one: long, and with a link no line is wide enough for. */
const HINT =
  "The checks run on every push, and a red one blocks the merge until it passes again. Turning on the nightly run as well means a flaky test is caught before a release goes out, so a failure never reaches the users unnoticed. The last one is https://github.com/example/openbuild/actions/runs/1234567890/job/9876543210/attempts/2.";

let status: Record<string, BotStatus> = {};
const messages: BotMessage[] = [
  { id: "hello", author: "me", at: 1, text: "Make sure the primary hears about it when a bot goes." },
  { id: "ask", author: "builder", at: 2, text: "Turn on the nightly run?", question: { title: "Turn on the nightly run?", hint: HINT, options: lettered(["Yes", "Not now"]) } },
];

const headers = { "x-openbuild-server": "srv" };
async function workspace(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === "/api/config") return Response.json({ mode: "local", serverId: "srv", machine: "Studio" });
  const rest = /^\/api\/workspace\/to\/srv(\/.*)$/.exec(path)?.[1];
  if (rest === "/api/bots") return Response.json({ bots: [bot], conversations: [{ id: "chat", kind: "direct", botIds: ["builder"], createdAt: 1, updatedAt: 1, messages }], settings: { sections: [] }, typing: {}, drafts: [], status }, { headers });
  if (rest === "/api/bots/stream") return new Response(new ReadableStream(), { headers });
  return Response.json({ ok: true }, { headers });
}

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: Awaited<ReturnType<typeof serveFixture>> | undefined;

beforeAll(async () => {
  if (!browser) return;
  server = await serveFixture(`${import.meta.dir}/fixtures/botQuestions/index.html`, { "/api/*": workspace });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  await server?.stop();
});

/** Shows the chat with the bot between turns, waiting on a thread with this status line. */
function open(activity: string, width: number, height: number) {
  status = { builder: { state: "working", conversationId: "chat", activity, threads: 1 } };
  return Page.open(chrome!.ws, server!.url.href, width, height, `!!document.querySelector('.bm-working-text') && !!document.querySelector('[data-id="ask"] .bm-question-hint')`);
}

interface Seen {
  /** Text, whether it overflows its own box, and how many lines it takes. */
  row: { text: string; cut: boolean; lines: number };
  head: { text: string; cut: boolean } | null;
  hint: { text: string; cut: boolean; lines: number; inCard: boolean };
  /** The page scrolls sideways. */
  wide: boolean;
}

const seen = (page: Page) =>
  page.eval<Seen>(`(() => {
    const lines = (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
    const cut = (el) => el.scrollWidth > el.clientWidth + 1;
    const row = document.querySelector('.bm-working-text');
    const head = document.querySelector('.bots-head-sub');
    const hint = document.querySelector('[data-id="ask"] .bm-question-hint');
    const card = hint.closest('.bm-question').getBoundingClientRect();
    const box = hint.getBoundingClientRect();
    return {
      // The row's text is an inline span: its overflow is the row's.
      row: { text: row.textContent, cut: row.getBoundingClientRect().right > row.closest('.bm-working').getBoundingClientRect().right + 1 || row.getBoundingClientRect().right > innerWidth, lines: row.getClientRects().length },
      head: head && getComputedStyle(head).display !== 'none' ? { text: head.textContent, cut: cut(head) } : null,
      hint: { text: hint.textContent, cut: cut(hint), lines: lines(hint), inCard: box.left >= card.left - 1 && box.right <= card.right + 1 },
      wide: document.scrollingElement.scrollWidth > innerWidth + 1,
    };
  })()`);

describe.skipIf(!browser)("nothing in an OpenBots chat is cut off", () => {
  test("on a desktop, a thread named by its title reads in full on one line, and the hint shows whole", async () => {
    const line = waitingOnThreads([TITLE])!;
    expect(line).toBe(`Waiting on ${TITLE}`);
    const page = await open(line, 1000, 800);
    const s = await seen(page);
    expect(s.row).toEqual({ text: line, cut: false, lines: 1 });
    // The desktop header has no status line: the row under the chat is it.
    expect(s.head).toBeNull();
    expect(s.hint.text).toBe(HINT);
    expect(s.hint.cut).toBe(false);
    expect(s.hint.inCard).toBe(true);
    expect(s.hint.lines).toBeGreaterThan(1);
    expect(s.wide).toBe(false);
  }, 30_000);

  test("on a phone, a bot's few words for the thread fit the header, and the hint wraps whole, link and all", async () => {
    const line = waitingOnThreads([threadAbout("the bot-deleted notice")!])!;
    expect(line).toBe("Waiting on the bot-deleted notice");
    const page = await open(line, 390, 844);
    const s = await seen(page);
    expect(s.head).toEqual({ text: line, cut: false });
    expect(s.row.text).toBe(line);
    expect(s.row.cut).toBe(false);
    expect(s.hint.text).toBe(HINT);
    expect(s.hint.cut).toBe(false);
    expect(s.hint.inCard).toBe(true);
    expect(s.wide).toBe(false);
  }, 30_000);

  test("on a phone, a whole title under the chat wraps rather than being cut", async () => {
    const line = waitingOnThreads(["Make the sidebar's thread list remember where it was scrolled to"])!;
    const page = await open(line, 390, 844);
    const s = await seen(page);
    expect(s.row.text).toBe(line);
    expect(s.row.cut).toBe(false);
    expect(s.wide).toBe(false);
  }, 30_000);
});
