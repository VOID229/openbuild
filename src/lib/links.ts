// Links in a thread that point at localhost: a dev server the thread started, on the machine the
// thread runs on. A plain click opens them in the side panel's browser (reusing a tab already on
// that address), which reaches the right machine even when the app is open from another computer.
// ⌘-click (Ctrl-click off a Mac) opens a real browser tab through the same preview proxy.
//
// Links to a pull request in the open thread's repository open it in the side panel's pull requests
// tab; ⌘/Ctrl-click opens it on GitHub. Pull requests of other repositories always go to GitHub.
import type { MouseEvent } from "react";
import { folderKey, usePanel } from "./panel";
import { knownPullRepo, pullRepo } from "./pulls";
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

/** Open a loopback page through the project's authenticated preview proxy. */
export function reachableUrl(url: string, folder?: Pick<TerminalFolder, "deviceId">): string {
  if (!isLocalUrl(url)) return url;
  const params = new URLSearchParams({ url });
  if (folder?.deviceId) params.set("deviceId", folder.deviceId);
  return `/api/preview/open?${params}`;
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

/** A pull request's page (`https://github.com/o/r/pull/12`, or any of its tabs): its repository, as `host/o/r` in lower case, and number. */
export function parsePullUrl(url: string): { repo: string; number: number } | undefined {
  try {
    const u = new URL(url);
    const m = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(u.pathname);
    if (!/^https?:$/.test(u.protocol) || !m) return;
    return { repo: repoId(`${u.host}/${m[1]}/${m[2]}`), number: Number(m[3]) };
  } catch {
    return;
  }
}

/** `https://github.com/O/R` (or `github.com/O/R.git`) → `github.com/o/r`. */
const repoId = (url: string) =>
  url
    .replace(/^https?:\/\//, "")
    .replace(/(\.git)?\/*$/, "")
    .toLowerCase();

/** A link's click: localhost goes to the side panel, ⌘/Ctrl-click to a real tab; anything else is left alone. */
export function onLinkClick(e: MouseEvent<HTMLAnchorElement>, href: string | undefined): void {
  if (!href || e.button !== 0 || e.defaultPrevented) return;
  const newTab = isMac ? e.metaKey : e.ctrlKey;
  const folder = usePanel.getState().folder;
  if (!isLocalUrl(href)) {
    const pull = parsePullUrl(href);
    if (!pull || newTab || e.shiftKey || !folder?.cwd) return;
    const known = knownPullRepo(folder);
    if (known !== null) {
      if (known && repoId(known) === pull.repo) {
        e.preventDefault();
        usePanel.getState().openPulls(pull.number);
      }
      return;
    }
    // Not known yet (it's asked for as soon as the link shows, so this is rare): wait for it.
    e.preventDefault();
    const asked = folderKey(folder);
    void pullRepo(folder).then((repo) => {
      const now = usePanel.getState().folder;
      if (repo && repoId(repo) === pull.repo && now && folderKey(now) === asked) usePanel.getState().openPulls(pull.number);
      else window.open(href, "_blank", "noopener,noreferrer");
    });
    return;
  }
  e.preventDefault();
  if (newTab) window.open(reachableUrl(href, folder), "_blank", "noopener");
  else openInPanel(href);
}

/** The address a link points to, as this browser can reach it (for hover, middle-click and copy). */
export function linkHref(href: string | undefined): string | undefined {
  if (!href) return href;
  const folder = usePanel.getState().folder;
  if (isLocalUrl(href)) return reachableUrl(href, folder);
  // A pull request link: learn the folder's repository now, so a click knows where it goes at once.
  if (folder?.cwd && typeof window !== "undefined" && parsePullUrl(href)) void pullRepo(folder);
  return href;
}
