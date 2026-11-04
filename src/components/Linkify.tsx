import { Fragment } from "react";
import { linkHref, onLinkClick } from "../lib/links";

// A bare web or file URL in plain text. Trailing punctuation that's usually part of the sentence
// ("see https://x.dev/docs.") stays outside the link.
const URL_RE = /(?:https?:\/\/|file:\/\/\/)[^\s<>"'`]+/g;
// With `bare`, also a schemeless address ("thenewstack.io/story"). Only common web TLDs count, so
// file names like `agent.ts` or `notes.md` stay text; an @ before it means it's an email address.
const BARE = String.raw`(?<![\w@./-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|ai|app|co|uk|de|fr|eu|us|ca|jp|gov|edu|info|news|blog|tech|xyz|me|tv|gg|ly|so)(?![\w-])(?:\/[^\s<>"'\`]*)?`;
const URL_OR_BARE_RE = new RegExp(`${URL_RE.source}|${BARE}`, "gi");
const TRAILING = /[.,;:!?'"]+$/;

/** A web link that opens in a new tab (localhost ones in the side panel). */
export function WebLink({ url, children }: { url: string; children: React.ReactNode }) {
  return (
    <a className="link" href={linkHref(url)} target="_blank" rel="noopener noreferrer" onClick={(e) => onLinkClick(e, url)}>
      {children}
    </a>
  );
}

/** Web links open in a new tab; file links use the caller’s computer-aware download route. */
export function Linkify({ text, fileHref, bare }: { text: string; fileHref?: (url: string) => string | undefined; bare?: boolean }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(bare ? URL_OR_BARE_RE : URL_RE)) {
    const start = m.index ?? 0;
    let url = m[0];
    // Keep a closing bracket only if its opening one is in the URL too (Wikipedia-style paths).
    // Trim both until neither applies, so "(see x.io/a)," loses the comma and then the bracket.
    for (let prev = ""; prev !== url; ) {
      prev = url;
      url = url.replace(TRAILING, "");
      if (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    }
    const isFile = /^file:/i.test(url);
    const full = isFile || /^https?:/i.test(url) ? url : `https://${url}`;
    if (full.length <= "https://".length) continue;
    const href = isFile ? fileHref?.(url) : linkHref(full);
    if (!href) continue;
    parts.push(<Fragment key={start}>{text.slice(last, start)}</Fragment>);
    parts.push(
      <a key={`${start}-link`} className={isFile ? "link file-link" : "link"} href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => !isFile && onLinkClick(e, full)}>
        {url}
      </a>,
    );
    last = start + url.length;
  }
  parts.push(<Fragment key="end">{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}
