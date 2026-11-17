// Which keydowns ⌥1–9 in OpenBots takes (switchKeys.tsx): the digit comes from the key's code, as a
// Mac's Option makes "¡" or "™" of it, and a field being typed in keeps what a layout types with Option.
import { describe, expect, test } from "bun:test";
import { safeWhileTyping, switchDigit } from "../src/components/bots/switchKeys";
import { cheatsheetGroups } from "../src/lib/cheatsheet";

const event = (patch: Partial<Parameters<typeof switchDigit>[0]>) => ({ code: "", key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...patch });

describe("⌥1–9 in the OpenBots sidebar", () => {
  test("reads the digit from the code, whatever character Option makes of it", () => {
    expect(switchDigit(event({ code: "Digit1", key: "¡", altKey: true }))).toBe(1);
    expect(switchDigit(event({ code: "Digit2", key: "™", altKey: true }))).toBe(2);
    expect(switchDigit(event({ code: "Digit9", key: "9", altKey: true }))).toBe(9);
  });

  test("only Option on its own with 1–9: not 0, the numpad, another modifier or AltGr", () => {
    expect(switchDigit(event({ code: "Digit1", key: "1" }))).toBeUndefined();
    expect(switchDigit(event({ code: "Digit0", key: "º", altKey: true }))).toBeUndefined();
    expect(switchDigit(event({ code: "Numpad1", key: "1", altKey: true }))).toBeUndefined();
    expect(switchDigit(event({ code: "Digit1", key: "⁄", altKey: true, shiftKey: true }))).toBeUndefined();
    expect(switchDigit(event({ code: "Digit1", key: "1", altKey: true, metaKey: true }))).toBeUndefined();
    // Windows reports AltGr as Ctrl+Alt.
    expect(switchDigit(event({ code: "Digit7", key: "{", altKey: true, ctrlKey: true }))).toBeUndefined();
    expect(switchDigit({ ...event({ code: "Digit7", key: "{", altKey: true }), getModifierState: (k: string) => k === "AltGraph" })).toBeUndefined();
  });

  test("in a field, takes what types nothing or a symbol nobody types this way", () => {
    // Windows and Linux: Alt+digit types nothing, and the key is the digit.
    expect(safeWhileTyping("3", 3)).toBe(true);
    expect(safeWhileTyping("Unidentified", 3)).toBe(true);
    // A US Mac.
    for (const [key, n] of [["¡", 1], ["™", 2], ["∞", 5], ["§", 6], ["¶", 7], ["•", 8], ["ª", 9]] as const) expect(safeWhileTyping(key, n)).toBe(true);
  });

  test("in a field, leaves what a layout types with Option: brackets, #, @, currencies and accents", () => {
    // A German Mac's ⌥5–9, a British one's ⌥3, ⌥L's @ elsewhere.
    for (const [key, n] of [["[", 5], ["]", 6], ["|", 7], ["{", 8], ["}", 9], ["#", 3], ["@", 1]] as const) expect(safeWhileTyping(key, n)).toBe(false);
    for (const [key, n] of [["£", 3], ["€", 2], ["¢", 4], ["¥", 1]] as const) expect(safeWhileTyping(key, n)).toBe(false);
    expect(safeWhileTyping("Dead", 6)).toBe(false);
  });

  test("the cheatsheet lists it", () => {
    const row = (query: string, mac: boolean) => cheatsheetGroups(query, undefined, mac).flatMap((g) => g.rows).find((r) => r.label === "Go to a bot in OpenBots");
    expect(row("switch bot", false)?.keys).toEqual(["Alt", "1–9"]);
    expect(row("pinned", true)?.keys).toEqual(["⌥", "1–9"]);
  });
});
