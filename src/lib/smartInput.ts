// What the message composer does to a list as it is typed: a new line in an item starts the next
// one, the numbers after it move up, and a new line in an empty item ends the list. Any other edit
// that adds or takes an item away puts the numbers back in order (renumberAfter). Each takes the
// draft and its selection and gives the draft back changed, or nothing when the key should do what
// it always does.
import { ITEM } from "./chatText";

export interface Edit {
  text: string;
  /** The selection afterwards. */
  start: number;
  end: number;
}

interface Item {
  indent: string;
  bullet?: string;
  number?: number;
  /** "." or ")" after a number. */
  dot: string;
  space: string;
  body: string;
  /** How long the line is before the item's own text. */
  lead: number;
}

function itemOf(line: string): Item | undefined {
  const m = ITEM.exec(line);
  if (!m) return;
  const [, indent, bullet, number, dot, space, body] = m as unknown as [string, string, string | undefined, string | undefined, string | undefined, string, string];
  return { indent, bullet, number: number === undefined ? undefined : Number(number), dot: dot ?? "", space, body, lead: line.length - body.length };
}

const markOf = (item: Item, number?: number) => `${item.indent}${item.bullet ?? `${number}${item.dot}`}${item.space}`;

/** Inside a code block a "-" is code, not a list. */
const inFence = (text: string, at: number) => (text.slice(0, at).match(/```/g)?.length ?? 0) % 2 === 1;

/** The numbered items from line `from` on, counted on from `first`, for as long as the list runs. */
function renumber(lines: string[], from: number, first: number) {
  for (let i = from, n = first; i < lines.length; i++, n++) {
    const item = itemOf(lines[i]!);
    if (item?.number === undefined) return;
    lines[i] = markOf(item, n) + item.body;
  }
}

/** The number of the numbered item right above line `at`, if the list goes on up there. */
const numberAbove = (lines: string[], at: number) => (at > 0 ? itemOf(lines[at - 1]!)?.number : undefined);

/** The draft's lines, and the line and column the caret is on. */
function place(text: string, caret: number) {
  const lines = text.split("\n");
  let row = 0;
  let from = 0;
  while (row < lines.length - 1 && from + lines[row]!.length < caret) from += lines[row++]!.length + 1;
  return { lines, row, from, col: caret - from };
}

const offsetOf = (lines: string[], row: number) => lines.slice(0, row).reduce((n, l) => n + l.length + 1, 0);

/**
 * A new line typed in a list item (Shift+Enter; Enter on a phone). The next item starts, with the
 * next number, taking along what was after the caret, and the numbers below count on from it. In an
 * item with nothing in it, the list ends instead: its mark goes and the line is left empty.
 */
export function continueList(draft: string, start: number, end = start): Edit | undefined {
  if (inFence(draft, start)) return;
  const text = draft.slice(0, start) + draft.slice(end);
  const { lines, row, col } = place(text, start);
  const item = itemOf(lines[row]!);
  // Before the item's text the caret is in its mark: an ordinary new line.
  if (!item || col < item.lead) return;
  if (!item.body.trim()) {
    lines[row] = "";
    if (item.number !== undefined) renumber(lines, row + 1, (numberAbove(lines, row) ?? item.number - 1) + 1);
    const at = offsetOf(lines, row);
    return { text: lines.join("\n"), start: at, end: at };
  }
  const next = markOf(item, item.number === undefined ? undefined : item.number + 1);
  const line = lines[row]!;
  lines.splice(row, 1, line.slice(0, col), next + line.slice(col));
  if (item.number !== undefined) renumber(lines, row + 2, item.number + 2);
  const at = offsetOf(lines, row + 1) + next.length;
  return { text: lines.join("\n"), start: at, end: at };
}

/**
 * Backspace right after an item's mark ("1. |text"): the whole mark goes, the text stays, and the
 * numbers below close up.
 */
export function unlist(text: string, start: number, end = start): Edit | undefined {
  if (start !== end || inFence(text, start)) return;
  const { lines, row, col } = place(text, start);
  const item = itemOf(lines[row]!);
  if (!item || col !== item.lead) return;
  lines[row] = item.indent + item.body;
  if (item.number !== undefined) renumber(lines, row + 1, numberAbove(lines, row) === undefined ? item.number : numberAbove(lines, row)! + 1);
  const at = offsetOf(lines, row) + item.indent.length;
  return { text: lines.join("\n"), start: at, end: at };
}

/**
 * After any other edit the field makes itself (a selection deleted or typed over, Delete, a word or a
 * line deleted at once, a cut, a paste, a dropped text): when it adds or takes away a line or a
 * numbered item, the numbers from the edit down count on again, for as long as that list runs, so a
 * list always reads 1, 2, 3. `before` and `after` are the draft either side of the edit, and
 * `start`/`end` the selection after it, which keeps its place in the text.
 *
 * A list's first number is its own: one started at 3 stays at 3, and when its first item goes, the
 * next one takes that number. Changing the first item's number counts the rest on from the new one.
 * Any other number typed by hand is left as it is, and so is the text above the edit.
 */
export function renumberAfter(before: string, after: string, start: number, end = start): Edit | undefined {
  if (before === after) return;
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  const suffix = after.length - s;
  const lines = after.split("\n");
  const old = before.split("\n");
  const at = lines.map((_, i) => offsetOf(lines, i));
  /** The numbered item on a line, if it is one and isn't code. */
  const numbered = (text: string, all: string[], row: number) => {
    const line = all[row];
    if (line === undefined || inFence(text, offsetOf(all, row))) return;
    const item = itemOf(line);
    return item?.number === undefined ? undefined : item;
  };
  // The rows above the edit's first line are the same in both drafts.
  const first = place(after, p).row;
  const was = numbered(before, old, first);
  const is = numbered(after, lines, first);
  const above = first > 0 ? numbered(after, lines, first - 1)?.number : undefined;
  const lined = before.slice(p, before.length - s).includes("\n") || after.slice(p, suffix).includes("\n");
  const restarted = was && is && above === undefined && was.number !== is.number;
  if (!lined && !!was === !!is && !restarted) return;
  const last = place(after, suffix).row;

  const changes: { at: number; old: number; next: string }[] = [];
  let prev = above;
  let seen = above;
  for (let row = first; row < lines.length; row++) {
    const item = numbered(after, lines, row);
    if (!item) {
      if (row > last) break;
      prev = undefined;
      continue;
    }
    let n: number;
    if (prev !== undefined) n = prev + 1;
    // A list that starts on a line from the old draft, moved up to where its items went: it counts on
    // from the item above them, or takes the number the first one had.
    else if (at[row]! + item.indent.length >= suffix) n = seen !== undefined ? seen + 1 : (was?.number ?? item.number!);
    // Its first number is the one written there.
    else n = item.number!;
    const digits = lines[row]!.length - item.body.length - item.space.length - item.dot.length - item.indent.length;
    if (String(n) !== lines[row]!.slice(item.indent.length, item.indent.length + digits)) {
      changes.push({ at: at[row]! + item.indent.length, old: digits, next: String(n) });
      lines[row] = markOf(item, n) + item.body;
    }
    prev = seen = n;
  }
  if (!changes.length) return;
  // The selection keeps its place: past a number that got longer or shorter, it moves with it.
  const keep = (x: number) => {
    let shift = 0;
    for (const c of changes) {
      if (x >= c.at + c.old) shift += c.next.length - c.old;
      else if (x > c.at) return c.at + shift + Math.min(x - c.at, c.next.length);
      else break;
    }
    return x + shift;
  };
  return { text: lines.join("\n"), start: keep(start), end: keep(end) };
}

/** A draft as it is sent: without the empty item a list was left on ("1. a\n2. "), which nobody wrote. */
export const withoutOpenItem = (text: string): string => text.replace(/(?:^|\n) {0,3}(?:[-*•]|\d{1,3}[.)])[ \t]+\s*$/, "").trim();
