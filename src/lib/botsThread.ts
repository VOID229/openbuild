// A thread opened from a link in OpenBots shows inside it (App.tsx). Its Back button, and Escape, return
// to the bot chat it was opened from. Both panes stay mounted (Activity), so drafts, scroll and any
// work the thread's agent is doing carry on untouched.
import { useEffect } from "react";
import { useStore } from "./store";

export const closeBotsThread = () => useStore.setState({ botsThread: false });

/** Whether this Escape is the embedded thread's to take, rather than something on top of it. */
export function escapeLeavesBotsThread(e: KeyboardEvent): boolean {
  if (e.key !== "Escape" || e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  // An IME uses Escape to cancel what's being composed (Safari reports that keydown as keyCode 229).
  if (e.isComposing || e.keyCode === 229) return false;
  const st = useStore.getState();
  if (!st.botsOpen || !st.botsThread || st.usageOpen || st.settingsOpen || st.marketplaceOpen) return false;
  // A dialog, image viewer or sheet takes Escape first, even one that missed it (focus left it).
  if (document.querySelector("dialog[open], [aria-modal='true']")) return false;
  const el = document.activeElement as HTMLElement | null;
  if (el?.closest("[role='menu'], [role='listbox'], [role='dialog'], dialog")) return false;
  // The composer's draft is kept, but any other field (a search, a rename, a terminal, an editor) keeps its own Escape.
  const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  return !typing || el.classList.contains("composer-input");
}

/**
 * Escape returns from the embedded thread like its Back button does. It listens on window without
 * capturing, so menus, dialogs and the image viewer (which capture it) and the composer's own uses
 * (closing a suggestion list, cancelling an edit, which prevent it) come first.
 */
export function useBotsThreadEscape(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!escapeLeavesBotsThread(e)) return;
      // Taken, so the bot chat's own Escape (closing its details) doesn't also fire on the way back.
      e.preventDefault();
      closeBotsThread();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}
