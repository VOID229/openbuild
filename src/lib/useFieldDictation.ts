import { useEffect, useRef } from "react";
import { dictationSupported, useDictation } from "./dictation";
import { SHORTCUT_EVENT, type ShortcutEventDetail } from "./shortcuts";
import { useStore } from "./store";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const isIOS = typeof navigator !== "undefined" && (/iPhone|iPad/.test(navigator.platform) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Fields that can take dictation carry this attribute, so the shortcut can find the focused one. */
export const DICTATION_ATTR = "data-dictation";

type Field = HTMLInputElement | HTMLTextAreaElement;

/**
 * Dictation into any text field: the composer, a question card's answer, the commit message. The
 * transcript goes after whatever was in the field when dictation started (browser speech streams
 * interim text; private Whisper answers once, after anything typed while it transcribed).
 *
 * The Toggle dictation shortcut goes to the field that has focus, or to one already listening;
 * `fallback` fields (the composer) take it when no other dictation field has focus.
 */
export function useFieldDictation({
  value,
  setValue,
  field,
  onError,
  fallback = false,
}: {
  value: string;
  setValue: (update: (current: string) => string) => void;
  field: React.RefObject<Field | null>;
  onError: (message: string) => void;
  fallback?: boolean;
}) {
  const base = useRef("");
  const settings = useStore((s) => s.settings.dictation);
  const local = !!settings?.enabled;
  const dictation = useDictation(
    (transcript) => {
      const heard = transcript.trim();
      const join = (before: string) => (before && heard && !/\s$/.test(before) ? `${before} ${heard}` : before + heard);
      if (local) {
        if (heard) setValue(join);
      } else {
        setValue(() => join(base.current));
      }
    },
    onError,
    settings,
  );

  const toggle = () => {
    if (dictation.listening) return dictation.stop();
    if (dictation.busy) return;
    field.current?.focus();
    if (!local && !dictationSupported) {
      // No speech API in this browser: hand off to the OS's own dictation on the focused box.
      onError(isIOS ? "Tap the mic on the keyboard to dictate." : isMac ? "Press Fn twice (or 🎤) to dictate." : "Dictation isn't supported in this browser.");
      return;
    }
    base.current = value;
    dictation.start();
  };

  // Settings → Shortcuts toggles dictation from anywhere; each field decides whether it's the target.
  const state = useRef({ toggle, dictation, fallback });
  state.current = { toggle, dictation, fallback };
  useEffect(() => {
    const onShortcut = (e: Event) => {
      if ((e as CustomEvent<ShortcutEventDetail>).detail?.action !== "toggleDictation") return;
      const { toggle, dictation, fallback } = state.current;
      const el = field.current;
      if (!el) return;
      // A field that's already listening or transcribing owns the shortcut until it's done.
      if (dictation.listening || dictation.busy) return toggle();
      if (document.querySelector(`[${DICTATION_ATTR}="active"]`)) return;
      const active = document.activeElement;
      const focused = active instanceof HTMLElement && active.hasAttribute(DICTATION_ATTR) ? active : null;
      if (focused === el || (fallback && !focused)) toggle();
    };
    window.addEventListener(SHORTCUT_EVENT, onShortcut);
    return () => window.removeEventListener(SHORTCUT_EVENT, onShortcut);
  }, []);

  /** Spread on the field so the shortcut can find it. */
  const fieldProps = { [DICTATION_ATTR]: dictation.listening || dictation.busy ? "active" : "idle" } as Record<string, string>;
  return { ...dictation, toggle, local, fieldProps };
}
