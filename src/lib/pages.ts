// Settings and Usage are pages in the main pane, each with its own URL. Leaving one, or going up a
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
  const at = pageHistory("/settings");
  if (at?.state.back) at.history.go(-at.state.back);
  else useStore.getState().closeSettings();
}

/** Leave Usage for wherever it was opened from. */
export function leaveUsage() {
  const at = pageHistory("/usage") ?? pageHistory("/bots/usage");
  if (at?.state.back) at.history.go(-at.state.back);
  else useStore.getState().setUsageOpen(false);
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
  const at = pageHistory("/settings");
  if (at?.state.up) return at.history.back();
  const { settingsPage } = useStore.getState();
  if (settingsPage) useStore.setState({ settingsPage: parent || undefined });
  else useStore.setState({ settingsIndex: true });
}
