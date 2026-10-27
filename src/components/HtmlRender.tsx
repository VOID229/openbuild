// A page the agent showed in the thread with html_render (a chart, diagram, mockup or small tool):
// drawn from the call's own arguments in a sandboxed frame that fits the page's height and follows
// the app's theme, with a full-screen view and a download. See shared/htmlRender.ts.
import { Download, Maximize2, PanelTop, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  HTML_RENDER_DEFAULT_HEIGHT,
  clampHeight,
  htmlFileName,
  htmlTheme,
  readHeightMessage,
  themeMessage,
  withBootstrap,
  type HtmlTheme,
} from "../../shared/htmlRender";
import type { ToolPart } from "../lib/types";
import { cx, usePresence } from "../lib/ui";
import { IconButton } from "./primitives";

// Never allow-same-origin: the page's opaque origin keeps it out of the app and its session.
// Popups escape the sandbox so a link the page opens works as an ordinary tab.
const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";

/** The app's theme as a page sees it, kept up to date with the theme setting and plugins' styles. */
let current: HtmlTheme | undefined;
let currentKey = "";
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;
const notify = () => {
  const before = current;
  if (readTheme() !== before) for (const l of listeners) l();
};

/** A font stack's first family, unquoted. */
const firstFamily = (stack: string) => stack.split(",")[0]?.trim().replace(/^["']|["']$/g, "") ?? "";

const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/**
 * The app's own fonts can't load in a page with no origin (and are served behind its password),
 * so the page gets their Latin faces inline: as they are when the bundle already inlined them,
 * fetched once otherwise. Until then, and if that fails, the page falls back along the font stack.
 */
const fontFaces = new Map<string, string | Promise<string>>();
function fontsFor(families: string[]): string | undefined {
  const key = families.join("|");
  const known = fontFaces.get(key);
  if (typeof known === "string") return known;
  if (known) return undefined;
  const faces: (string | Promise<string>)[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(list)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const style = rule.style;
      const family = firstFamily(style.getPropertyValue("font-family"));
      const range = style.getPropertyValue("unicode-range");
      if (!families.includes(family) || (range && !/U\+0(000)?-0?0?FF\b/i.test(range))) continue;
      const src = style.getPropertyValue("src");
      if (/^\s*url\(\s*["']?data:/.test(src)) {
        faces.push(rule.cssText);
        continue;
      }
      const url = /url\(\s*["']?([^"')]+\.woff2[^"')]*)["']?\s*\)/.exec(src)?.[1];
      if (!url) continue;
      const descriptors = ["font-style", "font-weight", "font-stretch", "unicode-range"].map((d) => (style.getPropertyValue(d) ? `${d}:${style.getPropertyValue(d)};` : "")).join("");
      faces.push(
        fetch(new URL(url, sheet.href ?? location.href))
          .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(res.statusText))))
          .then(dataUrl)
          .then((data) => `@font-face{font-family:"${family}";font-display:swap;${descriptors}src:url(${data}) format("woff2")}`)
          .catch(() => ""),
      );
    }
  }
  if (faces.every((f) => typeof f === "string")) {
    fontFaces.set(key, faces.join(""));
    return faces.join("");
  }
  const loading = Promise.all(faces).then((all) => all.join(""));
  fontFaces.set(key, loading);
  void loading.then((css) => {
    fontFaces.set(key, css);
    notify();
  });
  return undefined;
}

function readTheme() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const read = (token: string) => style.getPropertyValue(token);
  const theme: HtmlTheme = htmlTheme(root.dataset.theme === "dark" ? "dark" : "light", read);
  const fonts = fontsFor([...new Set([firstFamily(read("--font")), firstFamily(read("--mono"))].filter(Boolean))]);
  if (fonts) theme.fonts = fonts;
  const key = JSON.stringify(theme);
  if (key !== currentKey) {
    current = theme;
    currentKey = key;
  }
  return current!;
}

function subscribe(listener: () => void) {
  readTheme();
  listeners.add(listener);
  if (!observer) {
    let queued = false;
    // Plugin themes swap stylesheets and tokens; the theme setting flips data-theme.
    observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        notify();
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-font", "style", "class"] });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      observer?.disconnect();
      observer = undefined;
    }
  };
}

const useHtmlTheme = () => useSyncExternalStore(subscribe, () => current ?? readTheme());

/**
 * The page in a frame. Its document is built once, with the theme of the moment: a later theme
 * is posted to the page instead, so it never reloads (and loses what the reader did in it).
 */
function PageFrame({ html, title, onHeight, className }: { html: string; title: string; onHeight?: (h: number) => void; className?: string }) {
  const theme = useHtmlTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [srcDoc] = useState(() => withBootstrap(html, theme));
  const [loaded, setLoaded] = useState(false);
  const post = () => frame.current?.contentWindow?.postMessage(themeMessage(theme), "*");
  useEffect(post, [theme]);
  const heightRef = useRef(onHeight);
  heightRef.current = onHeight;
  // From commit: a quick page can report its height before effects run.
  useLayoutEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const h = readHeightMessage(e.data);
      if (h !== undefined) heightRef.current?.(h);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <iframe
      ref={frame}
      srcDoc={srcDoc}
      title={title}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      className={cx("html-render-frame", className)}
      // The page is see-through on the thread only when its color scheme matches the frame's.
      style={{ colorScheme: theme.appearance, visibility: loaded ? undefined : "hidden" }}
      onLoad={() => {
        setLoaded(true);
        post();
      }}
    />
  );
}

function download(html: string, title: string, theme: HtmlTheme) {
  const url = URL.createObjectURL(new Blob([withBootstrap(html, theme, { opaque: true })], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = htmlFileName(title);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function FullScreen({ html, title, open, onClose }: { html: string; title: string; open: boolean; onClose: () => void }) {
  const { mounted, visible } = usePresence(open, 200);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  if (!mounted) return null;
  return createPortal(
    <div className="html-render-full" data-state={visible ? "open" : "closed"} role="dialog" aria-modal="true" aria-label={title}>
      <div className="html-render-full-backdrop" onClick={onClose} />
      <div className="html-render-full-panel">
        <div className="html-render-full-bar">
          <PanelTop size={14} />
          <span className="html-render-full-title">{title}</span>
          <IconButton label="Close" tooltipSide="left" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <PageFrame html={html} title={title} className="html-render-full-frame" />
      </div>
    </div>,
    document.body,
  );
}

const kb = (chars: number) => (chars < 1000 ? `${chars} characters` : `${(chars / 1000).toFixed(chars < 10_000 ? 1 : 0)} KB`);

/** An html_render call in the reply: the page, or while the agent is still writing it, that it's coming. */
export const HtmlRender = memo(function HtmlRender({ part, block }: { part: ToolPart; block?: number }) {
  const args = part.args ?? {};
  const html = typeof args.html === "string" ? args.html : undefined;
  const title = (typeof args.title === "string" && args.title.trim()) || "Page";
  const hint = typeof args.height === "number" && Number.isFinite(args.height) ? args.height : undefined;
  const [measured, setMeasured] = useState<number>();
  const [full, setFull] = useState(false);
  const theme = useHtmlTheme();
  if (html === undefined) {
    const written = typeof args.written === "number" ? args.written : 0;
    return (
      <div className="html-render html-render-pending" data-block={block}>
        <PanelTop size={14} />
        <span className="shimmer">
          {part.status === "running" ? "Drawing" : "Couldn't show"} {title}
        </span>
        {part.status === "running" && written > 0 && <span className="html-render-size">{kb(written)}</span>}
      </div>
    );
  }
  const height = clampHeight(measured ?? hint ?? HTML_RENDER_DEFAULT_HEIGHT);
  // The actions sit above the page, not over it: a frame takes the pointer, so a hover toolbar on
  // top of it would never show, and would cover the page's own controls when it did.
  return (
    <figure className="html-render" data-block={block}>
      <figcaption className="html-render-bar">
        <PanelTop size={13} />
        <span className="html-render-title">{title}</span>
        <IconButton label="Download HTML" tooltipSide="top" className="html-render-action" onClick={() => download(html, title, theme)}>
          <Download size={14} />
        </IconButton>
        <IconButton label="Full screen" tooltipSide="top" className="html-render-action" onClick={() => setFull(true)}>
          <Maximize2 size={14} />
        </IconButton>
      </figcaption>
      <div className="html-render-page" style={{ height }}>
        <PageFrame html={html} title={title} onHeight={setMeasured} />
      </div>
      <FullScreen html={html} title={title} open={full} onClose={() => setFull(false)} />
    </figure>
  );
});
