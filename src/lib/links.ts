// Links in a thread that point at localhost: a dev server the thread started, on the machine the
// thread runs on. A plain click opens them in the side panel's browser (reusing a tab already on
// that address), which reaches the right machine even when the app is open from another computer.
// ⌘-click (Ctrl-click off a Mac) opens a real browser tab instead; opened from elsewhere, its
// localhost becomes the server's host name, since this computer's own localhost has nothing there.
import type { MouseEvent } from "react";
import { usePanel } from "./panel";
import type { TerminalFolder } from "./terminal";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** An http(s) address on localhost. */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** Where a localhost address really is from this browser: on this server, when the app is open from elsewhere. */
export function reachableUrl(url: string, folder?: Pick<TerminalFolder, "deviceId">): string {
  if (folder?.deviceId || typeof location === "undefined" || LOCAL_HOSTS.has(location.hostname)) return url;
  try {
    const u = new URL(url);
    if (!LOCAL_HOSTS.has(u.hostname)) return url;
    u.hostname = location.hostname;
    return u.toString();
  } catch {
    return url;
  }
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Show a localhost page in the side panel: the tab already there, or a new one. */
export function openInPanel(url: string): void {
  const panel = usePanel.getState();
  const tab = panel.browsers.find((b) => b.url === url);
  if (tab) {
    panel.activateBrowser(tab.id);
    panel.setPanel(true);
  } else panel.openBrowser(url);
}

/** A link's click: localhost goes to the side panel, ⌘/Ctrl-click to a real tab; anything else is left alone. */
export function onLinkClick(e: MouseEvent<HTMLAnchorElement>, href: string | undefined): void {
  if (!href || e.button !== 0 || e.defaultPrevented || !isLocalUrl(href)) return;
  const folder = usePanel.getState().folder;
  e.preventDefault();
  if (isMac ? e.metaKey : e.ctrlKey) window.open(reachableUrl(href, folder), "_blank", "noopener");
  else openInPanel(href);
}

/** The address a link points to, as this browser can reach it (for hover, middle-click and copy). */
export const linkHref = (href: string | undefined): string | undefined => (href && isLocalUrl(href) ? reachableUrl(href, usePanel.getState().folder) : href);
