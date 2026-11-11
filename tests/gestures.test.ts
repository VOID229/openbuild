import { describe, expect, test } from "bun:test";
import { dragClaims, dragCommits, holdLayout, REPLY_AT, replyDrag } from "../src/lib/gestures";

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

describe("the menu for a held bubble", () => {
  const view = { viewTop: 20, viewBottom: 800, gap: 8, bar: 50, menu: 150 };
  test("keeps the bubble where it was, its reactions above and its actions below", () => {
    const at = holdLayout({ ...view, bubbleTop: 300, bubbleHeight: 60 });
    expect(at).toEqual({ top: 300 - 58, flipped: false, shift: 0, bubbleHeight: 60 });
  });
  test("puts the actions above when there's no room for them below", () => {
    const at = holdLayout({ ...view, bubbleTop: 700, bubbleHeight: 60 });
    expect(at.flipped).toBe(true);
    expect(at.shift).toBe(0);
    expect(at.top).toBe(700 - 58 - 158);
  });
  test("slides back onto the screen when neither way fits", () => {
    const top = holdLayout({ ...view, bubbleTop: 30, bubbleHeight: 60 });
    expect(top.flipped).toBe(false);
    expect(top.top).toBe(20);
    expect(top.shift).toBe(20 - (30 - 58));
    const low = holdLayout({ ...view, bubbleTop: 790, bubbleHeight: 400, viewBottom: 1000 });
    expect(low.top + 58 + low.bubbleHeight + 8 + 150).toBeLessThanOrEqual(1000);
  });
  test("cuts a bubble too tall to fit beside its menu short", () => {
    const at = holdLayout({ ...view, bubbleTop: 0, bubbleHeight: 2000 });
    expect(at.bubbleHeight).toBe(800 - 20 - 58 - 8 - 150);
    expect(at.top).toBe(20);
  });
  test("leaves no room for reactions it doesn't show", () => {
    expect(holdLayout({ ...view, bar: 0, bubbleTop: 300, bubbleHeight: 60 }).top).toBe(300);
  });
});
