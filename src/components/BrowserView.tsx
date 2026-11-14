// A browser tab in the side panel: a page in a frame, with an address bar, back, forward and reload.
// Made for looking at what the thread is building (a dev server's localhost page), next to it.
//
// It's a frame, not a standalone browser. Pages keep their normal framing restrictions;
// use the toolbar's external-open button if a page won't embed. Localhost pages use an isolated
// preview proxy on the project's machine (server/preview.ts), which reaches the right machine
// however the app is open: on this computer, across the LAN or over Tailscale.
//
// A tab stays mounted while another panel tab is showing (SidePanel keeps it, hidden), so its page
// isn't reloaded each time you look at a file or a terminal.
import { ArrowLeft, ArrowRight, ExternalLink, Globe, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePanel, type BrowserTab } from "../lib/panel";
import { isLocalUrl } from "../lib/links";
import type { TerminalFolder } from "../lib/terminal";
import { cx } from "../lib/ui";
import { IconButton } from "./primitives";


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

/** Each tab's back/forward list, for this page's life (a cross-origin frame's own history is out of reach). */
const histories = new Map<string, { list: string[]; at: number }>();

/**
 * The preview address each localhost page last opened at, so a tab shown again (another thread,
 * a reload of the app) puts its page up at once while the server confirms it's still current.
 */
const entries = new Map<string, string>();

/** What the frame shows: the address it was asked for (`for`), and the page that opens it. */
type Frame = { for: string; src?: string; error?: string; reload: number };

export function BrowserView({ tab, folder, active = true }: { tab: BrowserTab; folder: TerminalFolder; active?: boolean }) {
  const navigate = usePanel((s) => s.navigateBrowser);
  const [address, setAddress] = useState(tab.url);
  const [reloads, setReloads] = useState(0);
  const [, redraw] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const history = histories.get(tab.id) ?? { list: tab.url ? [tab.url] : [], at: tab.url ? 0 : -1 };
  histories.set(tab.id, history);

  useEffect(() => setAddress(tab.url), [tab.url]);
  // A new, empty tab: straight to the address bar.
  useEffect(() => {
    if (active && !tab.url) input.current?.focus();
  }, [tab.id, active]);

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

  const local = isLocalUrl(tab.url);
  const key = `${folder.deviceId ?? ""}|${tab.url}`;
  const [frame, setFrame] = useState<Frame>();
  useEffect(() => {
    if (!tab.url) return setFrame(undefined);
    if (!local) return setFrame({ for: key, src: tab.url, reload: reloads });
    if (location.protocol === "https:") {
      return setFrame({ for: key, reload: reloads, error: "Localhost previews currently need HTTP access to OpenBuild. HTTPS requires a separate TLS preview route." });
    }
    // The address it opened at last time, straight away; the server's answer replaces it if it changed.
    const known = entries.get(key);
    if (known) setFrame({ for: key, src: known, reload: reloads });
    const controller = new AbortController();
    void fetch("/api/preview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: tab.url, deviceId: folder.deviceId }), signal: controller.signal,
    }).then(async (response) => {
      const result = await response.json().catch(() => ({}));
      if (!response.ok || typeof result.url !== "string") throw new Error(result.error || "Couldn't open the localhost preview");
      entries.set(key, result.url);
      setFrame((now) => (now?.for === key && now.src === result.url && now.reload === reloads ? now : { for: key, src: result.url, reload: reloads }));
    }).catch((error: Error) => {
      if (controller.signal.aborted) return;
      entries.delete(key);
      setFrame({ for: key, reload: reloads, error: error.message });
    });
    return () => controller.abort();
  }, [key, local, reloads]);

  // The page that's up stays until the next one has an address to load: going somewhere else, or
  // reloading, never blanks the panel in between.
  const current = frame?.for === key ? frame : undefined;
  const shown = tab.url && !current?.error ? (current?.src ? current : frame?.src ? frame : undefined) : undefined;
  const frameKey = shown && `${shown.src}#${shown.reload}`;
  // Until the frame's page has loaded: a quiet bar over it, and the panel's colour behind it, not white.
  const [loaded, setLoaded] = useState<string>();
  // Or the next page's preview is still being opened, behind the one that's up.
  const loading = (!!frameKey && loaded !== frameKey) || (!!tab.url && !current);

  // A preview that lost its cookie (its server restarted, or it was open too long) says so from
  // inside the frame: open it afresh, once in a while at most.
  const renewed = useRef(0);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== iframe.current?.contentWindow || e.data?.openbuildPreview !== "expired") return;
      if (Date.now() - renewed.current < 10_000) return;
      renewed.current = Date.now();
      entries.delete(key);
      setReloads((n) => n + 1);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [key]);

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
        <IconButton label="Open in a new browser tab" className="fv-tool" disabled={!shown?.src} onClick={() => window.open(shown!.src, "_blank", "noopener")}>
          <ExternalLink size={13} />
        </IconButton>
      </form>
      <div className="bv-body">
        {shown?.src ? (
          <>
            <iframe
              ref={iframe}
              key={frameKey}
              className={cx("bv-frame", loading && "bv-frame-loading")}
              src={shown.src}
              title={tab.url}
              onLoad={() => setLoaded(frameKey)}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox"
              allow="clipboard-read; clipboard-write; fullscreen"
            />
            {loading && <div className="bv-progress" role="progressbar" aria-label="Loading" />}
          </>
        ) : tab.url ? (
          <div className="bv-empty" role="status">
            <p>{current?.error || (local ? "Connecting to localhost…" : "Loading…")}</p>
            {current?.error && <button type="button" className="bv-retry" onClick={() => setReloads((n) => n + 1)}>Try again</button>}
            {!current?.error && <div className="bv-progress" />}
          </div>
        ) : (
          <div className="bv-empty">
            <Globe size={22} />
            <p>Enter a URL, a localhost port or a search</p>
            <p className="bv-hint">Pages that won't embed can open in a new browser tab</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Forget a closed tab's back/forward list. */
export const dropBrowserHistory = (id: string) => histories.delete(id);
