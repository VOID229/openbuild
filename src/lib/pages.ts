// Settings, Usage and OpenBots' Marketplace are pages in the main pane, each with its own URL, over
// whatever was showing when the first of them was opened: a thread, the new-thread screen, the bot
// chat. Leaving one, from anywhere inside it, goes back there: not to the page it was opened from
// (Usage from the Marketplace), and not up through its sections and pages. Esc and the back arrow in
// a page's header both leave. When this app put the entries since then in the browser's history
// (routes.ts), leaving goes back through them, so what shows is the entry it was and Forward still
// returns. Without that history (a deep link, or no routing), the store closes the pages.
// Going up a level (a page inside a Settings section, an app's page in the Marketplace) is a step back.
import { readRoute, routingBrowser, type PageHistory } from "./routes";
import { isShortcutRecording } from "./shortcuts";
import { useStore } from "./store";

function pageHistory(prefix: string): { history: History; state: PageHistory } | undefined {
  const browser = routingBrowser();
  if (!browser) return;
  const path = browser.location.pathname;
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return;
  return { history: browser.history, state: (browser.history.state ?? {}) as PageHistory };
}

/** Leave Settings, Usage or the Marketplace, from anywhere inside them, for whatever they were opened over. */
export function leavePage() {
  const browser = routingBrowser();
  const home = (browser?.history.state as PageHistory | null)?.home;
  if (browser && home) {
    const route = readRoute(browser.location.pathname);
    if (route.section || route.usage || route.marketplace) return browser.history.go(-home);
  }
  useStore.setState({ settingsOpen: false, settingsPage: undefined, usageOpen: false, marketplaceOpen: false, marketplaceApp: undefined });
}

// What opens over a page and closes with an Escape of its own: a dialog, a menu or picker, a lightbox.
const LAYERS = "dialog[open], .modal-root, .popover-portal, .context-menu, .lightbox";

// Shown, not just mounted: a hidden Activity (the sidebars, the chat under Settings) keeps its menus
// in the page, out of sight, until it shows again. The menu Settings was picked from is one.
const showing = (el: Element) => (typeof el.checkVisibility === "function" ? el.checkVisibility() : el.getClientRects().length > 0);

/**
 * Whether an Escape is the page's, to leave it with (Settings, Usage, the Marketplace). It isn't while
 * something is open over the page, or while what has focus uses Escape itself: a menu or list, a
 * combobox with its list open, a search with text in it (Escape clears it), a shortcut being recorded,
 * or a control that took it first (preventDefault, stopPropagation). Each of those closes first, and
 * the next Escape leaves.
 */
export function escapeLeavesPage(e: KeyboardEvent): boolean {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || isShortcutRecording()) return false;
  for (const layer of document.querySelectorAll(LAYERS)) if (showing(layer)) return false;
  const el = document.activeElement;
  if (!el || el === document.body) return true;
  if (el.closest("[role='menu'], [role='listbox'], [role='dialog'], [role='combobox'][aria-expanded='true']")) return false;
  return !(el instanceof HTMLInputElement && el.type === "search" && el.value);
}

/** From an app's page up to the Marketplace's catalog. */
export function marketplaceUp() {
  const at = pageHistory("/bots/marketplace");
  if (at?.state.up) return at.history.back();
  useStore.setState({ marketplaceApp: undefined });
}

/**
 * Back from an app's page, once it's done or from a phone's header: to the catalog when that's where
 * it was opened from, otherwise (a bot's Connect, a link) out of the Marketplace.
 */
export function marketplaceBack() {
  const at = pageHistory("/bots/marketplace");
  if (at?.state.up) return at.history.back();
  // Without routing there's no telling where it came from: up to the catalog.
  if (!at) return useStore.setState({ marketplaceApp: undefined });
  leavePage();
}

/** Open an app's page from the catalog: a level down, so Back returns to the catalog. */
export function openMarketplaceApp(app: string) {
  useStore.setState({ marketplaceApp: app });
}

/** Open a page inside the Settings section that's showing ("models", "bot/<id>"). */
export function openSettingsPage(page: string) {
  useStore.setState({ settingsPage: page, settingsIndex: false });
}

/** Open a section of Settings, from its list or the nav beside it. */
export function openSettingsSection(section: ReturnType<typeof useStore.getState>["settingsSection"]) {
  useStore.setState({ settingsSection: section, settingsPage: undefined, settingsIndex: false });
}

/** One level up inside Settings: from a page to its parent (`parent`, or the section), or from a section to the list of them. */
export function settingsUp(parent?: string) {
  const at = pageHistory("/settings") ?? pageHistory("/bots/settings");
  if (at?.state.up) return at.history.back();
  const { settingsPage } = useStore.getState();
  if (settingsPage) useStore.setState({ settingsPage: parent || undefined });
  else useStore.setState({ settingsIndex: true });
}
