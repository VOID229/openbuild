// Which app-wide shortcut a keydown runs, if any. App takes the key (so the browser never sees it,
// e.g. Safari's Save As on ⌘⇧S) and runs the action; the composers act on the stash and dictation ones.
import { SHORTCUTS, SHORTCUT_EVENT, eventMatchesBinding, isShortcutRecording, shortcutBinding, type ShortcutEventDetail, type ShortcutId } from "./shortcuts";
import type { Settings } from "./types";

/** Whether a field that takes typing has focus. */
export function isTyping(el: Element | null): boolean {
  return !!el && ((el as HTMLElement).isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** The shortcut `e` runs, with `el` focused, or undefined to leave the key to whatever has it. */
export function matchShortcut(e: KeyboardEvent, settings: Pick<Settings, "shortcuts">, el = document.activeElement): ShortcutId | undefined {
  if (e.isComposing || e.repeat || isShortcutRecording()) return;
  const typing = isTyping(el);
  for (const def of SHORTCUTS) {
    const binding = shortcutBinding(settings, def.id);
    if (!binding || !eventMatchesBinding(e, binding)) continue;
    if (def.typingSensitive && typing) continue;
    // Without a field that takes dictation there's nothing to dictate into.
    if (def.id === "toggleDictation" && ![...document.querySelectorAll("[data-dictation]")].some((f) => f.checkVisibility())) continue;
    // A file editor keeps its own save, and a terminal its own Ctrl+S.
    if (def.id === "stashDraft" && el?.closest(".cm-editor, .xterm")) continue;
    // A terminal keeps its Ctrl+Shift+S too.
    if (def.id === "useLastStash" && el?.closest(".xterm")) continue;
    return def.id;
  }
}

/** Hand a shortcut to the composer (stash) or the field (dictation) that acts on it. */
export function dispatchShortcut(action: ShortcutId) {
  window.dispatchEvent(new CustomEvent<ShortcutEventDetail>(SHORTCUT_EVENT, { detail: { action } }));
}

/** Run the shortcut `e` stands for, if any, taking the key from the page and the browser. Returns whether it did. */
export function takeShortcut(e: KeyboardEvent, settings: Pick<Settings, "shortcuts">, run: (id: ShortcutId) => void, el = document.activeElement): boolean {
  const id = matchShortcut(e, settings, el);
  if (!id) return false;
  e.preventDefault();
  e.stopPropagation();
  run(id);
  return true;
}
