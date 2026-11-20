// Option+1–9 (Alt+1–9) goes to a bot, group or chat in the OpenBots sidebar, by its place in it: the
// pinned tiles first, left to right and row by row, then down the list. Settings can leave the pinned
// ones out (Settings → Shortcuts), so the numbers cover only the list. Holding Option a moment shows
// each one's number on it; a quick press goes straight there without the numbers flashing up.
//
// The sidebar marks what can be numbered with `data-bot-slot` (and pinned ones with `data-pinned`),
// and the numbers follow the page's own order, so however the sidebar arranges its chats the keys
// match what's on the screen. Pressing one clicks that item, so it does exactly what a click does.
import { useEffect } from "react";
import { create } from "zustand";
import { formatBinding, isShortcutRecording, type ShortcutEvent } from "../../lib/shortcuts";
import { isTyping } from "../../lib/shortcutKeys";
import { useStore } from "../../lib/store";

/** How long Option is held before the numbers show, so a quick ⌥2 doesn't flash them. */
export const HINT_DELAY_MS = 500;

const NONE: Record<string, number> = {};

/** The number on each conversation while Option is held, by conversation id; empty otherwise. */
export const useSwitchKeys = create<{ slots: Record<string, number> }>(() => ({ slots: NONE }));
const hideHints = () => {
  if (useSwitchKeys.getState().slots !== NONE) useSwitchKeys.setState({ slots: NONE });
};

/** The sidebar items the keys go to, in order: at most nine, only ones that can be clicked now. */
export function switchTargets(root: ParentNode, includePinned: boolean): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>("[data-bot-slot]")];
  return all
    .filter((el) => (includePinned || !el.hasAttribute("data-pinned")) && !el.closest("[inert]") && el.checkVisibility())
    .slice(0, 9);
}

/** The digit an Option/Alt+1–9 keydown stands for (from its code: a Mac's Option makes "¡", "™"…), or undefined. */
export function switchDigit(e: ShortcutEvent & { getModifierState?: (key: string) => boolean }): number | undefined {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || e.getModifierState?.("AltGraph")) return;
  const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
  return digit ? Number(digit) : undefined;
}

/**
 * Whether ⌥digit can be taken from a field being typed in. Elsewhere Alt+digit types nothing, and a
 * US Mac makes symbols nobody types that way ("¡", "™", "∞"…), but other layouts type with it: a
 * German Mac's ⌥5–9 are "[", "]", "|", "{", "}", a British one's ⌥3 is "#", and currencies ("£",
 * "€", "¢") are typed this way too. Those, and a dead key starting an accent, stay the field's.
 */
export function safeWhileTyping(key: string, digit: number): boolean {
  if (key === String(digit) || key === "Unidentified" || key === "") return true;
  if (key === "Dead" || key.length !== 1) return false;
  return !/[\x20-\x7e]/.test(key) && !/\p{Sc}/u.test(key);
}

const includePinned = () => useStore.getState().settings.botKeysIncludePinned ?? true;

const sidebar = () => document.querySelector<HTMLElement>(".bots-sidebar");

function showHints() {
  const root = sidebar();
  if (!root) return hideHints();
  const slots: Record<string, number> = {};
  switchTargets(root, includePinned()).forEach((el, i) => {
    slots[el.dataset.botSlot!] = i + 1;
  });
  const now = useSwitchKeys.getState().slots;
  const same = Object.keys(slots).length === Object.keys(now).length && Object.entries(slots).every(([id, n]) => now[id] === n);
  if (!same) useSwitchKeys.setState({ slots });
}

/**
 * Listens for ⌥1–9 while the OpenBots sidebar is showing (BotsSidebar calls it). The digits are
 * heard as the key bubbles back up to the window, so anything that already took the key — a shortcut
 * set to the same keys in Settings, the side panel's or a terminal's own ⌥1–9 — keeps it.
 */
export function useBotSwitchKeys() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let held = false;
    let watch: MutationObserver | undefined;
    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const release = () => {
      held = false;
      cancel();
      watch?.disconnect();
      watch = undefined;
      hideHints();
    };
    const reveal = () => {
      timer = undefined;
      if (!held || isShortcutRecording()) return;
      showHints();
      // The list can change while they're up (a new message moves a chat): keep the numbers on what's there.
      const root = sidebar();
      if (root && !watch) {
        let frame = 0;
        watch = new MutationObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => held && watch && showHints());
        });
        watch.observe(root, { childList: true, subtree: true });
      }
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
        if (e.repeat) return;
        // Option on its own: the numbers show if it's still held in a moment.
        if (e.metaKey || e.ctrlKey || e.shiftKey) return release();
        held = true;
        cancel();
        timer = setTimeout(reveal, HINT_DELAY_MS);
        return;
      }
      const digit = switchDigit(e);
      // Any other key with it is some other shortcut, or typing: the numbers have no business showing.
      if (!digit) return release();
      // Pressed before the numbers showed, it goes straight there and they never do.
      cancel();
      if (e.defaultPrevented || e.isComposing || e.repeat || isShortcutRecording()) return;
      const el = document.activeElement;
      if (el?.closest(".xterm")) return;
      if (isTyping(el) && !safeWhileTyping(e.key, digit)) return release();
      if (document.querySelector(":modal")) return;
      const root = sidebar();
      const target = root && switchTargets(root, includePinned())[digit - 1];
      if (!target) return;
      e.preventDefault();
      target.click();
      if (useSwitchKeys.getState().slots !== NONE) requestAnimationFrame(() => held && showHints());
    };
    const onUp = (e: KeyboardEvent) => {
      if (!e.altKey || e.key === "Alt") release();
    };
    const onHidden = () => document.visibilityState === "hidden" && release();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp, true);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      release();
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);
}

/** The ⌥N on a sidebar item while Option is held. */
export function SwitchKeyBadge({ id }: { id: string }) {
  const n = useSwitchKeys((s) => s.slots[id]);
  if (!n) return null;
  return (
    <kbd className="bots-switch-key" aria-hidden>
      {formatBinding({ mod: false, alt: true, shift: false, code: `Digit${n}` })}
    </kbd>
  );
}
