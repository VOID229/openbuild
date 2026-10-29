import { describe, expect, test } from "bun:test";
import {
  assignShortcut,
  bindingFromEvent,
  bindingKeys,
  bindingNote,
  bindingsEqual,
  eventMatchesBinding,
  formatBinding,
  isDefaultShortcut,
  isUnsetShortcut,
  keyLabel,
  parseBinding,
  serializeBinding,
  shortcutBinding,
  shortcutValue,
  type ShortcutEvent,
} from "../src/lib/shortcuts";

const event = (patch: Partial<ShortcutEvent>): ShortcutEvent => ({
  code: "",
  key: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

describe("shortcut bindings", () => {
  test("parse and serialize in a stable order", () => {
    expect(parseBinding("mod+shift+KeyO")).toEqual({ mod: true, alt: false, shift: true, code: "KeyO" });
    expect(parseBinding("Shift+Mod+Alt+KeyM")).toEqual({ mod: true, alt: true, shift: true, code: "KeyM" });
    expect(parseBinding("mod+comma")).toEqual({ mod: true, alt: false, shift: false, code: "Comma" });
    expect(parseBinding("slash")).toEqual({ mod: false, alt: false, shift: false, code: "Slash" });
    expect(serializeBinding({ mod: true, alt: false, shift: true, code: "KeyO" })).toBe("mod+shift+KeyO");
    expect(serializeBinding({ mod: false, alt: true, shift: false, code: "KeyM" })).toBe("alt+KeyM");
  });

  test("unset, empty and malformed values have no binding", () => {
    expect(parseBinding(undefined)).toBeNull();
    expect(parseBinding("")).toBeNull();
    expect(parseBinding("none")).toBeNull();
    expect(parseBinding("mod+")).toBeNull();
    expect(parseBinding("mod+alt")).toBeNull();
  });

  test("records the key code, not the character Option or Shift produces", () => {
    // macOS reports "µ" as the key for Option+M.
    expect(bindingFromEvent(event({ code: "KeyM", key: "µ", altKey: true }))).toEqual({
      mod: false,
      alt: true,
      shift: false,
      code: "KeyM",
    });
    expect(bindingFromEvent(event({ code: "KeyB", key: "B", metaKey: true, shiftKey: true }))).toEqual({
      mod: true,
      alt: false,
      shift: true,
      code: "KeyB",
    });
    expect(bindingFromEvent(event({ code: "Comma", key: ",", ctrlKey: true }))).toEqual({
      mod: true,
      alt: false,
      shift: false,
      code: "Comma",
    });
  });

  test("modifier keys alone don't become a shortcut", () => {
    expect(bindingFromEvent(event({ code: "AltLeft", key: "Alt", altKey: true }))).toBeNull();
    expect(bindingFromEvent(event({ code: "ShiftRight", key: "Shift", shiftKey: true }))).toBeNull();
    expect(bindingFromEvent(event({ code: "MetaLeft", key: "Meta", metaKey: true }))).toBeNull();
  });

  test("matching is exact about modifiers and the key", () => {
    const binding = parseBinding("mod+shift+KeyO")!;
    expect(eventMatchesBinding(event({ code: "KeyO", key: "O", metaKey: true, shiftKey: true }), binding)).toBe(true);
    expect(eventMatchesBinding(event({ code: "KeyO", key: "O", ctrlKey: true, shiftKey: true }), binding)).toBe(true);
    expect(eventMatchesBinding(event({ code: "KeyO", key: "O", metaKey: true }), binding)).toBe(false);
    expect(eventMatchesBinding(event({ code: "KeyO", key: "O", metaKey: true, shiftKey: true, altKey: true }), binding)).toBe(false);
    expect(eventMatchesBinding(event({ code: "KeyP", key: "P", metaKey: true, shiftKey: true }), binding)).toBe(false);
    expect(bindingsEqual(parseBinding("alt+KeyM")!, parseBinding("alt+KeyM")!)).toBe(true);
    expect(bindingsEqual(parseBinding("alt+KeyM")!, parseBinding("mod+KeyM")!)).toBe(false);
  });

  test("formats for the platform, with one keycap per key", () => {
    const optionM = parseBinding("alt+KeyM")!;
    const newThread = parseBinding("mod+shift+KeyO")!;
    expect(formatBinding(optionM, true)).toBe("⌥M");
    expect(formatBinding(optionM, false)).toBe("Alt+M");
    expect(formatBinding(newThread, true)).toBe("⌘⇧O");
    expect(formatBinding(newThread, false)).toBe("Ctrl+Shift+O");
    expect(bindingKeys(newThread, true)).toEqual(["⌘", "⇧", "O"]);
    expect(bindingKeys(newThread, false)).toEqual(["Ctrl", "Shift", "O"]);
    expect(keyLabel("Slash")).toBe("/");
    expect(keyLabel("ArrowUp")).toBe("↑");
  });

  test("reads defaults and saves overrides per action", () => {
    const defaults = { shortcuts: {} };
    expect(shortcutValue(defaults, "toggleSidebar")).toBe("mod+KeyB");
    expect(shortcutValue(defaults, "toggleRightSidebar")).toBe("mod+KeyI");
    expect(shortcutBinding(defaults, "toggleRightSidebar")).toEqual({ mod: true, alt: false, shift: false, code: "KeyI" });
    expect(shortcutBinding(defaults, "toggleSidebar")).toEqual({ mod: true, alt: false, shift: false, code: "KeyB" });
    expect(isDefaultShortcut(defaults, "toggleSidebar")).toBe(true);
    const custom = { shortcuts: { toggleSidebar: "alt+KeyB", newThread: "none" } };
    expect(shortcutValue(custom, "toggleSidebar")).toBe("alt+KeyB");
    expect(shortcutBinding(custom, "toggleSidebar")).toEqual({ mod: false, alt: true, shift: false, code: "KeyB" });
    expect(isDefaultShortcut(custom, "toggleSidebar")).toBe(false);
    expect(isUnsetShortcut(custom, "newThread")).toBe(true);
    expect(shortcutBinding(custom, "newThread")).toBeNull();
  });

  test("assigning a taken combination unsets the action that had it", () => {
    const sidebar = parseBinding("mod+KeyB")!;
    const next = assignShortcut(undefined, "newThread", sidebar);
    expect(next.newThread).toBe("mod+KeyB");
    expect(next.toggleSidebar).toBe("none");
    // The other actions keep their defaults.
    expect(next.toggleTerminal).toBeUndefined();
    // A free combination doesn't unset anything.
    expect(assignShortcut(undefined, "newThread", parseBinding("mod+KeyN")!)).toEqual({ newThread: "mod+KeyN" });
    expect(assignShortcut({ toggleSidebar: "alt+KeyN" }, "newThread", parseBinding("alt+KeyN")!)).toEqual({
      newThread: "alt+KeyN",
      toggleSidebar: "none",
    });
  });

  test("flags combinations the browser or OpenBuild already owns", () => {
    expect(bindingNote(parseBinding("mod+KeyN")!, true)).toContain("⌘N");
    expect(bindingNote(parseBinding("mod+KeyN")!, false)).toContain("Ctrl+N");
    expect(bindingNote(parseBinding("mod+KeyS")!, true)).toContain("saves");
    expect(bindingNote(parseBinding("mod+KeyB")!, true)).toBeUndefined();
    expect(bindingNote(parseBinding("alt+KeyM")!, true)).toBeUndefined();
  });
});
