// A card of several questions, in a real Chrome: answering steps on, the arrows and arrow keys move
// without answering, answers survive a reload, and the bot's side hears nothing until Submit sends
// every answer in one message. A card of one question stays as it was.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page, serveFixture } from "./chromePage";
import type { BotMessage, Question, QuestionStep } from "../shared/bots";

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
const posts = () => writes.filter((w) => w.method === "POST").map((w) => w.body as BotMessage);
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
    if (!stored.some((m) => m.id === body.id)) stored.push(body);
    return Response.json(body, { headers });
  }
  const id = /\/messages\/([^/]+)$/.exec(rest)?.[1];
  if (req.method === "PATCH" && id) {
    const body = (await req.json()) as { question?: { answer?: string; answers?: (string | null)[]; submit?: boolean } };
    writes.push({ method: "PATCH", body });
    const m = stored.find((x) => x.id === id)!;
    // As the server keeps them (server/bots/service.ts answerQuestion and answerSteps).
    const q = m.question!;
    if (typeof body.question?.answer === "string") m.question = { ...q, answer: body.question.answer };
    if (body.question?.answers && q.steps && !q.submitted) m.question = { ...q, steps: q.steps.map(({ answer: _, ...s }, i) => (body.question!.answers![i] ? { ...s, answer: body.question!.answers![i]! } : s)), ...(body.question.submit ? { submitted: true } : {}) };
    return Response.json(m, { headers });
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
    expect(writes.filter((w) => w.method === "PATCH").map((w) => w.body)).toEqual([{ question: { answer: "B" } }]);
  }, 30_000);
});
