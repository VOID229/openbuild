// A card of several questions, in a real Chrome: answering steps on, the arrows and arrow keys move
// without answering, answers survive a reload, and the bot's side hears nothing until Submit sends
// every answer in one message. A card of one question stays as it was.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";
import { answerText, type BotMessage, type Question, type QuestionStep } from "../shared/bots";

const lettered = (labels: string[]) => labels.map((label, i) => ({ key: String.fromCharCode(65 + i), label }));
const STEPS: QuestionStep[] = [
  { title: "Which database should it use?", hint: "Both are set up on the server.", options: lettered(["Postgres", "SQLite"]) },
  { title: "When should the backup run?", options: lettered(["Every night", "Every hour"]) },
  { title: "Deploy to Dev when it's green?", options: lettered(["Yes", "No, wait for me"]) },
];
const bot = { id: "builder", name: "Builder", look: { shape: "ghost", color: "blue" }, instructions: "", memory: [], routines: [], createdAt: 1 };

/** The workspace: its messages, and every write the page made to it, in order. */
let stored: BotMessage[] = [];
let writes: { method: string; body: any }[] = [];
/** The user's messages that reached the workspace: posted, or delivering an answer with it (`reply`). */
let delivered: BotMessage[] = [];
const posts = () => delivered;
/** How the next answer's request goes wrong on the way: saved with its acknowledgement lost, or dropped before it's saved. */
let trouble: "lost-ack" | "dropped" | undefined;
const card = (id: string) => stored.find((m) => m.id === id)!.question!;

const headers = { "x-openbuild-server": "srv" };
async function workspace(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === "/api/config") return Response.json({ mode: "local", serverId: "srv", machine: "Studio" });
  const rest = /^\/api\/workspace\/to\/srv(\/.*)$/.exec(path)?.[1];
  if (!rest) return Response.json({});
  if (rest === "/api/bots") return Response.json({ bots: [bot], conversations: [{ id: "chat", kind: "direct", botIds: ["builder"], createdAt: 1, updatedAt: 1, messages: stored }], settings: { sections: [] }, typing: {}, drafts: [], status: {} }, { headers });
  if (rest === "/api/bots/stream") return new Response(new ReadableStream(), { headers });
  if (req.method === "POST" && rest.endsWith("/messages")) {
    const body = (await req.json()) as BotMessage;
    writes.push({ method: "POST", body });
    if (!stored.some((m) => m.id === body.id)) stored.push(body), delivered.push(body);
    return Response.json(body, { headers });
  }
  const id = /\/messages\/([^/]+)$/.exec(rest)?.[1];
  if (req.method === "PATCH" && id) {
    const body = (await req.json()) as { question?: { answer?: string; answers?: (string | null)[]; submit?: boolean; reply?: string } };
    writes.push({ method: "PATCH", body });
    const lost = trouble;
    trouble = undefined;
    // A gateway's 502: from the way there, so the page can't tell whether it ran.
    const gateway = () => Response.json({ error: "Bad gateway" }, { status: 502 });
    if (lost === "dropped") return gateway();
    const m = stored.find((x) => x.id === id)!;
    // As the server keeps them (server/bots/service.ts answerQuestion and answerSteps): a closed card
    // refuses them, and a final answer's message is posted with it, once whatever the retries.
    const q = m.question!;
    if (q.closed) return Response.json({ error: q.steps ? "That card was closed." : "That question was closed." }, { status: 400, headers });
    if (typeof body.question?.answer === "string") m.question = { ...q, answer: body.question.answer };
    if (body.question?.answers && q.steps && !q.submitted) m.question = { ...q, steps: q.steps.map(({ answer: _, ...s }, i) => (body.question!.answers![i] ? { ...s, answer: body.question!.answers![i]! } : s)), ...(body.question.submit ? { submitted: true } : {}) };
    const reply = body.question?.reply;
    if (reply && (typeof body.question?.answer === "string" || body.question?.submit) && !stored.some((x) => x.id === reply)) {
      const message: BotMessage = { id: reply, author: "me", at: Date.now(), text: answerText(m.question!), replyTo: m.id };
      stored.push(message);
      delivered.push(message);
    }
    return lost === "lost-ack" ? gateway() : Response.json(m, { headers });
  }
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

beforeEach(() => {
  const single: Question = { title: "Use the staging key?", options: lettered(["Yes", "No"]) };
  stored = [
    { id: "hello", author: "me", at: 1, text: "Set up the backups, please." },
    { id: "one", author: "builder", at: 2, text: single.title, question: single },
    { id: "many", author: "builder", at: 3, text: STEPS[0]!.title, question: { ...STEPS[0]!, steps: STEPS.map((s) => ({ ...s })) } },
  ];
  writes = [];
  delivered = [];
  trouble = undefined;
});

class Chat extends Page {
  /** What the card of several questions shows right now. */
  state() {
    return this.eval<{ count: string | null; title: string | null; hint: string | null; options: string[]; on: string[]; prev: boolean; next: boolean; submit: "none" | "off" | "on"; left: string | null }>(`(() => {
      const c = document.querySelector('[data-id="many"]');
      const text = (s) => c.querySelector(s)?.textContent.trim() ?? null;
      const button = (label) => { const b = c.querySelector('button[aria-label="' + label + '"]'); return !!b && !b.disabled; };
      const submit = c.querySelector('.bm-steps-submit');
      return {
        count: text('.bm-steps-count'), title: text('.bm-question-title'), hint: text('.bm-question-hint'),
        options: [...c.querySelectorAll('.bm-option-label')].map((o) => o.textContent),
        on: [...c.querySelectorAll('.bm-option-on .bm-option-label')].map((o) => o.textContent),
        prev: button('Previous question'), next: button('Next question'),
        submit: !submit ? 'none' : submit.disabled ? 'off' : 'on', left: text('.bm-steps-left'),
      };
    })()`);
  }
  /** Picks the option with this label, with a real click. */
  async pick(id: string, label: string) {
    const n = await this.eval<number>(`[...document.querySelectorAll('[data-id="${id}"] button.bm-option')].findIndex((b) => b.querySelector('.bm-option-label').textContent === ${JSON.stringify(label)})`);
    expect(n).toBeGreaterThanOrEqual(0);
    await this.click(`[data-id="${id}"] button.bm-option:nth-of-type(${n + 1})`);
  }
  async key(key: "ArrowLeft" | "ArrowRight" | "Enter") {
    const code = { ArrowLeft: 37, ArrowRight: 39, Enter: 13 }[key];
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, ...(key === "Enter" ? { text: "\r" } : {}) });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
    await this.settle();
  }
  at(count: string) {
    return this.until(`document.querySelector('[data-id="many"] .bm-steps-count')?.textContent.trim() === ${JSON.stringify(count)}`);
  }
}

const open = () => Chat.open(chrome!.ws, server!.url.href, 1000, 800, `!!document.querySelector('[data-id="many"] .bm-question')`);

describe.skipIf(!browser)("a card of several questions", () => {
  test("steps on as each is answered, moves back and forward without answering, and sends nothing until Submit", async () => {
    let page = await open();
    expect(await page.state()).toEqual({ count: "1 of 3", title: STEPS[0]!.title, hint: STEPS[0]!.hint!, options: ["Postgres", "SQLite"], on: [], prev: false, next: true, submit: "none", left: null });

    // An answer moves to the next question, with its own choices.
    await page.pick("many", "SQLite");
    await page.at("2 of 3");
    expect(await page.state()).toMatchObject({ title: STEPS[1]!.title, hint: null, options: ["Every night", "Every hour"], on: [], prev: true, next: true, submit: "none" });

    // The arrow goes on without answering. The last question has Submit, which waits for the one skipped.
    await page.click('[data-id="many"] button[aria-label="Next question"]');
    await page.at("3 of 3");
    expect(await page.state()).toMatchObject({ title: STEPS[2]!.title, next: false, submit: "off", left: "Question 2 needs an answer" });

    // The arrow keys go back, to an answer that's still there, and forward again.
    await page.key("ArrowLeft");
    await page.at("2 of 3");
    await page.key("ArrowLeft");
    await page.at("1 of 3");
    expect(await page.state()).toMatchObject({ title: STEPS[0]!.title, on: ["SQLite"], prev: false });
    await page.key("ArrowLeft");
    expect((await page.state()).count).toBe("1 of 3");
    await page.key("ArrowRight");
    await page.at("2 of 3");

    // Each question takes an answer of its own in words, which moves on like a pick does.
    await page.click('[data-id="many"] .bm-own input');
    await page.send("Input.insertText", { text: "Sundays at 3am" });
    // In the words being typed, the arrows are the caret's.
    await page.key("ArrowLeft");
    expect((await page.state()).count).toBe("2 of 3");
    await page.key("Enter");
    await page.at("3 of 3");
    expect(await page.state()).toMatchObject({ submit: "off", left: null });

    // Kept so far, and none of it sent: the bot is woken by a message, and there is none.
    expect(card("many").steps!.map((s) => s.answer)).toEqual(["B", "Sundays at 3am", undefined]);
    expect(card("many").submitted).toBeUndefined();
    expect(posts()).toEqual([]);

    // A reload comes back to the question still open, with the answers given.
    page = await open();
    expect(await page.state()).toMatchObject({ count: "3 of 3", title: STEPS[2]!.title, on: [], submit: "off" });
    await page.click('[data-id="many"] button[aria-label="Previous question"]');
    await page.at("2 of 3");
    expect((await page.state()).on).toEqual(["Sundays at 3am"]);
    await page.key("ArrowRight");
    await page.at("3 of 3");

    // The last answer doesn't send either: it can still be changed.
    await page.pick("many", "No, wait for me");
    await page.until(`!document.querySelector('[data-id="many"] .bm-steps-submit').disabled`);
    await page.pick("many", "Yes");
    expect(await page.state()).toMatchObject({ count: "3 of 3", on: ["Yes"], submit: "on" });
    expect(posts()).toEqual([]);

    // Submit: one message with every answer beside its question, in reply to the card.
    await page.click('[data-id="many"] .bm-steps-submit');
    await page.until(`!!document.querySelector('[data-id="many"] .bm-answered')`);
    const text = "1. Which database should it use? → SQLite\n2. When should the backup run? → Sundays at 3am\n3. Deploy to Dev when it's green? → Yes";
    expect(posts().map((m) => ({ author: m.author, text: m.text, replyTo: m.replyTo }))).toEqual([{ author: "me", text, replyTo: "many" }]);
    expect(card("many").submitted).toBe(true);
    expect(card("many").steps!.map((s) => s.answer)).toEqual(["B", "Sundays at 3am", "A"]);

    // The card is now a short summary, and the message a short list of the answers.
    const summary = () => page.eval<{ rows: string[][]; stepping: boolean; echo: string[] }>(`({
      rows: [...document.querySelectorAll('[data-id="many"] .bm-answered-row')].map((r) => [r.querySelector('.bm-answered-title').textContent, r.querySelector('.bm-answered-answer').textContent]),
      stepping: !!document.querySelector('[data-id="many"] .bm-bubble :is(.bm-steps-head, .bm-own, button)'),
      echo: [...document.querySelectorAll('.bm-row:not([data-id="many"]) .bm-echo-row')].map((r) => r.textContent),
    })`);
    const done = { rows: [[STEPS[0]!.title, "SQLite"], [STEPS[1]!.title, "Sundays at 3am"], [STEPS[2]!.title, "Yes"]], stepping: false, echo: ["1SQLite", "2Sundays at 3am", "3Yes"] };
    expect(await summary()).toEqual(done);
    page = await open();
    expect(await summary()).toEqual(done);
  }, 60_000);

  test("words typed in a question's box set its pick aside, and a pick afterwards sets the words aside", async () => {
    const page = await open();
    const typed = (text: string) => page.until(`document.querySelector('[data-id="many"] .bm-own input')?.value === ${JSON.stringify(text)}`);
    const type = async (text: string) => {
      await page.click('[data-id="many"] .bm-own input');
      await page.send("Input.insertText", { text });
      await typed(text);
    };
    await page.pick("many", "SQLite");
    await page.at("2 of 3");
    await page.pick("many", "Every night");
    await page.at("3 of 3");

    // Picked, then typed instead: the pick goes, and Submit sends the words.
    await page.pick("many", "Yes");
    await page.until(`!document.querySelector('[data-id="many"] .bm-steps-submit').disabled`);
    await type("Yes, and tell me");
    expect(await page.state()).toMatchObject({ count: "3 of 3", on: [], submit: "on" });
    // Set aside in the workspace too, so a reload can't bring it back.
    for (let i = 0; i < 50 && card("many").steps![2]!.answer !== undefined; i++) await Bun.sleep(50);
    expect(card("many").steps!.map((s) => s.answer)).toEqual(["B", "A", undefined]);

    // A pick after typing takes the words back out of the box.
    await page.click('[data-id="many"] button[aria-label="Previous question"]');
    await page.at("2 of 3");
    expect((await page.state()).on).toEqual(["Every night"]);
    await type("Sundays at 3am");
    expect((await page.state()).on).toEqual([]);
    await page.pick("many", "Every hour");
    await page.at("3 of 3");
    // The words typed on the last question are still its answer.
    expect(await page.state()).toMatchObject({ on: [], submit: "on" });
    expect(await page.eval<string>(`document.querySelector('[data-id="many"] .bm-own input').value`)).toBe("Yes, and tell me");
    await page.key("ArrowLeft");
    await page.at("2 of 3");
    expect(await page.state()).toMatchObject({ on: ["Every hour"] });
    expect(await page.eval<string>(`document.querySelector('[data-id="many"] .bm-own input').value`)).toBe("");

    // Typed over a typed answer: the new words are the answer.
    await type("Twice a day");
    await page.key("Enter");
    await page.at("3 of 3");
    await page.key("ArrowLeft");
    await page.at("2 of 3");
    expect((await page.state()).on).toEqual(["Twice a day"]);
    await type("Weekly");
    expect((await page.state()).on).toEqual([]);
    await page.click('[data-id="many"] button[aria-label="Next question"]');
    await page.at("3 of 3");

    expect(posts()).toEqual([]);
    await page.click('[data-id="many"] .bm-steps-submit');
    await page.until(`!!document.querySelector('[data-id="many"] .bm-answered')`);
    const text = "1. Which database should it use? → SQLite\n2. When should the backup run? → Weekly\n3. Deploy to Dev when it's green? → Yes, and tell me";
    expect(posts().map((m) => m.text)).toEqual([text]);
    expect(card("many").steps!.map((s) => s.answer)).toEqual(["B", "Weekly", "Yes, and tell me"]);
    expect(await page.eval<string[]>(`[...document.querySelectorAll('[data-id="many"] .bm-answered-answer')].map((a) => a.textContent)`)).toEqual(["SQLite", "Weekly", "Yes, and tell me"]);
  }, 60_000);

  test("the box's own arrow sends the words typed after a pick", async () => {
    const page = await open();
    await page.pick("many", "SQLite");
    await page.at("2 of 3");
    await page.key("ArrowLeft");
    await page.at("1 of 3");
    await page.click('[data-id="many"] .bm-own input');
    await page.send("Input.insertText", { text: "SQLite and Postgres" });
    await page.until(`document.querySelector('[data-id="many"] .bm-own input')?.value === "SQLite and Postgres"`);
    expect((await page.state()).on).toEqual([]);
    await page.click('[data-id="many"] .bm-own button[type="submit"]');
    await page.at("2 of 3");
    expect(card("many").steps!.map((s) => s.answer)).toEqual(["SQLite and Postgres", undefined, undefined]);
    await page.key("ArrowLeft");
    await page.at("1 of 3");
    expect((await page.state()).on).toEqual(["SQLite and Postgres"]);
  }, 30_000);

  test("a card of one question sends the words typed, or a pick made after typing", async () => {
    let page = await open();
    const one = '[data-id="one"]';
    await page.click(`${one} .bm-own input`);
    await page.send("Input.insertText", { text: "Yes and rotate it" });
    await page.until(`document.querySelector('${one} .bm-own input')?.value === "Yes and rotate it"`);
    await page.click(`${one} .bm-own button[type="submit"]`);
    await page.until(`document.querySelector('${one} .bm-option-on .bm-option-label')?.textContent === "Yes and rotate it"`);
    expect(await page.eval<string[]>(`[...document.querySelectorAll('${one} .bm-option-on .bm-option-label')].map((o) => o.textContent)`)).toEqual(["Yes and rotate it"]);
    expect(posts().map((m) => m.text)).toEqual(["Yes and rotate it"]);
    expect(card("one").answer).toBe("Yes and rotate it");

    // Typed, then picked: the pick is the answer.
    stored.find((m) => m.id === "one")!.question = { title: "Use the staging key?", options: lettered(["Yes", "No"]) };
    writes = [];
    delivered = [];
    page = await open();
    await page.click(`${one} .bm-own input`);
    await page.send("Input.insertText", { text: "Maybe" });
    await page.until(`document.querySelector('${one} .bm-own input')?.value === "Maybe"`);
    await page.pick("one", "No");
    await page.until(`document.querySelector('${one} .bm-option-on .bm-option-label')?.textContent === "No"`);
    expect(posts().map((m) => m.text)).toEqual(["B: No"]);
    expect(card("one").answer).toBe("B");
  }, 30_000);

  test("a card of one question has no steps and answers with a tap, as before", async () => {
    const page = await open();
    expect(await page.eval<unknown>(`(() => { const c = document.querySelector('[data-id="one"]'); return { steps: !!c.querySelector('.bm-steps-head, .bm-steps-submit, .bm-steps'), title: c.querySelector('.bm-question-title').textContent, options: [...c.querySelectorAll('.bm-option-label')].map((o) => o.textContent), own: !!c.querySelector('.bm-own input') }; })()`)).toEqual({ steps: false, title: "Use the staging key?", options: ["Yes", "No"], own: true });
    await page.pick("one", "No");
    await page.until(`document.querySelector('[data-id="one"] .bm-option-on .bm-option-label')?.textContent === "No"`);
    expect(posts().map((m) => ({ text: m.text, replyTo: m.replyTo }))).toEqual([{ text: "B: No", replyTo: "one" }]);
    expect(card("one").answer).toBe("B");
    // One request: the answer, with the id of the message that delivers it. The page posts nothing itself.
    expect(writes.map((w) => [w.method, w.body])).toEqual([["PATCH", { question: { answer: "B", reply: posts()[0]!.id } }]]);
  }, 30_000);
});

describe.skipIf(!browser)("a closed card", () => {
  /** What a card shows: its marker, whether anything on it can still be used, and what's checked. */
  const shown = (page: Chat, id: string) =>
    page.eval<{ closed: string | null; usable: number; own: boolean; on: string[]; off: number; steps: string[] }>(`(() => {
      const c = document.querySelector('[data-id="${id}"] .bm-question');
      return {
        closed: c.querySelector('.bm-question-closed')?.textContent ?? null,
        usable: [...c.querySelectorAll('button, input')].filter((b) => !b.disabled).length,
        own: !!c.querySelector('.bm-own'),
        on: [...c.querySelectorAll('.bm-option-on .bm-option-label')].map((o) => o.textContent),
        off: c.querySelectorAll('.bm-option-off').length,
        steps: [...c.querySelectorAll('.bm-answered-title')].map((t) => t.textContent),
      };
    })()`);

  for (const [device, width] of [["desktop", 1000], ["phone", 390]] as const) {
    test(`on a ${device}, can't be answered and says why, the same whoever closed it`, async () => {
      const single = (closed: Partial<Question>): Question => ({ title: "Merge #351 now?", options: lettered(["Merge it", "Wait for me"]), ...closed });
      stored = [
        { id: "hello", author: "me", at: 1, text: "Set up the backups, please." },
        { id: "settled", author: "builder", at: 2, text: "Merge #351 now?", question: single({ closed: "bot", answer: "A", reason: "You said merge in the chat" }) },
        { id: "stale", author: "builder", at: 3, text: "Merge #351 now?", question: single({ closed: "bot", reason: "Not needed anymore" }) },
        { id: "bare", author: "builder", at: 4, text: "Merge #351 now?", question: single({ closed: "bot" }) },
        { id: "thread", author: "builder", at: 5, text: "Merge #351 now?", question: single({ thread: { id: "t", ask: "a" }, closed: "answered", answer: "B" }) },
        { id: "gone", author: "builder", at: 6, text: "Merge #351 now?", question: single({ thread: { id: "t", ask: "b" }, closed: "gone" }) },
        { id: "many", author: "builder", at: 7, text: STEPS[0]!.title, question: { ...STEPS[0]!, steps: STEPS.map((s) => ({ ...s })), closed: "bot", answer: "SQLite, nightly", reason: "Settled in the chat" } },
      ];
      const page = await Chat.open(chrome!.ws, server!.url.href, width, 900, `!!document.querySelector('[data-id="many"] .bm-question')`);
      if (device === "phone") expect(await page.eval<boolean>(`matchMedia("(max-width: 768px)").matches`)).toBe(true);
      const closed = { usable: 0, own: false };
      expect(await shown(page, "settled")).toEqual({ ...closed, closed: "Closed · You said merge in the chat", on: ["Merge it"], off: 1, steps: [] });
      expect(await shown(page, "stale")).toEqual({ ...closed, closed: "Closed · Not needed anymore", on: [], off: 2, steps: [] });
      expect(await shown(page, "bare")).toEqual({ ...closed, closed: "Closed", on: [], off: 2, steps: [] });
      // Closed from its thread, it reads the same way.
      expect(await shown(page, "thread")).toEqual({ ...closed, closed: "Closed · Answered in the thread", on: ["Wait for me"], off: 1, steps: [] });
      expect(await shown(page, "gone")).toEqual({ ...closed, closed: "Closed · The thread stopped waiting on this", on: [], off: 2, steps: [] });
      // A card of several: the questions it asked, no stepping, and what its bot settled on.
      expect(await shown(page, "many")).toEqual({ ...closed, closed: "Closed · Settled in the chat", on: ["SQLite, nightly"], off: 0, steps: STEPS.map((s) => s.title) });
      expect(await page.eval<number>(`document.querySelectorAll('[data-id="many"] .bm-steps-arrow, [data-id="many"] .bm-steps-submit').length`)).toBe(0);
      // The marker sits inside the card, under its choices.
      const fits = await page.eval<{ inside: boolean; under: boolean }>(`(() => {
        const card = document.querySelector('[data-id="settled"] .bm-bubble').getBoundingClientRect();
        const note = document.querySelector('[data-id="settled"] .bm-question-closed').getBoundingClientRect();
        const last = [...document.querySelectorAll('[data-id="settled"] .bm-option')].pop().getBoundingClientRect();
        return { inside: note.left >= card.left && note.right <= card.right && note.bottom <= card.bottom, under: note.top >= last.bottom };
      })()`);
      expect(fits).toEqual({ inside: true, under: true });

      // A tap on a closed card's option sends nothing.
      await page.click('[data-id="stale"] button.bm-option');
      await page.settle();
      expect(writes).toEqual([]);
    }, 30_000);
  }

  test("closed while the page still shows it open, an answer is refused and its message never goes", async () => {
    const page = await open();
    // Steps answered so far, as the workspace keeps them, before the bot closes both cards.
    await page.pick("many", "SQLite");
    await page.at("2 of 3");
    await page.pick("many", "Every night");
    await page.at("3 of 3");
    await page.pick("many", "Yes");
    await page.until(`!document.querySelector('[data-id="many"] .bm-steps-submit').disabled`);
    for (let i = 0; i < 50 && card("many").steps![2]!.answer === undefined; i++) await Bun.sleep(50);
    expect(card("many").steps!.map((s) => s.answer)).toEqual(["B", "A", "A"]);
    // The bot closes a card; the page doesn't know yet.
    const close = (id: string) => (stored.find((m) => m.id === id)!.question = { ...card(id), closed: "bot", reason: "You said so in the chat" });
    writes = [];
    delivered = [];

    // Submitting the card of several is refused, nothing is posted, and the card shows closed.
    close("many");
    await page.click('[data-id="many"] .bm-steps-submit');
    await page.until(`document.querySelector('[data-id="many"] .bm-question-closed')?.textContent === "Closed · You said so in the chat"`);
    // The single card is still open, until it's closed too: then a tap on it goes the same way.
    expect(await page.eval<boolean>(`!!document.querySelector('[data-id="one"] .bm-own input')`)).toBe(true);
    close("one");
    await page.pick("one", "Yes");
    await page.until(`document.querySelector('[data-id="one"] .bm-question-closed')?.textContent === "Closed · You said so in the chat"`);
    await Bun.sleep(300);
    expect(writes.map((w) => w.method)).toEqual(["PATCH", "PATCH"]);
    expect(posts()).toEqual([]);
    expect([card("one").answer, card("many").submitted]).toEqual([undefined, undefined]);
    // Neither shows the answer that was refused, and neither can be answered again.
    expect(await page.eval<unknown>(`[...document.querySelectorAll('[data-id="one"] .bm-option-on, [data-id="many"] .bm-answered-answer')].length`)).toBe(0);
    expect(await page.eval<number>(`[...document.querySelectorAll('[data-id="one"] .bm-question :is(button, input), [data-id="many"] .bm-question :is(button, input)')].filter((b) => !b.disabled).length`)).toBe(0);
    // Nor is either left waiting to be sent again.
    await page.until(`!document.querySelector('.bots-unconfirmed-row')`);
  }, 30_000);

  test("an open card closes on the next load, and its box goes", async () => {
    let page = await open();
    expect((await shown(page, "one")).own).toBe(true);
    stored.find((m) => m.id === "one")!.question = { ...stored.find((m) => m.id === "one")!.question!, closed: "bot", reason: "You said yes in the chat" };
    page = await open();
    expect(await shown(page, "one")).toMatchObject({ closed: "Closed · You said yes in the chat", usable: 0, own: false });
  }, 30_000);
});

describe.skipIf(!browser)("an answer on a bad connection", () => {
  /** Waits for the workspace to have had every write, and the page its snapshot after the last. */
  const quiet = async (page: Chat) => {
    await page.settle();
    await Bun.sleep(400);
    await page.settle();
  };

  test("saved with its acknowledgement lost, a single card's answer still reaches the bot, once", async () => {
    const page = await open();
    trouble = "lost-ack";
    await page.pick("one", "Yes");
    await quiet(page);
    // Saved, and its message with it: the bot is woken, though the page never heard back.
    expect(card("one").answer).toBe("A");
    expect(posts().map((m) => ({ text: m.text, replyTo: m.replyTo }))).toEqual([{ text: "A: Yes", replyTo: "one" }]);
    expect(writes.map((w) => w.method)).toEqual(["PATCH"]);
    // The page shows it all as the workspace has it, with nothing left to send again.
    await page.until(`!document.querySelector('.bots-unconfirmed-row')`);
    expect(await page.eval<string | null>(`document.querySelector('[data-id="one"] .bm-option-on .bm-option-label')?.textContent ?? null`)).toBe("Yes");
    expect(await page.eval<boolean>(`[...document.querySelectorAll('.bm-row')].some((r) => r.dataset.id === ${JSON.stringify(posts()[0]!.id)})`)).toBe(true);
  }, 30_000);

  test("submitted with its acknowledgement lost, a card of several's answers still reach the bot, once", async () => {
    const page = await open();
    await page.pick("many", "SQLite");
    await page.at("2 of 3");
    await page.pick("many", "Every night");
    await page.at("3 of 3");
    await page.pick("many", "Yes");
    await page.until(`!document.querySelector('[data-id="many"] .bm-steps-submit').disabled`);
    await quiet(page);
    writes = [];
    trouble = "lost-ack";
    await page.click('[data-id="many"] .bm-steps-submit');
    await quiet(page);
    expect(card("many").submitted).toBe(true);
    const text = "1. Which database should it use? → SQLite\n2. When should the backup run? → Every night\n3. Deploy to Dev when it's green? → Yes";
    expect(posts().map((m) => ({ text: m.text, replyTo: m.replyTo }))).toEqual([{ text, replyTo: "many" }]);
    expect(writes.map((w) => w.method)).toEqual(["PATCH"]);
    await page.until(`!document.querySelector('.bots-unconfirmed-row')`);
    await page.until(`!!document.querySelector('[data-id="many"] .bm-answered')`);
    // The message shows as the answers' short list, as one sent from here does.
    expect(await page.eval<string[]>(`[...document.querySelectorAll('.bm-echo-row')].map((r) => r.textContent)`)).toEqual(["1SQLite", "2Every night", "3Yes"]);
  }, 30_000);

  for (const kind of ["one", "many"] as const) {
    test(`dropped before it's saved, ${kind === "one" ? "a single card's answer" : "a card of several's answers"} can be sent again, and reach the bot once`, async () => {
      const page = await open();
      if (kind === "many") {
        // Answered to the last question first, as the user would.
        for (const [label, at] of [["SQLite", "2 of 3"], ["Every night", "3 of 3"]] as const) {
          await page.pick("many", label);
          await page.at(at);
        }
        await page.pick("many", "Yes");
        await page.until(`!document.querySelector('[data-id="many"] .bm-steps-submit').disabled`);
        await quiet(page);
        writes = [];
      }
      trouble = "dropped";
      if (kind === "one") await page.pick("one", "Yes");
      else await page.click('[data-id="many"] .bm-steps-submit');
      // Nothing saved, nothing delivered, and the change waits with its Retry.
      await page.until(`!!document.querySelector('.bots-unconfirmed-row button:not([aria-label])')`);
      expect(posts()).toEqual([]);
      expect(kind === "one" ? card("one").answer : card("many").submitted).toBeUndefined();
      await page.click(".bots-unconfirmed-row button:not([aria-label])");
      await page.until(`!document.querySelector('.bots-unconfirmed-row')`);
      await quiet(page);
      // Sent again as it was, message id and all: delivered now, once.
      expect(writes.map((w) => w.method)).toEqual(["PATCH", "PATCH"]);
      expect(writes[1]!.body).toEqual(writes[0]!.body);
      expect(posts().map((m) => [m.id, m.replyTo])).toEqual([[writes[0]!.body.question.reply, kind]]);
      expect(kind === "one" ? card("one").answer : card("many").submitted).toBe(kind === "one" ? "A" : true);
    }, 30_000);
  }
});
