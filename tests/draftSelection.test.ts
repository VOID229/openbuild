import { describe, expect, test } from "bun:test";
import { rememberDraftSelection, restoreDraftSelection } from "../src/lib/draftSelection";

function field(value: string, start = 0, end = start, direction: "forward" | "backward" | "none" = "none") {
  return {
    value,
    selectionStart: start,
    selectionEnd: end,
    selectionDirection: direction,
    setSelectionRange(a: number, b: number, d: "forward" | "backward" | "none" = "none") {
      this.selectionStart = a;
      this.selectionEnd = b;
      this.selectionDirection = d;
    },
  };
}

describe("draft cursor restoration", () => {
  test("returning to the new-thread draft restores its last caret, independently of a thread", () => {
    rememberDraftSelection("home", field("a draft already here", 8));
    rememberDraftSelection("thread", field("another draft", 3));
    const home = field("a draft already here");
    restoreDraftSelection("home", home);
    expect(home.selectionStart).toBe(8);
    expect(home.selectionEnd).toBe(8);
  });

  test("preserves a backwards selection, including a caret at the first character", () => {
    rememberDraftSelection("selection", field("draft", 1, 4, "backward"));
    const selected = field("draft");
    restoreDraftSelection("selection", selected);
    expect([selected.selectionStart, selected.selectionEnd, selected.selectionDirection]).toEqual([1, 4, "backward"]);
    rememberDraftSelection("selection", field("draft", 0));
    restoreDraftSelection("selection", selected);
    expect(selected.selectionStart).toBe(0);
  });

  test("unknown and asynchronously loaded drafts fall back to the end", () => {
    const loaded = field("");
    restoreDraftSelection("loaded", loaded);
    expect(loaded.selectionStart).toBe(0);
    loaded.value = "loaded after mount";
    restoreDraftSelection("loaded", loaded);
    expect(loaded.selectionStart).toBe(loaded.value.length);
    expect(loaded.selectionEnd).toBe(loaded.value.length);
  });

  test("changed content does not reuse stale offsets", () => {
    rememberDraftSelection("remote", field("old draft", 2));
    const updated = field("draft changed elsewhere");
    restoreDraftSelection("remote", updated);
    expect(updated.selectionStart).toBe(updated.value.length);
  });

  test("typing in the middle keeps the new caret when the value is rendered", () => {
    const typed = field("helXlo", 4);
    rememberDraftSelection("typing", typed);
    restoreDraftSelection("typing", typed);
    expect(typed.selectionStart).toBe(4);
  });
});
