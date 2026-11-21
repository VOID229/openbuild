// A chat message's Markdown: what a bubble lays out (ChatText.tsx) and what the composer shows while
// it is typed (draftMarks). Both read the same blocks and tokens, so a draft looks like its message.

/** `at` to `end` is the token in the text, marks and all; bold and italic hold what is inside them. */
export type ChatToken =
  | { kind: "text"; at: number; end: number; text: string }
  | { kind: "code"; at: number; end: number; text: string }
  | { kind: "bold"; at: number; end: number; text: string; tokens: ChatToken[] }
  | { kind: "italic"; at: number; end: number; text: string; tokens: ChatToken[] }
  | { kind: "link"; at: number; end: number; text: string; url: string };

/** A table column's alignment, from its delimiter row ( :--, --:, :-: ). */
export type ChatAlign = "left" | "right" | "center" | undefined;

export type ChatBlock =
  | { kind: "text"; at: number; tokens: ChatToken[] }
  /** `mark` is where the item's own "-" or "2." is in the text. */
  | { kind: "item"; at: number; marker: string; mark: [number, number]; tokens: ChatToken[] }
  | { kind: "fence"; at: number; end: number; text: string; lang?: string }
  /** `mark` is the "## " in front of the heading; its text is bold. */
  | { kind: "heading"; at: number; end: number; mark: [number, number]; tokens: ChatToken[] }
  | { kind: "rule"; at: number; end: number }
  /** `bars` are the ">" of each line; `blocks` is what is quoted, laid out as any message is. */
  | { kind: "quote"; at: number; end: number; bars: number[]; blocks: ChatBlock[] }
  /** `delim` is the line of dashes and colons under the header; `head` and each row hold a cell's tokens. */
  | { kind: "table"; at: number; end: number; delim: [number, number]; align: ChatAlign[]; head: ChatToken[][]; rows: ChatToken[][][] };

const FENCE = /```[\s\S]*?(?:```|$)/g;
// Italic takes a whole word or more: "snake_case", "2*3*4" and "*.ts, *.tsx" stay as they are written.
const ITALIC = /(?<![\p{L}\d*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\p{L}\d*])|(?<![\p{L}\d_])_(?![\s_])([^_\n]+?)(?<![\s_])_(?![\p{L}\d_])/gu;
// Inline code, bold and italic at once ("***"), bold, italic, then a [link](https://…).
const INLINE = new RegExp([/`([^`\n]+)`/, /\*\*\*([^*\n]+)\*\*\*/, /\*\*((?:[^*\n]|\*(?!\*))+?)\*\*/, ITALIC, /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/].map((r) => r.source).join("|"), "gu");
/** A list line: its indent, "-" or a number and its "." or ")", the space after, and the item's text. */
export const ITEM = /^( {0,3})(?:([-*•])|(\d{1,3})([.)]))([ \t]+)(.*)$/;
/** A divider: a line of three or more dashes, and nothing else. */
const RULE = /^ {0,3}-{3,}[ \t]*$/;
/** A heading: one to three "#", then a space and its text. "#hashtag" and "#123" are not headings. */
const HEADING = /^( {0,3})(#{1,3})([ \t]+)(\S.*?)[ \t]*$/;
/** A quote line: ">" and one space after it, if there is one. */
const QUOTE = /^( {0,3})>( ?)/;
/** A table's delimiter cell: dashes, with a colon on either end for the alignment. */
const DELIMITER_CELL = /^:?-+:?$/;

/** In a link written bare (https://x.dev/_a_/b), nothing is italic. */
const inUrl = (text: string, at: number) => /(?:[a-z][a-z\d+.-]*:\/\/|www\.)\S*$/i.test(text.slice(0, at));

export function chatTokens(text: string, offset = 0): ChatToken[] {
  const out: ChatToken[] = [];
  let last = 0;
  const plain = (to: number) => {
    if (to > last) out.push({ kind: "text", at: offset + last, end: offset + to, text: text.slice(last, to) });
  };
  for (const m of text.matchAll(INLINE)) {
    const from = m.index ?? 0;
    const at = offset + from;
    const end = at + m[0].length;
    const italic = m[4] ?? m[5];
    if (italic !== undefined && inUrl(text, from)) continue;
    plain(from);
    if (m[1] !== undefined) out.push({ kind: "code", at, end, text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "bold", at, end, text: m[2], tokens: [{ kind: "italic", at: at + 2, end: end - 2, text: m[2], tokens: chatTokens(m[2], at + 3) }] });
    else if (m[3] !== undefined) out.push({ kind: "bold", at, end, text: m[3], tokens: chatTokens(m[3], at + 2) });
    else if (italic !== undefined) out.push({ kind: "italic", at, end, text: italic, tokens: chatTokens(italic, at + 1) });
    else out.push({ kind: "link", at, end, text: m[6]!, url: m[7]! });
    last = from + m[0].length;
  }
  plain(text.length);
  return out;
}

function fence(at: number, raw: string): ChatBlock {
  const body = raw.slice(3, raw.endsWith("```") && raw.length >= 6 ? -3 : undefined);
  const line = body.indexOf("\n");
  const lang = line >= 0 && /^[\w+#.-]{1,20}$/.test(body.slice(0, line).trim()) ? body.slice(0, line).trim() : undefined;
  const text = (lang || (line >= 0 && !body.slice(0, line).trim()) ? body.slice(line + 1) : body).replace(/\n$/, "");
  return { kind: "fence", at, end: at + raw.length, text, ...(lang ? { lang } : {}) };
}

/** A line of text, where it starts in the message. */
interface Line {
  at: number;
  text: string;
}

function linesOf(text: string, offset: number): Line[] {
  let at = offset;
  return text.split("\n").map((t) => {
    const line = { at, text: t };
    at += t.length + 1;
    return line;
  });
}

/** Tokens of several lines as one run: a line break between them, and the same positions as the message. */
function runTokens(lines: Line[]): ChatToken[] {
  const out: ChatToken[] = [];
  lines.forEach((l, i) => {
    if (i) {
      const prev = lines[i - 1]!;
      out.push({ kind: "text", at: prev.at + prev.text.length, end: prev.at + prev.text.length + 1, text: "\n" });
    }
    out.push(...chatTokens(l.text, l.at));
  });
  // Plain text that runs on across lines is one token, as it is in the message.
  const merged: ChatToken[] = [];
  for (const t of out) {
    const last = merged.at(-1);
    if (t.kind === "text" && last?.kind === "text" && last.end === t.at) merged[merged.length - 1] = { kind: "text", at: last.at, end: t.end, text: last.text + t.text };
    else merged.push(t);
  }
  return merged;
}

/** A table row's cells, each with its text (trimmed) and where it starts. `\|` is a pipe inside a cell. */
function cellsOf(line: Line): Line[] {
  const text = line.text;
  const lead = text.length - text.trimStart().length;
  let from = lead;
  let to = text.trimEnd().length;
  if (text[from] === "|") from++;
  if (to > from && text[to - 1] === "|" && text[to - 2] !== "\\") to--;
  const out: Line[] = [];
  let start = from;
  for (let i = from; i <= to; i++) {
    if (i === to || (text[i] === "|" && text[i - 1] !== "\\")) {
      const cell = text.slice(start, i);
      out.push({ at: line.at + start + (cell.length - cell.trimStart().length), text: cell.trim() });
      start = i + 1;
    }
  }
  return out;
}

/** A line is a table's delimiter when it has a pipe and one dash cell for each header cell. */
const isDelimiter = (line: Line, columns: number) => line.text.includes("|") && cellsOf(line).length === columns && cellsOf(line).every((c) => DELIMITER_CELL.test(c.text));

/** A line that starts a block of its own (a list item, divider, heading or quote), so it isn't a table row. */
const startsBlock = (text: string) => ITEM.test(text) || RULE.test(text) || HEADING.test(text) || QUOTE.test(text);

const alignOf = (cell: string): ChatAlign => {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : undefined;
};

/** Lines as blocks: lists, headings, dividers, quotes and tables, and the text between them. */
function blocksOf(lines: Line[]): ChatBlock[] {
  const out: ChatBlock[] = [];
  let run: Line[] = [];
  const flush = () => {
    let from = 0;
    let to = run.length;
    while (from < to && !run[from]!.text.trim()) from++;
    while (to > from && !run[to - 1]!.text.trim()) to--;
    const body = run.slice(from, to);
    run = [];
    if (!body.length) return;
    // Trailing spaces after the message's last words are not part of it.
    const last = body.length - 1;
    body[last] = { at: body[last]!.at, text: body[last]!.text.trimEnd() };
    out.push({ kind: "text", at: body[0]!.at, tokens: runTokens(body) });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const { at, text } = line;
    if (!text.trim()) {
      if (run.length) run.push(line);
      continue;
    }
    const item = ITEM.exec(text);
    if (item) {
      flush();
      const [, indent, bullet, number, , space, body] = item as unknown as [string, string, string | undefined, string | undefined, string | undefined, string, string];
      const mark = at + indent.length;
      const markEnd = mark + (bullet ?? `${number}.`).length;
      out.push({ kind: "item", at, marker: bullet ? "•" : `${number}.`, mark: [mark, markEnd], tokens: chatTokens(body, markEnd + space.length) });
      continue;
    }
    if (RULE.test(text)) {
      flush();
      out.push({ kind: "rule", at, end: at + text.length });
      continue;
    }
    const heading = HEADING.exec(text);
    if (heading) {
      flush();
      const [, indent, hashes, space, body] = heading as unknown as [string, string, string, string, string];
      const contentAt = at + indent.length + hashes.length + space.length;
      out.push({ kind: "heading", at, end: contentAt + body.length, mark: [at + indent.length, contentAt], tokens: chatTokens(body, contentAt) });
      continue;
    }
    if (QUOTE.test(text)) {
      flush();
      const group: Line[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!.text)) group.push(lines[i++]!);
      i--;
      const bars: number[] = [];
      const inner = group.map((l) => {
        const [prefix, indent] = QUOTE.exec(l.text) as unknown as [string, string];
        bars.push(l.at + indent.length);
        return { at: l.at + prefix.length, text: l.text.slice(prefix.length) };
      });
      const last = group[group.length - 1]!;
      out.push({ kind: "quote", at, end: last.at + last.text.length, bars, blocks: blocksOf(inner) });
      continue;
    }
    const next = lines[i + 1];
    const head = cellsOf(line);
    if (text.includes("|") && next && isDelimiter(next, head.length)) {
      flush();
      const rows: Line[][] = [];
      let j = i + 2;
      // Rows go on until a blank line or the start of another block, as in GitHub's Markdown.
      while (j < lines.length && lines[j]!.text.trim() && !startsBlock(lines[j]!.text)) rows.push(cellsOf(lines[j++]!));
      const last = j > i + 2 ? lines[j - 1]! : next;
      // A row has as many cells as the header: more are left out, fewer are empty.
      const fit = (cells: Line[]) => head.map((_, c) => (cells[c] ? chatTokens(cells[c]!.text, cells[c]!.at) : []));
      out.push({
        kind: "table",
        at,
        end: last.at + last.text.length,
        delim: [next.at, next.at + next.text.length],
        align: cellsOf(next).map((c) => alignOf(c.text)),
        head: head.map((c) => chatTokens(c.text, c.at)),
        rows: rows.map(fit),
      });
      i = j - 1;
      continue;
    }
    run.push(line);
  }
  flush();
  return out;
}

function prose(text: string, offset: number): ChatBlock[] {
  return blocksOf(linesOf(text, offset));
}

export function chatBlocks(text: string): ChatBlock[] {
  const out: ChatBlock[] = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    const at = m.index ?? 0;
    out.push(...prose(text.slice(last, at), last), fence(at, m[0]));
    last = at + m[0].length;
  }
  out.push(...prose(text.slice(last), last));
  return out.length === 1 && out[0]!.kind === "text" ? [{ kind: "text", at: 0, tokens: chatTokens(text) }] : out;
}

/**
 * How a stretch of a draft is drawn in the composer. `mark` is Markdown's own characters ("**", a
 * backtick, a link's address, a heading's "#", a quote's ">", a table's pipes), `bullet` a list's "-",
 * `number` its "2.", `fence` a code block's lines, `bold` a heading's text.
 */
export type DraftMarkKind = "mark" | "bold" | "italic" | "code" | "fence" | "link" | "bullet" | "number";
export interface DraftMark {
  at: number;
  end: number;
  kind: DraftMarkKind;
}

function tokenMarks(tokens: ChatToken[], out: DraftMark[]) {
  for (const t of tokens) {
    if (t.kind === "text") continue;
    if (t.kind === "code") {
      out.push({ at: t.at, end: t.end, kind: "code" }, { at: t.at, end: t.at + 1, kind: "mark" }, { at: t.end - 1, end: t.end, kind: "mark" });
    } else if (t.kind === "link") {
      const text = t.at + 1 + t.text.length;
      out.push({ at: t.at, end: t.at + 1, kind: "mark" }, { at: t.at + 1, end: text, kind: "link" }, { at: text, end: t.end, kind: "mark" });
    } else {
      // What is inside starts after the opening mark and stops before the closing one.
      const from = t.tokens[0]?.at ?? t.at;
      const to = t.tokens.at(-1)?.end ?? t.end;
      out.push({ at: t.at, end: t.end, kind: t.kind }, { at: t.at, end: from, kind: "mark" }, { at: to, end: t.end, kind: "mark" });
      tokenMarks(t.tokens, out);
    }
  }
}

function blockMarks(text: string, blocks: ChatBlock[], out: DraftMark[]) {
  for (const b of blocks) {
    if (b.kind === "fence") {
      // What opens and closes the block are its marks (the opening line with its language); the rest is code.
      const raw = text.slice(b.at, b.end);
      const line = raw.indexOf("\n");
      const first = line < 0 ? undefined : raw.slice(3, line).trim();
      out.push({ at: b.at, end: b.end, kind: "fence" }, { at: b.at, end: b.at + (first === "" || (first && first === b.lang) ? line : 3), kind: "mark" });
      if (raw.length >= 6 && raw.endsWith("```")) out.push({ at: b.end - 3, end: b.end, kind: "mark" });
    } else if (b.kind === "item") {
      out.push({ at: b.mark[0], end: b.mark[1], kind: b.marker === "•" ? "bullet" : "number" });
      tokenMarks(b.tokens, out);
    } else if (b.kind === "heading") {
      out.push({ at: b.mark[0], end: b.mark[1], kind: "mark" }, { at: b.mark[1], end: b.end, kind: "bold" });
      tokenMarks(b.tokens, out);
    } else if (b.kind === "rule") {
      out.push({ at: b.at, end: b.end, kind: "mark" });
    } else if (b.kind === "quote") {
      for (const bar of b.bars) out.push({ at: bar, end: bar + 1, kind: "mark" });
      blockMarks(text, b.blocks, out);
    } else if (b.kind === "table") {
      out.push({ at: b.delim[0], end: b.delim[1], kind: "mark" });
      for (let k = b.at; k < b.end; k++) if (text[k] === "|") out.push({ at: k, end: k + 1, kind: "mark" });
      for (const cell of [...b.head, ...b.rows.flat()]) tokenMarks(cell, out);
    } else {
      tokenMarks(b.tokens, out);
    }
  }
}

/** The stretches of a draft to draw as its message will show them, each where it is in the text. They nest, never cross. */
export function draftMarks(text: string): DraftMark[] {
  const out: DraftMark[] = [];
  blockMarks(text, chatBlocks(text), out);
  return out.filter((m) => m.end > m.at).sort((a, b) => a.at - b.at || b.end - a.end);
}

/** Text without the marks of bold, italic and inline code, for a line that only names a message. */
export const unmarked = (text: string): string =>
  text.replace(/\*\*|__|`/g, "").replace(ITALIC, (whole: string, star: string | undefined, under: string | undefined, at: number, all: string) => (inUrl(all, at) ? whole : (star ?? under)!));

export const oneLine = (text: string): string =>
  unmarked(
    text
      .replace(/```[\w+#.-]*\n?/g, "")
      .replace(/^ {0,3}(?:[-*•]|\d{1,3}[.)])[ \t]+/gm, "")
      .replace(/^ {0,3}#{1,3}[ \t]+/gm, "")
      .replace(/^ {0,3}>[ \t]?/gm, "")
      .replace(/^ {0,3}-{3,}[ \t]*$/gm, ""),
  )
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
