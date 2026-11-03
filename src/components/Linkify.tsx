import { Fragment } from "react";
import { linkHref, onLinkClick } from "../lib/links";

// A bare web or file URL in plain text. Trailing punctuation that's usually part of the sentence
// ("see https://x.dev/docs.") stays outside the link.
const URL_RE = /(?:https?:\/\/|file:\/\/\/)[^\s<>"'`]+/g;
const TRAILING = /[.,;:!?'"]+$/;

/** Web links open in a new tab; file links use the caller’s computer-aware download route. */
export function Linkify({ text, fileHref }: { text: string; fileHref?: (url: string) => string | undefined }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let url = m[0];
    // Keep a closing bracket only if its opening one is in the URL too (Wikipedia-style paths).
    while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    url = url.replace(TRAILING, "");
    if (!url || url.length <= "https://".length) continue;
    const isFile = url.startsWith("file:");
    const href = isFile ? fileHref?.(url) : linkHref(url);
    if (!href) continue;
    parts.push(<Fragment key={start}>{text.slice(last, start)}</Fragment>);
    parts.push(
      <a key={`${start}-link`} className={isFile ? "link file-link" : "link"} href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => !isFile && onLinkClick(e, url)}>
        {url}
      </a>,
    );
    last = start + url.length;
  }
  parts.push(<Fragment key="end">{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}
