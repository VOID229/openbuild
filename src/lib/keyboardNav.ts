const NAV_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** Marks the document while the user is moving around by keyboard, which is what lets focus rings show. */
export function trackKeyboardNav(root: HTMLElement = document.documentElement) {
  window.addEventListener("keydown", (e) => {
    if (NAV_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) root.setAttribute("data-keyboard-nav", "");
  }, true);
  window.addEventListener("pointerdown", () => root.removeAttribute("data-keyboard-nav"), true);
}
