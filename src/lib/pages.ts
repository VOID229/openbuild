// Settings, Usage and OpenBots' Marketplace are pages in the main pane, each with its own URL. Leaving one, or going up a
// level inside Settings, steps back through the browser's history when this app put the entries
// there (routes.ts), so Back, Esc and the browser's back button all land in the same place: wherever
// the page was opened from. Without that history (a deep link, or no routing), the store closes it.
import { routingBrowser, type PageHistory } from "./routes";
import { useStore } from "./store";

function pageHistory(prefix: string): { history: History; state: PageHistory } | undefined {
  const browser = routingBrowser();
  if (!browser) return;
  const path = browser.location.pathname;
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return;
  return { history: browser.history, state: (browser.history.state ?? {}) as PageHistory };
}

/** Leave Settings for wherever it was opened from: a thread, OpenBots, Usage. */
export function leaveSettings() {
  const at = pageHistory("/settings") ?? pageHistory("/bots/settings");
  if (at?.state.back) at.history.go(-at.state.back);
  else useStore.getState().closeSettings();
}

/** Leave Usage for wherever it was opened from. */
export function leaveUsage() {
  const at = pageHistory("/usage") ?? pageHistory("/bots/usage");
  if (at?.state.back) at.history.go(-at.state.back);
  else useStore.getState().setUsageOpen(false);
}

/** Leave the Marketplace for wherever it was opened from: the bot chat, a thread inside OpenBots. */
export function leaveMarketplace() {
  const at = pageHistory("/bots/marketplace");
  if (at?.state.back) at.history.go(-at.state.back);
  else useStore.setState({ marketplaceOpen: false, marketplaceApp: undefined });
}

/** From an app's page up to the Marketplace's catalog. */
export function marketplaceUp() {
  const at = pageHistory("/bots/marketplace");
  if (at?.state.up) return at.history.back();
  useStore.setState({ marketplaceApp: undefined });
}

/**
 * Back from an app's page: to the catalog when that's where it was opened from, otherwise (a bot's
 * Connect, a link) out to wherever that was.
 */
export function marketplaceBack() {
  const at = pageHistory("/bots/marketplace");
  if (at?.state.up) return at.history.back();
  // Without routing there's no telling where it came from: up to the catalog.
  if (!at) return useStore.setState({ marketplaceApp: undefined });
  leaveMarketplace();
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
