// The composer's list editing (src/lib/smartInput.ts): "|" in a draft below is the caret.
import { expect, test } from "bun:test";
import { continueList, renumberAfter, unlist, withoutOpenItem, type Edit } from "../src/lib/smartInput";

/** Runs an edit on a draft written with its caret as "|" (two of them: a selection), and writes the answer the same way. */
const run = (edit: (text: string, start: number, end: number) => Edit | undefined, draft: string) => {
  const start = draft.indexOf("|");
  const end = draft.lastIndexOf("|");
  const text = draft.replaceAll("|", "");
  const next = edit(text, start, end === start ? start : end - 1);
  if (!next) return undefined;
  expect(next.end).toBe(next.start);
  return `${next.text.slice(0, next.start)}|${next.text.slice(next.start)}`;
};
const newLine = (draft: string) => run(continueList, draft);
const backspace = (draft: string) => run(unlist, draft);
/**
 * The field's own edit, then the numbers: what is selected in `draft` (between two "|") goes, and
 * `typed` takes its place, as a delete, a cut, a paste or typing over a selection does.
 */
const field = (draft: string, typed = "") => {
  const start = draft.indexOf("|");
  const end = draft.lastIndexOf("|") - (draft.lastIndexOf("|") === start ? 0 : 1);
  const text = draft.replaceAll("|", "");
  const after = text.slice(0, start) + typed + text.slice(end);
  const caret = start + typed.length;
  const next = renumberAfter(text, after, caret) ?? { text: after, start: caret, end: caret };
  expect(next.end).toBe(next.start);
  return `${next.text.slice(0, next.start)}|${next.text.slice(next.start)}`;
};

test("a new line in a numbered item starts the next number", () => {
  expect(newLine("1. something|")).toBe("1. something\n2. |");
  expect(newLine("Steps:\n\n9. nine|")).toBe("Steps:\n\n9. nine\n10. |");
  expect(newLine("3) three|")).toBe("3) three\n4) |");
});

test("a new line in a bullet starts another, with the same mark and indent", () => {
  expect(newLine("- one|")).toBe("- one\n- |");
  expect(newLine("* one|")).toBe("* one\n* |");
  expect(newLine("  - one|")).toBe("  - one\n  - |");
  expect(newLine("- one\n- two|\n- three")).toBe("- one\n- two\n- |\n- three");
});

test("a new line higher up in a numbered list puts the new item there, and the numbers below move up", () => {
  // Outis's case: back up on "1.", Shift+Enter again: a new "2.", and the old "2." is "3.".
  expect(newLine("1. something|\n2. ")).toBe("1. something\n2. |\n3. ");
  expect(newLine("1. one|\n2. two\n3. three\n4. four")).toBe("1. one\n2. |\n3. two\n4. three\n5. four");
  expect(newLine("1. one\n2. two|\n3. three\n\nAfter\n1. other")).toBe("1. one\n2. two\n3. |\n4. three\n\nAfter\n1. other");
  // Each item keeps its own "." or ")", and a list that doesn't start at 1 counts on from where it is.
  expect(newLine("7. seven|\n8) eight\n9. nine")).toBe("7. seven\n8. |\n9) eight\n10. nine");
  // Numbers that were out of order are in order afterwards.
  expect(newLine("1. one|\n1. two\n5. three")).toBe("1. one\n2. |\n3. two\n4. three");
});

test("the numbers move up only as far as the list goes", () => {
  expect(newLine("1. one|\n2. two\n- a bullet\n3. three")).toBe("1. one\n2. |\n3. two\n- a bullet\n3. three");
  expect(newLine("1. one|\n2. two\nplain\n3. three")).toBe("1. one\n2. |\n3. two\nplain\n3. three");
});

test("a new line in the middle of an item takes the rest of it to the new item", () => {
  expect(newLine("1. some|thing\n2. two")).toBe("1. some\n2. |thing\n3. two");
  expect(newLine("- a|b")).toBe("- a\n- |b");
  // With some of it selected, the selection goes, as it does for any typed line break.
  expect(newLine("1. so|me|thing")).toBe("1. so\n2. |thing");
});

test("a new line in an empty item ends the list", () => {
  expect(newLine("1. something\n2. |")).toBe("1. something\n|");
  expect(newLine("- one\n- |")).toBe("- one\n|");
  expect(newLine("- |")).toBe("|");
  // In the middle of a list, the numbers below close up.
  expect(newLine("1. one\n2. |\n3. three\n4. four")).toBe("1. one\n|\n2. three\n3. four");
  expect(newLine("1. |\n2. two\n3. three")).toBe("|\n1. two\n2. three");
});

test("a new line anywhere else is left to the field", () => {
  expect(newLine("just text|")).toBeUndefined();
  expect(newLine("1.5 is not a list|")).toBeUndefined();
  expect(newLine("-not a list|")).toBeUndefined();
  // In an item's mark, before its text.
  expect(newLine("|1. one")).toBeUndefined();
  expect(newLine("1.| one")).toBeUndefined();
  // In a code block a "-" is code.
  expect(newLine("```\n- one|")).toBeUndefined();
  expect(newLine("```\ncode\n```\n- one|")).toBe("```\ncode\n```\n- one\n- |");
});

test("backspace right after an item's mark takes the mark away, and the numbers below close up", () => {
  expect(backspace("- |one")).toBe("|one");
  expect(backspace("  - |")).toBe("  |");
  expect(backspace("1. one\n2. |two\n3. three")).toBe("1. one\n|two\n2. three");
  expect(backspace("1. |one\n2. two\n3. three")).toBe("|one\n1. two\n2. three");
  // Anywhere else, and with a selection, it is an ordinary backspace.
  expect(backspace("1. o|ne")).toBeUndefined();
  expect(backspace("1.| one")).toBeUndefined();
  expect(backspace("1. |on|e")).toBeUndefined();
  expect(backspace("```\n- |one")).toBeUndefined();
});

test("a message goes without the empty item its list was left on", () => {
  expect(withoutOpenItem("1. one\n2. two\n3. ")).toBe("1. one\n2. two");
  expect(withoutOpenItem("Shopping:\n- milk\n- \n")).toBe("Shopping:\n- milk");
  expect(withoutOpenItem("- ")).toBe("");
  // What was written stays: an item with text, a dash of its own, an empty item in the middle.
  expect(withoutOpenItem("  1. one\n2. two  ")).toBe("1. one\n2. two");
  expect(withoutOpenItem("so\n-")).toBe("so\n-");
  expect(withoutOpenItem("- a\n- \n- b")).toBe("- a\n- \n- b");
});

test("an item taken away any other way closes the numbers up below it", () => {
  // A whole line selected and deleted, or cut.
  expect(field("1. a\n|2. b\n|3. c\n4. d")).toBe("1. a\n|2. c\n3. d");
  expect(field("1. a|\n2. b|\n3. c\n4. d")).toBe("1. a|\n2. c\n3. d");
  // Cmd+Backspace: the line up to the caret goes, and the empty line is left.
  expect(field("1. a\n|2. b|\n3. c\n4. d")).toBe("1. a\n|\n2. c\n3. d");
  // Option+Backspace over the mark once its text has gone.
  expect(field("1. a\n|2. |\n3. c")).toBe("1. a\n|\n2. c");
  // Delete at the end of an item pulls the next one up into it.
  expect(field("1. a\n2. b|\n|3. c\n4. d")).toBe("1. a\n2. b|3. c\n3. d");
  // Several items at once.
  expect(field("1. a\n|2. b\n3. c\n|4. d\n5. e")).toBe("1. a\n|2. d\n3. e");
});

test("Outis's case: an item put in above and taken out again leaves the numbers as they were", () => {
  const added = newLine("1. foo|\n2. bar\n3. baz")!;
  expect(added).toBe("1. foo\n2. |\n3. bar\n4. baz");
  // The new line selected from the end of "foo" and deleted.
  expect(field("1. foo|\n2. |\n3. bar\n4. baz")).toBe("1. foo|\n2. bar\n3. baz");
  // Or with text in it, selected whole.
  expect(field("1. foo\n|2. new\n|3. bar\n4. baz")).toBe("1. foo\n|2. bar\n3. baz");
});

test("an item put in any other way moves the numbers below it up", () => {
  // Pasted, with its own number, or with a few lines.
  expect(field("1. a\n|2. b\n3. c", "1. new\n")).toBe("1. a\n2. new\n|3. b\n4. c");
  expect(field("1. a\n2. b|", "\n1. x\n1. y")).toBe("1. a\n2. b\n3. x\n4. y|");
  // Typed on a new line under the list: the space after the number makes it an item.
  expect(field("1. a\n2. b\n7.|", " ")).toBe("1. a\n2. b\n3. |");
  // A line break typed into a list: the items below count on from the one above, and those out of
  // order are put right.
  expect(field("1. a\n1. b\n|1. c\n1. d", "\n")).toBe("1. a\n1. b\n\n|2. c\n3. d");
  expect(field("1. a|\n|\n1. b\n1. c")).toBe("1. a|\n2. b\n3. c");
});

test("a list keeps the number it starts at", () => {
  // Its first item taken away: the next one takes its number.
  expect(field("|3. a\n|4. b\n5. c")).toBe("|3. b\n4. c");
  expect(field("Steps:\n|3. a\n|4. b")).toBe("Steps:\n|3. b");
  expect(field("Steps:\n|3. a|\n4. b")).toBe("Steps:\n|\n3. b");
  // A list someone starts at 3 stays at 3; a new first number counts the rest on from it.
  expect(field("Steps:\n|", "3. ")).toBe("Steps:\n3. |");
  expect(field("|1|. a\n2. b\n3. c", "3")).toBe("3|. a\n4. b\n5. c");
});

test("the numbers follow only where they should", () => {
  // Typing inside an item, or a number changed by hand further down, is left as it is.
  expect(field("1. a|\n2. b", "bc")).toBe("1. abc|\n2. b");
  expect(field("1. a\n|2|. b\n3. c", "5")).toBe("1. a\n5|. b\n3. c");
  // The numbers above the edit stay, and the list below a gap or another kind of line is another list.
  expect(field("1. a\n1. b\n|1. c\n|1. d")).toBe("1. a\n1. b\n|2. d");
  expect(field("1. a\n|2. b\n|3. c\n\n4. other")).toBe("1. a\n|2. c\n\n4. other");
  expect(field("1. a\n|2. b\n|3. c\n- x\n4. d")).toBe("1. a\n|2. c\n- x\n4. d");
  // Bullets and code have no numbers to follow.
  expect(field("- a\n|- b\n|- c")).toBe("- a\n|- c");
  expect(field("```\n1. a\n|2. b\n|3. c\n```")).toBe("```\n1. a\n|3. c\n```");
});

test("the caret keeps its place when a number gets shorter or longer", () => {
  expect(field("8. a\n|9. b\n|10. c")).toBe("8. a\n|9. c");
  expect(field("8. a\n9. b\n10. c|\n|11. dd")).toBe("8. a\n9. b\n10. c|11. dd");
  expect(field("8. a\n9. b|\n|10. cc\n11. dd")).toBe("8. a\n9. b|10. cc\n10. dd");
  const edit = renumberAfter("1. a\n2. b\n10. c\nend", "1. a\n10. c\nend", 12)!;
  expect(edit.text).toBe("1. a\n2. c\nend");
  expect(edit.text.slice(edit.start)).toBe("nd");
  // A selection over a number that is rewritten still covers it; a caret inside it stays inside.
  const over = renumberAfter("8. a\nx\n10. b", "8. a\n10. b", 5, 7)!;
  expect(over.text.slice(over.start, over.end)).toBe("9");
  expect(renumberAfter("8. a\nx\n10. b", "8. a\n10. b", 6)!.start).toBe(6);
});
