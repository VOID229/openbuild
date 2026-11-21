import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatText } from "../src/components/ChatText";
import { chatBlocks, chatTokens, draftMarks, oneLine, unmarked, type ChatToken } from "../src/lib/chatText";

/** Tokens by kind and text, with what is inside bold and italic. */
const shape = (tokens: ChatToken[]): unknown[] => tokens.map((t) => (t.kind === "bold" || t.kind === "italic" ? [t.kind, shape(t.tokens)] : [t.kind, t.text]));

test("a line splits into text, bold, inline code and links", () => {
  expect(chatTokens("Run **this** with `ls` or [read](https://dkod.ai/docs).")).toEqual([
    { kind: "text", at: 0, end: 4, text: "Run " },
    { kind: "bold", at: 4, end: 12, text: "this", tokens: [{ kind: "text", at: 6, end: 10, text: "this" }] },
    { kind: "text", at: 12, end: 18, text: " with " },
    { kind: "code", at: 18, end: 22, text: "ls" },
    { kind: "text", at: 22, end: 26, text: " or " },
    { kind: "link", at: 26, end: 54, text: "read", url: "https://dkod.ai/docs" },
    { kind: "text", at: 54, end: 55, text: "." },
  ]);
});

test("italic is written with stars or underscores, and goes inside bold", () => {
  expect(shape(chatTokens("An *italic* and an _italic_ word"))).toEqual([["text", "An "], ["italic", [["text", "italic"]]], ["text", " and an "], ["italic", [["text", "italic"]]], ["text", " word"]]);
  expect(shape(chatTokens("**bold with _italic_ and `code`**"))).toEqual([["bold", [["text", "bold with "], ["italic", [["text", "italic"]]], ["text", " and "], ["code", "code"]]]]);
  expect(shape(chatTokens("**bold *italic* bold**"))).toEqual([["bold", [["text", "bold "], ["italic", [["text", "italic"]]], ["text", " bold"]]]]);
  expect(shape(chatTokens("***both***"))).toEqual([["bold", [["italic", [["text", "both"]]]]]]);
  expect(chatTokens("_a_ b")[0]).toMatchObject({ kind: "italic", at: 0, end: 3, text: "a" });
});

test("stars and underscores that aren't marks stay as they were written", () => {
  for (const plain of ["snake_case_name and __init__.py", "2*3*4 = 24", "*.ts, *.tsx and *args", "a * b * c", "_private_var", "see https://dkod.ai/_next_/a_b_c for it", "5 * 3 and 4 *2"]) {
    expect(shape(chatTokens(plain))).toEqual([["text", plain]]);
  }
  // Nothing in inline code is marked up.
  expect(shape(chatTokens("`*not* _italic_`"))).toEqual([["code", "*not* _italic_"]]);
});

test("a plain message stays one block, with its line breaks", () => {
  expect(chatBlocks("Hello\n\nthere")).toEqual([{ kind: "text", at: 0, tokens: [{ kind: "text", at: 0, end: 12, text: "Hello\n\nthere" }] }]);
});

test("a fenced block keeps its code and language, and nothing in it is marked up", () => {
  expect(chatBlocks("Try:\n\n```sh\ncurl **x** `y`\n- not a list\n```\n\nDone.")).toEqual([
    { kind: "text", at: 0, tokens: [{ kind: "text", at: 0, end: 4, text: "Try:" }] },
    { kind: "fence", at: 6, end: 43, text: "curl **x** `y`\n- not a list", lang: "sh" },
    { kind: "text", at: 45, tokens: [{ kind: "text", at: 45, end: 50, text: "Done." }] },
  ]);
  expect(chatBlocks("```\nplain\n```")).toEqual([{ kind: "fence", at: 0, end: 13, text: "plain" }]);
  expect(chatBlocks("```ts\nconst a = 1;")).toEqual([{ kind: "fence", at: 0, end: 18, text: "const a = 1;", lang: "ts" }]);
});

test("list lines become items, bulleted or numbered, with their own marks", () => {
  const blocks = chatBlocks("Two things:\n\n- **One** thing\n* two\n\n1. first\n2) second\n\nAfter - not a list");
  expect(blocks.map((b) => [b.kind, b.kind === "item" ? b.marker : ""])).toEqual([["text", ""], ["item", "•"], ["item", "•"], ["item", "1."], ["item", "2."], ["text", ""]]);
  expect(blocks[1]).toMatchObject({ tokens: [{ kind: "bold", text: "One" }, { kind: "text", text: " thing" }] });
  expect(blocks[5]).toMatchObject({ tokens: [{ kind: "text", text: "After - not a list" }] });
});

test("an item with nothing in it yet is still an item, and one says where its mark is", () => {
  expect(chatBlocks("- ")).toEqual([{ kind: "item", at: 0, marker: "•", mark: [0, 1], tokens: [] }]);
  expect(chatBlocks("1. one\n  12) ")).toMatchObject([{ kind: "item", marker: "1.", mark: [0, 2] }, { kind: "item", at: 7, marker: "12.", mark: [9, 12], tokens: [] }]);
  // A dash with no space after it is a dash.
  expect(chatBlocks("-")).toEqual([{ kind: "text", at: 0, tokens: [{ kind: "text", at: 0, end: 1, text: "-" }] }]);
});

test("a line that names a message has no marks of bold, italic or code, and keeps what only looks like them", () => {
  expect(unmarked("**Ship** the *chart* with _care_, `now`, ***really***")).toBe("Ship the chart with care, now, really");
  expect(unmarked("snake_case, 2*3*4, *.ts and https://dkod.ai/_next_/x")).toBe("snake_case, 2*3*4, *.ts and https://dkod.ai/_next_/x");
});

test("a preview line has no Markdown marks", () => {
  expect(oneLine("Four things:\n\n- **Correctness**: tests\n- `Policy` and _care_ for *all*\n\n```sh\nls\n```\n[docs](https://dkod.ai)")).toBe("Four things: Correctness: tests Policy and care for all ls docs");
});

/** A draft's marks as the text each covers. */
const drawn = (text: string) => draftMarks(text).map((m) => [m.kind, text.slice(m.at, m.end)]);

test("a draft's marks say what to draw, each where it is in the text", () => {
  expect(drawn("so **bold** and _it_ and `ls`")).toEqual([
    ["bold", "**bold**"], ["mark", "**"], ["mark", "**"],
    ["italic", "_it_"], ["mark", "_"], ["mark", "_"],
    ["code", "`ls`"], ["mark", "`"], ["mark", "`"],
  ]);
  expect(drawn("***x***")).toEqual([["bold", "***x***"], ["mark", "**"], ["italic", "*x*"], ["mark", "*"], ["mark", "*"], ["mark", "**"]]);
  expect(drawn("[docs](https://dkod.ai)")).toEqual([["mark", "["], ["link", "docs"], ["mark", "](https://dkod.ai)"]]);
});

test("a draft's list marks are its bullets and numbers, also on an item still empty", () => {
  expect(drawn("- one\n* **two**\n3) three\n4. ")).toEqual([["bullet", "-"], ["bullet", "*"], ["bold", "**two**"], ["mark", "**"], ["mark", "**"], ["number", "3)"], ["number", "4."]]);
});

test("a draft's code block is drawn from its opening line on, closed or not", () => {
  expect(drawn("```sh\nls **x**\n```")).toEqual([["fence", "```sh\nls **x**\n```"], ["mark", "```sh"], ["mark", "```"]]);
  expect(drawn("a\n```\nls")).toEqual([["fence", "```\nls"], ["mark", "```"]]);
  expect(drawn("```ls```")).toEqual([["fence", "```ls```"], ["mark", "```"], ["mark", "```"]]);
});

test("a draft's marks nest and never cross, so each stretch is drawn one way", () => {
  const text = "1. **a _b_ `c`** [d](https://e.f) *g*\n- h\n```\ni\n```";
  const marks = draftMarks(text);
  for (const a of marks) for (const b of marks) expect(a.end <= b.at || b.end <= a.at || (a.at <= b.at && a.end >= b.end) || (b.at <= a.at && b.end >= a.end)).toBe(true);
});

test("a table is its header and rows of cells, with each column's alignment", () => {
  const [table] = chatBlocks("| Plan | Price |\n| :--- | ---: |\n| **Pro** | `$9` |");
  expect(table).toMatchObject({ kind: "table", at: 0, align: ["left", "right"] });
  expect(table).toMatchObject({ head: [[{ kind: "text", text: "Plan" }], [{ kind: "text", text: "Price" }]] });
  expect(table).toMatchObject({ rows: [[[{ kind: "bold", text: "Pro" }], [{ kind: "code", text: "$9" }]]] });
  // Each cell's tokens say where they are in the message, so a draft can mark them.
  expect(drawn("| **Pro** | `$9` |\n| --- | --- |")).toContainEqual(["bold", "**Pro**"]);
});

test("a table without outer pipes pads a short row, and a header alone is a table", () => {
  expect(chatBlocks("a | b\n--- | ---\n1")).toMatchObject([{ kind: "table", align: [undefined, undefined], rows: [[[{ kind: "text", text: "1" }], []]] }]);
  expect(chatBlocks("| a |\n| - |")).toMatchObject([{ kind: "table", head: [[{ kind: "text", text: "a" }]], rows: [] }]);
});

test("a pipe in ordinary prose is not a table, and a dash line under it is a divider", () => {
  expect(chatBlocks("use a | b to pipe\nthen c | d").map((b) => b.kind)).toEqual(["text"]);
  expect(chatBlocks("a | b\n---").map((b) => b.kind)).toEqual(["text", "rule"]);
});

test("a divider is a line of dashes, and it stays apart from a list next to it", () => {
  expect(chatBlocks("- one\n---\n- two").map((b) => b.kind)).toEqual(["item", "rule", "item"]);
  expect(chatBlocks("---")).toEqual([{ kind: "rule", at: 0, end: 3 }]);
  // Two dashes, or a dash that is a list item, are not a divider.
  expect(chatBlocks("--").map((b) => b.kind)).toEqual(["text"]);
  expect(chatBlocks("- - -").map((b) => b.kind)).toEqual(["item"]);
});

test("a quote is what follows each quote mark, laid out as any message is, lists and bold included", () => {
  const [quote, after] = chatBlocks("> **quoted** line\n> - item\n\nafter");
  expect(quote).toMatchObject({ kind: "quote", at: 0, bars: [0, 18] });
  expect((quote as { blocks: { kind: string }[] }).blocks.map((b) => b.kind)).toEqual(["text", "item"]);
  expect(quote).toMatchObject({ blocks: [{ tokens: [{ kind: "bold", text: "quoted" }, { kind: "text", text: " line" }] }, { kind: "item", marker: "•", mark: [20, 21] }] });
  expect(after).toMatchObject({ kind: "text", tokens: [{ kind: "text", text: "after" }] });
});

test("a quote mark inside a code block is code, and so is a pipe line or a heading in one", () => {
  expect(chatBlocks("```\n> not a quote\n# not a heading\n| a | b |\n|-|-|\n```")).toEqual([{ kind: "fence", at: 0, end: 53, text: "> not a quote\n# not a heading\n| a | b |\n|-|-|" }]);
});

test("a heading is a line of one to three # and a space, and a hashtag or issue number is not one", () => {
  expect(chatBlocks("## Plan")).toEqual([{ kind: "heading", at: 0, end: 7, mark: [0, 3], tokens: [{ kind: "text", at: 3, end: 7, text: "Plan" }] }]);
  expect(chatBlocks("#hashtag and #123 issue").map((b) => b.kind)).toEqual(["text"]);
  expect(chatBlocks("#123").map((b) => b.kind)).toEqual(["text"]);
  expect(chatBlocks("#### four").map((b) => b.kind)).toEqual(["text"]);
});

test("a draft shows the new syntax's marks, and its heading's text bold", () => {
  expect(drawn("> **a** `b`")).toEqual([["mark", ">"], ["bold", "**a**"], ["mark", "**"], ["mark", "**"], ["code", "`b`"], ["mark", "`"], ["mark", "`"]]);
  expect(drawn("## Title")).toEqual([["mark", "## "], ["bold", "Title"]]);
  expect(drawn("a\n---")).toEqual([["mark", "---"]]);
  expect(drawn("| x | y |\n| --- | :-: |")).toEqual([["mark", "|"], ["mark", "|"], ["mark", "|"], ["mark", "| --- | :-: |"], ["mark", "|"], ["mark", "|"], ["mark", "|"]]);
});

test("a preview line has no heading, quote or divider marks", () => {
  expect(oneLine("## Plan\n> quoted line\n---\nend")).toBe("Plan quoted line end");
});

test("a bubble lays out its blocks: bold headings, quotes, dividers and tables, with mentions and links still tags", () => {
  const plain = (t: string) => `[${t}]`;
  const html = renderToStaticMarkup(createElement(ChatText, { text: "## Plan\n\n> quoted **x**\n\n---\n\n| a | @Ann |\n| :-- | --- |\n| [docs](https://dkod.ai) | 2 |", plain }));
  expect(html).toContain('<div class="chat-h">[Plan]</div>');
  expect(html).toContain('<blockquote class="chat-quote">');
  expect(html).toContain('<div class="chat-rule" role="separator"></div>');
  expect(html).toContain('<div class="chat-table-wrap"><table class="chat-table">');
  expect(html).toContain('<th style="text-align:left">[a]</th>');
  expect(html).toContain('<a class="link" href="https://dkod.ai"');
  expect(html).toContain("[@Ann]");
});
