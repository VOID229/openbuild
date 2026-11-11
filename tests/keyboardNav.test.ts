// Focus rings show only while the user moves around by keyboard: the stylesheet keys them off the
// attribute this sets, so the attribute coming and going is the behaviour.
import { expect, test } from "bun:test";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: win, document: win.document });
const { trackKeyboardNav } = await import("../src/lib/keyboardNav");

test("moving by keyboard marks the document, and a pointer press unmarks it", () => {
  const root = win.document.documentElement as unknown as HTMLElement;
  trackKeyboardNav(root);
  const key = (key: string, init: object = {}) => win.dispatchEvent(new win.KeyboardEvent("keydown", { key, ...init }));
  const marked = () => root.hasAttribute("data-keyboard-nav");

  // Typing isn't moving around, and neither is a shortcut that happens to use an arrow.
  key("a");
  key("Enter");
  key("ArrowLeft", { altKey: true });
  key("Tab", { ctrlKey: true });
  expect(marked()).toBe(false);

  for (const name of ["Tab", "ArrowDown", "Home", "PageUp"]) {
    key(name);
    expect(marked()).toBe(true);
    win.dispatchEvent(new win.Event("pointerdown"));
    expect(marked()).toBe(false);
  }
});
