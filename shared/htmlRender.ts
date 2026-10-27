// HTML pages an agent shows in the thread (html_render): a chart, diagram, mockup or small
// interactive tool, drawn in a sandboxed frame among the reply. Shared by the Pi extension that
// gives the agent its tools (server/pi/extensions/html-render.ts, which also screenshots pages
// with html_preview) and the app, which draws them (src/components/HtmlRender.tsx).
//
// The page runs with an opaque origin (`sandbox="allow-scripts"`, never allow-same-origin), so
// it can't reach the app, its session or its storage. A small bootstrap, put in front of the
// page, sets the app's theme as CSS variables and tells the app how tall the page is, so the
// frame fits it without scrolling of its own.
//
// No imports: Pi loads the extension (and with it this file) on its own.

export const HTML_RENDER_TOOL = "html_render";
export const HTML_PREVIEW_TOOL = "html_preview";

export const HTML_RENDER_MIN_HEIGHT = 60;
/** Taller pages scroll inside their frame. */
export const HTML_RENDER_MAX_HEIGHT = 4000;
/** Until the page says how tall it is (the agent's guess, or this). */
export const HTML_RENDER_DEFAULT_HEIGHT = 240;
export const HTML_RENDER_MAX_BYTES = 512_000;
export const HTML_RENDER_MAX_TITLE = 120;
/** The reply column the page is drawn in. */
export const HTML_RENDER_WIDTH = 768;

export type Appearance = "light" | "dark";
export interface HtmlTheme {
  appearance: Appearance;
  variables: Record<string, string>;
  /** @font-face rules for the app's own fonts, which the page can't load from the app itself. */
  fonts?: string;
}

/** Colours the app doesn't have tokens for: status colours and a chart palette. */
const FIXED: Record<Appearance, Record<string, string>> = {
  light: {
    "--accent": "#2563eb",
    "--accent-foreground": "#ffffff",
    "--warning": "#b45309",
    "--info": "#2563eb",
    "--chart-1": "#2563eb",
    "--chart-2": "#0d9488",
    "--chart-3": "#d97706",
    "--chart-4": "#9333ea",
    "--chart-5": "#e11d48",
    "--chart-6": "#65a30d",
  },
  dark: {
    "--accent": "#60a5fa",
    "--accent-foreground": "#0b1220",
    "--warning": "#fbbf24",
    "--info": "#60a5fa",
    "--chart-1": "#60a5fa",
    "--chart-2": "#2dd4bf",
    "--chart-3": "#fbbf24",
    "--chart-4": "#c084fc",
    "--chart-5": "#fb7185",
    "--chart-6": "#a3e635",
  },
};

/** The page's variable for each of the app's tokens (src/styles.css). */
export const THEME_TOKENS: Record<string, string> = {
  "--background": "--bg",
  "--foreground": "--text",
  "--card": "--surface",
  "--card-foreground": "--text",
  "--muted": "--surface-2",
  "--muted-foreground": "--text-2",
  "--secondary": "--surface-3",
  "--secondary-foreground": "--text",
  "--border": "--border-strong",
  "--ring": "--focus",
  "--primary": "--ink",
  "--primary-foreground": "--ink-fg",
  "--destructive": "--danger",
  "--success": "--ok",
  "--code-background": "--code-bg",
  "--code-foreground": "--text",
  "--font-sans": "--font",
  "--font-mono": "--mono",
};

/** The app's stock palettes, for screenshots (the app passes its live values instead). */
const STOCK: Record<Appearance, Record<string, string>> = {
  light: {
    "--bg": "#f3f3f2", "--surface": "#ffffff", "--surface-2": "#f7f7f6", "--surface-3": "#efefed", "--text": "#1e1e1e", "--text-2": "#5c5c58",
    "--border-strong": "rgba(0, 0, 0, 0.14)", "--focus": "rgba(30, 30, 30, 0.22)", "--ink": "#1e1e1e", "--ink-fg": "#ffffff", "--danger": "#c93a3a",
    "--ok": "#2f8a4d", "--code-bg": "#f6f6f4",
  },
  dark: {
    "--bg": "#121212", "--surface": "#1a1a1a", "--surface-2": "#212121", "--surface-3": "#2a2a2a", "--text": "#ececea", "--text-2": "#a6a6a1",
    "--border-strong": "rgba(255, 255, 255, 0.15)", "--focus": "rgba(236, 236, 234, 0.28)", "--ink": "#ececea", "--ink-fg": "#161616", "--danger": "#ef6b6b",
    "--ok": "#5cc27e", "--code-bg": "#151515",
  },
};
const FONTS = {
  "--font": '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  "--mono": 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
};

/** The page's theme from the app's token values (`read` returns "" for one that isn't set). */
export function htmlTheme(appearance: Appearance, read?: (token: string) => string): HtmlTheme {
  const stock: Record<string, string> = { ...STOCK[appearance], ...FONTS };
  const variables: Record<string, string> = {};
  for (const [name, token] of Object.entries(THEME_TOKENS)) variables[name] = read?.(token).trim() || stock[token]!;
  return { appearance, variables: { ...variables, ...FIXED[appearance], "--radius": "10px" } };
}

export const HTML_THEME_GUIDE = [
  "Style with the theme's CSS variables on :root, not fixed colours, so the page follows the app's light or dark theme:",
  "--background, --foreground, --card, --muted, --muted-foreground, --secondary, --border, --ring, --primary, --accent, --destructive, --success, --warning, --info, --code-background",
  "(card, secondary, primary, accent and code also have a -foreground), --chart-1 to --chart-6 for series, --radius, --font-sans, --font-mono.",
  "The base sheet already sets the text colour and font.",
].join(" ");

export const HTML_LAYOUT_GUIDE = [
  `The frame is the width of the reply (${HTML_RENDER_WIDTH}px on a desktop, about 360px on a phone) and sits right on the thread's background:`,
  "leave html and body without a background, outer card, border, heading banner or side padding.",
  "A box that needs a background of its own gets padding and var(--radius) corners. Give charts fixed pixel heights.",
  "The frame grows to fit the page: let content set the height. Never use vh units, or height: 100% on html or body.",
].join(" ");

const MSG_HEIGHT = "openbuild:html-height";
const MSG_THEME = "openbuild:html-theme";

/** How tall the page says it is, from a message its frame posted. */
export function readHeightMessage(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null || (data as { type?: unknown }).type !== MSG_HEIGHT) return undefined;
  const h = (data as { height?: unknown }).height;
  return typeof h === "number" && Number.isFinite(h) && h > 0 ? h : undefined;
}

export const themeMessage = (theme: HtmlTheme) => ({ type: MSG_THEME, theme });

export const clampHeight = (h: number) => Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(h)));

/** Values can't close the rule or the style element. */
const safeValue = (v: string) => String(v).replace(/[;{}<>]/g, "");

function rootRule(theme: HtmlTheme) {
  const vars = Object.entries(theme.variables)
    .filter(([k]) => /^--[a-z0-9-]+$/.test(k))
    .map(([k, v]) => `${k}:${safeValue(v)};`)
    .join("");
  return `${(theme.fonts ?? "").replace(/</g, "")}:root{color-scheme:${theme.appearance === "light" ? "light" : "dark"};${vars}}`;
}

const baseCss = (opaque: boolean) =>
  `html{background:${opaque ? "var(--background)" : "transparent"};color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;` +
  "-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}html::-webkit-scrollbar{display:none}" +
  "body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}";

// In the page: take theme updates from the app, report the page's height as it changes, and open
// web links in a new tab (the frame itself must never navigate away from the page).
const script = (base: string) =>
  `(function(){var s=document.getElementById("openbuild-theme"),h=0,P=window.parent;if(P===window)P=null;` +
  `window.addEventListener("message",function(e){var d=e.data,t=d&&d.theme;if(e.source!==P||!d||d.type!==${JSON.stringify(MSG_THEME)}||!t||typeof t.variables!=="object")return;` +
  `var c=(typeof t.fonts==="string"?t.fonts.replace(/</g,""):"")+":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables)if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";s.textContent=c+"}"+${JSON.stringify(base)};});` +
  `document.addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]"),u;if(!a)return;try{u=new URL(a.getAttribute("href"),document.baseURI)}catch(x){return}` +
  `if(/^https?:$/.test(u.protocol)){a.setAttribute("target","_blank");a.setAttribute("rel","noopener noreferrer")}},true);` +
  `if(!P)return;var z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);` +
  `if(v===h)return;h=v;P.postMessage({type:${JSON.stringify(MSG_HEIGHT)},height:v},"*")};` +
  `var o=window.ResizeObserver?new ResizeObserver(z):null;if(o)o.observe(document.documentElement);` +
  `document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z()});window.addEventListener("load",z);setTimeout(z,0);})();`;

/** What goes in front of the page: charset, viewport, the theme and the script above. */
export function htmlBootstrap(theme: HtmlTheme, opts: { opaque?: boolean } = {}) {
  const base = baseCss(!!opts.opaque);
  return (
    '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style id="openbuild-theme">${rootRule(theme)}${base}</style><script>${script(base)}</script>`
  );
}

/** A doctype, after any leading comments, which has to stay first or the page renders in quirks mode. */
const DOCTYPE = /^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i;

/**
 * The page with the bootstrap in front of it. Put right after the doctype, its tags start the
 * head before the page's own: the parser merges a later <html> into the one it started and skips
 * a second <head>, so the page's styles still come after the theme's and override it.
 */
export function withBootstrap(html: string, theme: HtmlTheme, opts: { opaque?: boolean } = {}) {
  const boot = htmlBootstrap(theme, opts);
  const doctype = DOCTYPE.exec(html)?.[0];
  return doctype ? doctype + boot + html.slice(doctype.length) : `<!doctype html>${boot}${html}`;
}

// Stylesheets and style attributes only (a script may mention "100vh" in a string); comments skipped.
const CSS_SOURCE = /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi;
// The lookbehind skips base64 runs, such as an inlined image that happens to contain "1vh".
const VIEWPORT_HEIGHT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i;

/**
 * Why the page can't be shown as it is, if it can't. The frame grows to fit the page, so a page
 * sized by the viewport's height grows with it, again and again.
 */
export function htmlProblem(html: string): string | undefined {
  if (!html.trim()) return "The page is empty.";
  if (new TextEncoder().encode(html).byteLength > HTML_RENDER_MAX_BYTES) return `The page is over ${HTML_RENDER_MAX_BYTES / 1000} KB. Load big libraries from a CDN instead of inlining them, and keep data compact.`;
  for (const [, sheet, dq, sq, bare] of html.matchAll(CSS_SOURCE)) {
    const found = VIEWPORT_HEIGHT.exec(sheet ?? dq ?? sq ?? bare ?? "")?.[0];
    if (found) return `The page uses a viewport height unit (${found}). Its frame grows to fit the page, so a size that follows the viewport grows with it forever. Let content set the height, or use fixed pixel heights.`;
  }
  return undefined;
}

/** The title of an html_render call from its arguments' JSON so far, once it's all there. */
export function partialTitle(json: string) {
  const m = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return undefined;
  }
}

/** A file name for saving the page. */
export function htmlFileName(title: string) {
  const name = title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100).trim();
  return `${name || "Page"}.html`;
}
