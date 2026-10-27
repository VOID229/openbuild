import type { Settings } from "./types";

/**
 * App-wide keyboard shortcuts. A binding is stored as `mod+alt+shift+<code>`, where `code` is a
 * `KeyboardEvent.code` ("KeyB", "Comma", "Slash", …). Using the code rather than `event.key` means
 * Option/Alt combinations still read as the key that was pressed (on macOS Option+M reports "µ" as
 * its key) and Shift changes a modifier instead of the recorded key.
 */

export type ShortcutId =
  | "newThread"
  | "toggleSidebar"
  | "toggleTerminal"
  | "openSettings"
  | "focusSearch"
  | "toggleDictation";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  description: string;
  /** Serialized default. */
  default: string;
  /** Allow a key without ⌘/Ctrl/Alt, like "/". */
  bare?: boolean;
  /** Leave the key alone while a field has focus, so it can still be typed. */
  typingSensitive?: boolean;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  {
    id: "newThread",
    label: "New thread",
    description: "Start an empty thread, from anywhere in OpenBuild.",
    default: "mod+shift+KeyO",
  },
  {
    id: "toggleSidebar",
    label: "Toggle sidebar",
    description: "Show or hide the thread list.",
    default: "mod+KeyB",
  },
  {
    id: "toggleTerminal",
    label: "Toggle terminal",
    description: "Open or hide the terminal for the thread's folder.",
    default: "mod+KeyJ",
  },
  {
    id: "toggleDictation",
    label: "Toggle dictation",
    description: "Start or stop dictating into the focused field, or the composer.",
    default: "alt+KeyM",
  },
  {
    id: "openSettings",
    label: "Open settings",
    description: "Open this window.",
    default: "mod+Comma",
  },
  {
    id: "focusSearch",
    label: "Search threads",
    description: "Focus thread search, or the composer when the sidebar is closed.",
    default: "Slash",
    bare: true,
    typingSensitive: true,
  },
];

/** One parsed key combination. */
export interface KeyBinding {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  /** `KeyboardEvent.code`, or `KeyboardEvent.key` when the browser gives no code. */
  code: string;
}

/** The parts of a keyboard event a shortcut cares about (a `KeyboardEvent` satisfies this). */
export interface ShortcutEvent {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Settings stores the combination a shortcut was changed to; missing or "none" means unset. */
export type ShortcutMap = Record<string, string>;

export const SHORTCUT_EVENT = "openbuild:shortcut";

export interface ShortcutEventDetail {
  action: ShortcutId;
}

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

export function shortcutDef(id: ShortcutId): ShortcutDef {
  return BY_ID.get(id)!;
}

/** The saved value for a shortcut: its binding, "none", or absent (use the default). */
export function shortcutValue(settings: Pick<Settings, "shortcuts">, id: ShortcutId): string {
  return settings.shortcuts?.[id] ?? shortcutDef(id).default;
}

export function shortcutBinding(settings: Pick<Settings, "shortcuts">, id: ShortcutId): KeyBinding | null {
  return parseBinding(shortcutValue(settings, id));
}

/** The default combination for an action, as a parsed binding. */
export function defaultBinding(id: ShortcutId): KeyBinding {
  return parseBinding(shortcutDef(id).default)!;
}

export function isDefaultShortcut(settings: Pick<Settings, "shortcuts">, id: ShortcutId): boolean {
  return shortcutValue(settings, id) === shortcutDef(id).default;
}

export function isUnsetShortcut(settings: Pick<Settings, "shortcuts">, id: ShortcutId): boolean {
  return shortcutValue(settings, id) === "none";
}

const MODIFIER_ALIASES: Record<string, "mod" | "alt" | "shift"> = {
  mod: "mod",
  cmd: "mod",
  command: "mod",
  meta: "mod",
  ctrl: "mod",
  control: "mod",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

const CODE_ALIASES: Record<string, string> = {
  comma: "Comma",
  period: "Period",
  slash: "Slash",
  backslash: "Backslash",
  semicolon: "Semicolon",
  quote: "Quote",
  bracketleft: "BracketLeft",
  bracketright: "BracketRight",
  minus: "Minus",
  equal: "Equal",
  backquote: "Backquote",
  space: "Space",
  spacebar: "Space",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
  ins: "Insert",
};

function normalizeCode(token: string): string {
  const key = token.toLowerCase();
  const alias = CODE_ALIASES[key];
  if (alias) return alias;
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return token;
}

/** Parse a stored combination. Returns null for unset or malformed values. */
export function parseBinding(value: string | undefined): KeyBinding | null {
  if (!value || value === "none") return null;
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const binding: KeyBinding = { mod: false, alt: false, shift: false, code: "" };
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier) return null;
    binding[modifier] = true;
  }
  const code = parts[parts.length - 1]!;
  if (MODIFIER_ALIASES[code.toLowerCase()]) return null;
  binding.code = normalizeCode(code);
  return binding.code ? binding : null;
}

export function serializeBinding(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.mod) parts.push("mod");
  if (binding.alt) parts.push("alt");
  if (binding.shift) parts.push("shift");
  parts.push(binding.code);
  return parts.join("+");
}

export function bindingsEqual(a: KeyBinding, b: KeyBinding): boolean {
  return a.mod === b.mod && a.alt === b.alt && a.shift === b.shift && a.code === b.code;
}

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "CapsLock",
  "Fn",
  "FnLock",
  "AltGraph",
  "NumLock",
]);

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn"]);

/**
 * The combination a keydown represents, or null while only modifiers are held. The next key pressed
 * is what gets recorded; Escape is left to the caller, which uses it to cancel recording.
 */
export function bindingFromEvent(e: ShortcutEvent): KeyBinding | null {
  const code = e.code || e.key;
  if (!code || MODIFIER_CODES.has(code) || MODIFIER_KEYS.has(e.key)) return null;
  return { mod: e.metaKey || e.ctrlKey, alt: e.altKey, shift: e.shiftKey, code };
}

export function eventMatchesBinding(e: ShortcutEvent, binding: KeyBinding): boolean {
  return (
    (e.code || e.key) === binding.code &&
    (e.metaKey || e.ctrlKey) === binding.mod &&
    e.altKey === binding.alt &&
    e.shiftKey === binding.shift
  );
}

/**
 * Set `id` to `binding`, unsetting any other action that already uses it ("none") so one key
 * combination never runs two things at once.
 */
export function assignShortcut(shortcuts: ShortcutMap | undefined, id: ShortcutId, binding: KeyBinding): ShortcutMap {
  const next: ShortcutMap = { ...(shortcuts ?? {}) };
  for (const def of SHORTCUTS) {
    if (def.id === id) continue;
    const current = shortcutBinding({ shortcuts: next }, def.id);
    if (current && bindingsEqual(current, binding)) next[def.id] = "none";
  }
  next[id] = serializeBinding(binding);
  return next;
}

const KEY_LABELS: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
  Enter: "↵",
  NumpadEnter: "Num ↵",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "Del",
  Insert: "Ins",
  Tab: "⇥",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  CapsLock: "Caps",
  ContextMenu: "Menu",
  PrintScreen: "PrtSc",
  ScrollLock: "ScrLk",
  Pause: "Pause",
  IntlBackslash: "\\",
  IntlRo: "Ro",
  IntlYen: "¥",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num −",
  NumpadMultiply: "Num ×",
  NumpadDivide: "Num ÷",
  NumpadDecimal: "Num .",
};

export function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return KEY_LABELS[code] ?? code;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
}

/** One keycap per visual key, e.g. ["⌘", "⇧", "O"] or ["Ctrl", "Shift", "O"]. */
export function bindingKeys(binding: KeyBinding, mac = isMacPlatform()): string[] {
  const keys: string[] = [];
  if (binding.mod) keys.push(mac ? "⌘" : "Ctrl");
  if (binding.alt) keys.push(mac ? "⌥" : "Alt");
  if (binding.shift) keys.push(mac ? "⇧" : "Shift");
  keys.push(keyLabel(binding.code));
  return keys;
}

/** A combination in running text: "⌘⇧O" on a Mac, "Ctrl+Shift+O" elsewhere. */
export function formatBinding(binding: KeyBinding, mac = isMacPlatform()): string {
  return bindingKeys(binding, mac).join(mac ? "" : "+");
}

/** Combinations the browser or OpenBuild itself keeps for something else, if any. */
export function bindingNote(binding: KeyBinding, mac = isMacPlatform()): string | undefined {
  const value = serializeBinding(binding);
  const key = formatBinding(binding, mac);
  if (value === "mod+KeyS") return `${key} saves an open file in OpenBuild.`;
  if (value === "mod+KeyR") return `Your browser keeps ${key} for reloading the page.`;
  if (value === "mod+KeyQ") return `Your browser or system keeps ${key} for quitting.`;
  if (
    value === "mod+KeyN" ||
    value === "mod+KeyT" ||
    value === "mod+KeyW" ||
    value === "mod+Shift+KeyN" ||
    value === "mod+Shift+KeyT" ||
    value === "mod+Shift+KeyW"
  ) {
    return `Your browser may keep ${key} for a new window or tab.`;
  }
  return undefined;
}

let recording = false;

/** True while Settings is waiting for the next keys, so global shortcuts leave them alone. */
export const setShortcutRecording = (value: boolean) => {
  recording = value;
};

export const isShortcutRecording = () => recording;
