import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { isGitHubUrl, linkHref, onLinkClick } from "../lib/links";

// A bare web or file URL in plain text. Trailing punctuation that's usually part of the sentence
// ("see https://x.dev/docs.") stays outside the link.
const URL_RE = /(?:https?:\/\/|file:\/\/\/)[^\s<>"'`]+/g;
// With `bare`, also a schemeless address ("thenewstack.io/story"). Only common web TLDs count, so
// file names like `agent.ts` or `notes.md` stay text; an @ before it means it's an email address.
const BARE = String.raw`(?<![\w@./-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|dev|ai|app|co|uk|de|fr|eu|us|ca|jp|gov|edu|info|news|blog|tech|xyz|me|tv|gg|ly|so)(?![\w-])(?:\/[^\s<>"'\`]*)?`;
const URL_OR_BARE_RE = new RegExp(`${URL_RE.source}|${BARE}`, "gi");
const TRAILING = /[.,;:!?'"]+$/;

/** GitHub's mark (Octicons' mark-github, MIT), drawn in the link's own colour, so it follows the theme. */
export function GitHubMark() {
  return (
    <svg className="gh-mark" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
      />
    </svg>
  );
}

/**
 * A link's text, after GitHub's mark when the link goes to GitHub ("#1842", a commit, a repository).
 * The mark and the first character sit in one unbreakable span, so a line never ends on a lone mark;
 * the rest of the text wraps as it would. A link around a picture (a README badge) gets no mark.
 */
export function LinkText({ href, children }: { href: string | undefined; children: ReactNode }) {
  if (!isGitHubUrl(href)) return <>{children}</>;
  const [first, ...rest] = Children.toArray(children);
  if (first === undefined || rest.concat(first).some((c) => isValidElement(c) && c.type === "img")) return <>{children}</>;
  let lead: ReactNode = first;
  let tail: ReactNode[] = rest;
  if (typeof first === "string" || typeof first === "number") {
    const text = String(first);
    const char = /^[\s\S]/u.exec(text)?.[0] ?? "";
    lead = char;
    tail = [text.slice(char.length), ...rest];
  }
  return (
    <>
      <span className="gh-lead">
        <GitHubMark />
        {lead}
      </span>
      {tail}
    </>
  );
}

/** A web link that opens in a new tab (localhost ones in the side panel). */
export function WebLink({ url, children }: { url: string; children: ReactNode }) {
  return (
    <a className="link" href={linkHref(url)} target="_blank" rel="noopener noreferrer" onClick={(e) => onLinkClick(e, url)}>
      <LinkText href={url}>{children}</LinkText>
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
        {isFile ? url : <LinkText href={full}>{url}</LinkText>}
      </a>,
    );
    last = start + url.length;
  }
  parts.push(<Fragment key="end">{text.slice(last)}</Fragment>);
  return <>{parts}</>;
}
