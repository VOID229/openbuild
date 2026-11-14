import { describe, expect, test } from "bun:test";
import { cheatsheetGroups } from "../src/lib/cheatsheet";
import { matchShortcut } from "../src/lib/shortcutKeys";

const labels = (query: string, shortcuts?: Record<string, string>, mac = true) =>
  cheatsheetGroups(query, shortcuts, mac).flatMap((g) => g.rows.map((r) => `${g.title}: ${r.label}`));
const row = (query: string, label: string, shortcuts?: Record<string, string>, mac = true) =>
  cheatsheetGroups(query, shortcuts, mac).flatMap((g) => g.rows).find((r) => r.label === label);

describe("⌘K cheatsheet", () => {
  test("lists every group with nothing typed, the cheatsheet itself first", () => {
    const groups = cheatsheetGroups("", undefined, true);
    expect(groups.map((g) => g.title)).toEqual(["General", "Composer", "Side panel", "Terminal", "Elsewhere"]);
    expect(groups[0]!.rows[0]).toMatchObject({ label: "Keyboard shortcuts", keys: ["⌘", "K"] });
  });

  test("shows shortcuts as they're set now, unset ones as such, in the platform's spelling", () => {
    expect(row("", "New thread", undefined, true)?.keys).toEqual(["⌘", "⇧", "O"]);
    expect(row("", "New thread", undefined, false)?.keys).toEqual(["Ctrl", "Shift", "O"]);
    expect(row("", "New thread", { newThread: "mod+alt+KeyN" })?.keys).toEqual(["⌘", "⌥", "N"]);
    expect(row("", "Stash draft", { stashDraft: "none" })?.keys).toEqual([]);
    expect(row("", "Go to tab", undefined, false)?.keys).toEqual(["Alt", "1–9"]);
  });

  test("search needs every word, from the label, group, keys or extra words", () => {
    expect(labels("sidebar")).toEqual(["General: Toggle left sidebar", "General: Toggle right sidebar"]);
    expect(labels("terminal close")).toEqual(["Terminal: Close terminal tab"]);
    expect(labels("pr")).toContain("Side panel: Pull requests");
    expect(labels("SHELL")).toContain("Composer: Run a shell command");
    expect(labels("nothing like this")).toEqual([]);
  });

  test("finds a combination however it's written", () => {
    for (const q of ["⌘b", "cmd b", "ctrl+b", "mod b"]) expect(labels(q)).toContain("General: Toggle left sidebar");
    for (const q of ["⌥w", "alt w", "option+w"]) expect(labels(q)).toEqual(["Side panel: Close tab", "Terminal: Close terminal tab"]);
    expect(labels("⌥3")).toEqual(["Side panel: Go to tab", "Terminal: Go to terminal tab"]);
    expect(labels("shift")).toEqual(["General: New thread", "Composer: New line", "Composer: Use the last stash"]);
    expect(labels("⌘⇧s")).toEqual(["Composer: Use the last stash"]);
    // A rebound shortcut is found by its new keys, and no longer by its old ones.
    expect(labels("⌘⌥n", { newThread: "mod+alt+KeyN" })).toEqual(["General: New thread"]);
    expect(labels("⌘⇧o", { newThread: "mod+alt+KeyN" })).toEqual([]);
  });
});

describe("⌘K's key", () => {
  const press = (patch: Partial<KeyboardEvent>) =>
    ({ code: "KeyK", key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, ...patch }) as KeyboardEvent;
  // Just enough of an element: what it is, and what it sits in.
  const element = (tagName: string, inside = "") =>
    ({ tagName, isContentEditable: false, closest: (sel: string) => (inside && sel.split(",").some((s) => s.trim() === inside) ? {} : null) }) as unknown as Element;
  const onMac = (mac: boolean, fn: () => void) => {
    const was = Object.getOwnPropertyDescriptor(navigator, "platform");
    Object.defineProperty(navigator, "platform", { value: mac ? "MacIntel" : "Linux x86_64", configurable: true });
    try {
      fn();
    } finally {
      if (was) Object.defineProperty(navigator, "platform", was);
      else delete (navigator as any).platform;
    }
  };

  test("opens the cheatsheet from the page and from text fields", () => {
    onMac(false, () => {
      expect(matchShortcut(press({ ctrlKey: true }), {}, element("BODY"))).toBe("showShortcuts");
      expect(matchShortcut(press({ ctrlKey: true }), {}, element("TEXTAREA"))).toBe("showShortcuts");
    });
    onMac(true, () => expect(matchShortcut(press({ metaKey: true }), {}, element("TEXTAREA"))).toBe("showShortcuts"));
  });

  test("Ctrl+K stays with a terminal, and with a Mac's text fields, where it deletes to the end of the line", () => {
    onMac(false, () => expect(matchShortcut(press({ ctrlKey: true }), {}, element("TEXTAREA", ".xterm"))).toBeUndefined());
    onMac(true, () => {
      expect(matchShortcut(press({ ctrlKey: true }), {}, element("TEXTAREA"))).toBeUndefined();
      expect(matchShortcut(press({ ctrlKey: true }), {}, element("TEXTAREA", ".xterm"))).toBeUndefined();
      // ⌘K still opens it there, and Ctrl+K away from a field.
      expect(matchShortcut(press({ metaKey: true }), {}, element("TEXTAREA", ".xterm"))).toBe("showShortcuts");
      expect(matchShortcut(press({ ctrlKey: true }), {}, element("BODY"))).toBe("showShortcuts");
    });
  });
});
