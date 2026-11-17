// What the ⌘K cheatsheet lists: the shortcuts Settings can change (as they're set now), and the keys
// that are fixed, grouped by where they work. Read-only: changing one is Settings → Shortcuts' job.
import { create } from "zustand";
import { bindingKeys, isMacPlatform, parseBinding, shortcutBinding, type KeyBinding, type ShortcutId, type ShortcutMap } from "./shortcuts";

export const useCheatsheet = create<{ open: boolean }>(() => ({ open: false }));
export const toggleCheatsheet = () => useCheatsheet.setState((s) => ({ open: !s.open }));
export const closeCheatsheet = () => useCheatsheet.setState({ open: false });

interface Entry {
  label: string;
  /** A shortcut from Settings, shown as it's set (or "Not set"). */
  id?: ShortcutId;
  /** A fixed combination, like "alt+KeyB". */
  bind?: string;
  /** In place of the combination's last key, like "1–9" for a range of digits. */
  last?: string;
  /** Keys as they are, for things typed rather than held, like "@". */
  keys?: string[];
  /** Extra words search finds it by. */
  also?: string;
}

const GROUPS: { title: string; entries: Entry[] }[] = [
  {
    title: "General",
    entries: [
      { label: "Keyboard shortcuts", id: "showShortcuts", also: "cheatsheet help keys" },
      { label: "New thread", id: "newThread" },
      { label: "Search threads", id: "focusSearch", also: "find" },
      { label: "Toggle left sidebar", id: "toggleSidebar", also: "threads list" },
      { label: "Toggle right sidebar", id: "toggleRightSidebar", also: "side panel" },
      { label: "Toggle terminal", id: "toggleTerminal", also: "shell drawer" },
      { label: "Toggle OpenBots", id: "toggleBots", also: "bots" },
      { label: "Settings", id: "openSettings", also: "preferences" },
      { label: "Usage & limits", id: "openUsage" },
      { label: "Go to a bot in OpenBots", bind: "alt+Digit1", last: "1–9", also: "switch bots groups pinned" },
      { label: "Close a dialog or go back", keys: ["Esc"], also: "escape" },
    ],
  },
  {
    title: "Composer",
    entries: [
      { label: "Focus the composer", keys: ["↵"], also: "enter" },
      { label: "Send", keys: ["↵"], also: "enter submit" },
      { label: "New line", bind: "shift+Enter" },
      { label: "Send and start a new thread", bind: "mod+Enter", also: "background" },
      { label: "Stash draft", id: "stashDraft", also: "save" },
      { label: "Use the last stash", id: "useLastStash", also: "paste newest stashed draft restore" },
      { label: "Toggle dictation", id: "toggleDictation", also: "voice microphone" },
      { label: "Mention a file", keys: ["@"] },
      { label: "Commands", keys: ["/"], also: "slash" },
      { label: "Run a shell command", keys: ["!"], also: "bang" },
      { label: "Cancel editing a queued message", keys: ["Esc"] },
      { label: "Reorder a queued message", bind: "alt+ArrowUp", last: "↑↓", also: "move" },
    ],
  },
  {
    title: "Side panel",
    entries: [
      { label: "Browser tab", bind: "alt+KeyB", also: "web" },
      { label: "Terminal tab", bind: "alt+KeyT", also: "shell" },
      { label: "Diff tab", bind: "alt+KeyD", also: "changes git" },
      { label: "Pull requests", bind: "alt+KeyP", also: "pr github" },
      { label: "Close tab", bind: "alt+KeyW" },
      { label: "Go to tab", bind: "alt+Digit1", last: "1–9", also: "switch" },
    ],
  },
  {
    title: "Terminal",
    entries: [
      { label: "New terminal tab", bind: "alt+KeyT", also: "shell" },
      { label: "Close terminal tab", bind: "alt+KeyW", also: "shell" },
      { label: "Go to terminal tab", bind: "alt+Digit1", last: "1–9", also: "shell switch" },
    ],
  },
  {
    title: "Elsewhere",
    entries: [
      { label: "Commit, in the Git menu", bind: "mod+Enter", also: "git" },
      { label: "Previous or next image", bind: "ArrowLeft", last: "← →", also: "lightbox viewer picture" },
    ],
  },
];

export interface CheatsheetRow {
  key: string;
  label: string;
  /** One keycap per key; empty when a Settings shortcut is unset. */
  keys: string[];
}

export interface CheatsheetGroup {
  title: string;
  rows: CheatsheetRow[];
}

const bindingOf = (entry: Entry, shortcuts: ShortcutMap | undefined): KeyBinding | null =>
  entry.id ? shortcutBinding({ shortcuts }, entry.id) : parseBinding(entry.bind);

function rowKeys(entry: Entry, binding: KeyBinding | null, mac: boolean): string[] {
  if (entry.keys) return entry.keys;
  if (!binding) return [];
  const keys = bindingKeys(binding, mac);
  if (entry.last) keys[keys.length - 1] = entry.last;
  return keys;
}

const MODIFIERS: Record<string, "mod" | "alt" | "shift"> = {
  "⌘": "mod", "⌃": "mod", cmd: "mod", command: "mod", ctrl: "mod", control: "mod", mod: "mod", meta: "mod",
  "⌥": "alt", alt: "alt", option: "alt", opt: "alt",
  "⇧": "shift", shift: "shift",
};

/** A query like "⌘⇧O", "ctrl+b" or "alt w": the modifiers it names and the key, if it names one. */
function parseCombo(query: string): { mods: Set<string>; key?: string } | undefined {
  const tokens = query.toLowerCase().replace(/([⌘⌃⌥⇧])/g, " $1 ").split(/[\s+]+/).filter(Boolean);
  const mods = new Set<string>();
  const rest: string[] = [];
  for (const t of tokens) {
    if (MODIFIERS[t]) mods.add(MODIFIERS[t]);
    else rest.push(t);
  }
  if (!mods.size || rest.length > 1) return undefined;
  return { mods, key: rest[0] };
}

function matchesCombo(combo: { mods: Set<string>; key?: string }, entry: Entry, binding: KeyBinding | null, mac: boolean): boolean {
  if (!binding) return false;
  for (const m of combo.mods) if (!binding[m as "mod" | "alt" | "shift"]) return false;
  if (!combo.key) return true;
  const last = bindingKeys(binding, mac).at(-1)!.toLowerCase();
  if (entry.last === "1–9") return /^[1-9]$/.test(combo.key);
  return last === combo.key || entry.last?.toLowerCase().includes(combo.key) === true;
}

/**
 * The groups and rows a search finds. A combination ("⌘B", "ctrl+b", "alt w") finds the rows bound
 * to it; anything else finds rows where each word starts a word of the label, group or extra words
 * ("term close", "pr"). Groups left empty are dropped.
 */
export function cheatsheetGroups(query: string, shortcuts: ShortcutMap | undefined, mac = isMacPlatform()): CheatsheetGroup[] {
  const combo = parseCombo(query);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found: CheatsheetGroup[] = [];
  for (const group of GROUPS) {
    const rows: CheatsheetRow[] = [];
    for (const entry of group.entries) {
      const binding = bindingOf(entry, shortcuts);
      const keys = rowKeys(entry, binding, mac);
      const vocabulary = `${group.title} ${entry.label} ${entry.also ?? ""}`.toLowerCase().split(/[^\p{L}\p{N}]+/u);
      const typed = keys.map((k) => k.toLowerCase());
      const hit = combo
        ? matchesCombo(combo, entry, binding, mac)
        : words.every((w) => vocabulary.some((v) => v.startsWith(w)) || typed.includes(w));
      if (hit) rows.push({ key: `${group.title}:${entry.label}`, label: entry.label, keys });
    }
    if (rows.length) found.push({ title: group.title, rows });
  }
  return found;
}
