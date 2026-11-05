import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dragClaims, dragCommits, REPLY_AT, replyDrag } from "../src/lib/gestures";

describe("dragging a pane", () => {
  const width = 400;
  test("finishes once far enough, or thrown", () => {
    expect(dragCommits(width * 0.5, 0, width)).toBe(true);
    expect(dragCommits(40, 1, width)).toBe(true);
  });
  test("falls back when it's short and slow, or barely moved however fast", () => {
    expect(dragCommits(40, 0.1, width)).toBe(false);
    expect(dragCommits(10, 2, width)).toBe(false);
  });
});

describe("swiping a bubble to reply", () => {
  test("follows the finger up to the point where letting go replies", () => {
    expect(replyDrag(-20)).toBe(20);
    expect(replyDrag(-REPLY_AT)).toBe(REPLY_AT);
  });
  test("drags more reluctantly past it", () => {
    expect(replyDrag(-(REPLY_AT + 40))).toBe(REPLY_AT + 10);
  });
  test("goes nowhere the other way, where the screen's edge means back", () => {
    expect(replyDrag(50)).toBe(0);
  });
});

describe("the phone stylesheet", () => {
  // Nothing in it may reach a desktop window: outside the sheet, which only touch screens open, every
  // rule sits behind a media query for phones or for touch.
  const css = readFileSync("src/mobile.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const topLevel: string[] = [];
  let depth = 0;
  let selector = "";
  for (const ch of css) {
    if (ch === "{") {
      if (depth === 0) topLevel.push(selector.trim());
      selector = "";
      depth++;
    } else if (ch === "}") {
      depth--;
      selector = "";
    } else selector += ch;
  }
  test("keeps its rules behind phone or touch media queries", () => {
    const loose = topLevel.filter((s) => !s.startsWith("@media"));
    for (const s of loose) expect(s).toMatch(/^\.(sheet|bm-sheet|bm-swipe-icon)/);
  });
  test("its queries only match phones, touch screens, or reduced motion", () => {
    const queries = topLevel.filter((s) => s.startsWith("@media"));
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q).toMatch(/max-width: (768|960)px|pointer: coarse|hover: none|prefers-reduced-motion/);
  });
});

describe("dragClaims", () => {
  test("a swipe that's clearly sideways, the right way, pulls the pane", () => {
    expect(dragClaims(-20, 3, -1)).toBe(true);
    expect(dragClaims(20, -3, 1)).toBe(true);
  });

  test("a thumb arcing up a list is a scroll, even when it starts more sideways than up", () => {
    expect(dragClaims(-14, -8, -1)).toBe(false);
    expect(dragClaims(-10, -10, -1)).toBe(false);
    expect(dragClaims(0, -12, -1)).toBe(false);
  });

  test("a swipe the other way leaves the pane alone", () => {
    expect(dragClaims(20, 0, -1)).toBe(false);
    expect(dragClaims(-20, 0, 1)).toBe(false);
  });
});
