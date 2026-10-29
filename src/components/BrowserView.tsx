// A browser tab in the side panel: a page in a frame, with an address bar, back, forward and reload.
// Made for looking at what the thread is building (a dev server's localhost page), next to it.
//
// It's a frame, not a standalone browser. Pages keep their normal framing restrictions;
// use the toolbar's external-open button if a page won't embed. Localhost is mapped to
// this server's hostname when the app is opened from another computer.
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePanel, type BrowserTab } from "../lib/panel";
import type { TerminalFolder } from "../lib/terminal";
import { IconButton } from "./primitives";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** What was typed, as an address: a bare host gets http(s), a bare port is localhost, words are a search. */
export function normalizeUrl(input: string): string {
  const text = input.trim();
  if (!text) return "";
  if (/^\d{2,5}(\/.*)?$/.test(text)) return `http://localhost:${text}`;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(text) || /^(about|data):/i.test(text)) return text;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(text)) return `http://${text}`;
  if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(text)) return `http://${text}`;
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
  // Google's embeddable results (igu=1): most search engines refuse to be framed.
  return `https://www.google.com/search?igu=1&q=${encodeURIComponent(text)}`;
}

/** Where the frame actually goes: localhost on this server, when the app is open from elsewhere. */
function frameUrl(url: string, folder: TerminalFolder): string {
  if (folder.deviceId || typeof location === "undefined" || LOCAL_HOSTS.has(location.hostname)) return url;
  try {
    const u = new URL(url);
    if (!LOCAL_HOSTS.has(u.hostname)) return url;
    u.hostname = location.hostname;
    return u.toString();
  } catch {
    return url;
  }
}

/** Each tab's back/forward list, for this page's life (a cross-origin frame's own history is out of reach). */
const histories = new Map<string, { list: string[]; at: number }>();

export function BrowserView({ tab, folder }: { tab: BrowserTab; folder: TerminalFolder }) {
  const navigate = usePanel((s) => s.navigateBrowser);
  const [address, setAddress] = useState(tab.url);
  const [reloads, setReloads] = useState(0);
  const [, redraw] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const history = histories.get(tab.id) ?? { list: tab.url ? [tab.url] : [], at: tab.url ? 0 : -1 };
  histories.set(tab.id, history);

  useEffect(() => setAddress(tab.url), [tab.url]);
  // A new, empty tab: straight to the address bar.
  useEffect(() => {
    if (!tab.url) input.current?.focus();
  }, [tab.id]);

  const go = (url: string, record = true) => {
    if (record) {
      history.list = [...history.list.slice(0, history.at + 1), url];
      history.at = history.list.length - 1;
    }
    navigate(tab.id, url);
    setAddress(url);
    redraw((n) => n + 1);
  };
  const step = (delta: -1 | 1) => {
    const at = history.at + delta;
    if (at < 0 || at >= history.list.length) return;
    history.at = at;
    go(history.list[at]!, false);
  };
  const src = tab.url ? frameUrl(tab.url, folder) : "";

  return (
    <div className="browser-view">
      <form
        className="bv-bar"
        onSubmit={(e) => {
          e.preventDefault();
          const url = normalizeUrl(address);
          if (!url) return;
          if (url === tab.url) setReloads((n) => n + 1);
          else go(url);
          input.current?.blur();
        }}
      >
        <IconButton label="Back" className="fv-tool" disabled={history.at <= 0} onClick={() => step(-1)}>
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton label="Forward" className="fv-tool" disabled={history.at >= history.list.length - 1} onClick={() => step(1)}>
          <ArrowRight size={14} />
        </IconButton>
        <IconButton label="Reload" className="fv-tool" disabled={!tab.url} onClick={() => setReloads((n) => n + 1)}>
          <RotateCw size={13} />
        </IconButton>
        <input
          ref={input}
          className="bv-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setAddress(tab.url);
              e.currentTarget.blur();
            }
          }}
          placeholder="Address, localhost port, or search"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Address"
        />
        <IconButton label="Open in a new browser tab" className="fv-tool" disabled={!src} onClick={() => window.open(src, "_blank", "noopener")}>
          <ExternalLink size={13} />
        </IconButton>
      </form>
      <div className="bv-body">
        {src ? (
          <iframe
            key={`${src}#${reloads}`}
            className="bv-frame"
            src={src}
            title={tab.url}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox"
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        ) : (
          <div className="bv-empty">
            <Globe size={22} />
            <p>Type an address above: a URL, a port like 3000 for localhost, or words to search Google.</p>
            <p className="bv-hint">If a page won't embed, use Open in a new browser tab in the toolbar.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Forget a closed tab's back/forward list. */
export const dropBrowserHistory = (id: string) => histories.delete(id);
