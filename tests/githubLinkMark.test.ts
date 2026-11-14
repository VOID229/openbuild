// A link to GitHub (a pull request, issue, commit or repository) shows GitHub's mark before its text,
// in thread replies (Markdown), your own messages (Linkify) and OpenBots alike; other links don't.
// The look, wrapping and clicks in a real Chrome are in tests/botPullRefsChrome.test.ts.
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Linkify, LinkText, WebLink } from "../src/components/Linkify";
import { Markdown } from "../src/components/Markdown";
import { isGitHubUrl } from "../src/lib/links";

const MARK = '<svg class="gh-mark"';
const marks = (html: string) => html.split(MARK).length - 1;

describe("isGitHubUrl", () => {
  test("github.com and its own subdomains", () => {
    expect(isGitHubUrl("https://github.com/a/b/pull/1842")).toBe(true);
    expect(isGitHubUrl("https://github.com/a/b/issues/3")).toBe(true);
    expect(isGitHubUrl("https://github.com/a/b/commit/abc123")).toBe(true);
    expect(isGitHubUrl("https://GitHub.com/a")).toBe(true);
    expect(isGitHubUrl("http://www.github.com/a/b")).toBe(true);
    expect(isGitHubUrl("https://gist.github.com/a/1")).toBe(true);
  });

  test("not lookalikes, Pages sites, other schemes or relative links", () => {
    expect(isGitHubUrl("https://notgithub.com/a")).toBe(false);
    expect(isGitHubUrl("https://github.com.evil.dev/a")).toBe(false);
    expect(isGitHubUrl("https://someone.github.io/site")).toBe(false);
    expect(isGitHubUrl("https://example.com/?u=github.com")).toBe(false);
    expect(isGitHubUrl("file:///github.com/a")).toBe(false);
    expect(isGitHubUrl("/thread-f707f90a")).toBe(false);
    expect(isGitHubUrl(undefined)).toBe(false);
  });
});

describe("LinkText", () => {
  const render = (href: string, children: React.ReactNode) => renderToStaticMarkup(createElement(LinkText, { href, children }));

  test("puts the mark and the first character in one unbreakable span, and the rest after it", () => {
    const html = render("https://github.com/a/b/pull/1842", "#1842");
    expect(html).toMatch(/^<span class="gh-lead"><svg class="gh-mark"[^>]*aria-hidden="true"[^>]*>.*<\/svg>#<\/span>1842$/);
    // The mark is decoration: the link's text is still just the reference.
    expect(html.replace(/<[^>]+>/g, "")).toBe("#1842");
  });

  test("keeps an element first child whole beside the mark", () => {
    const html = render("https://github.com/a/b", [createElement("code", { key: "c" }, "a/b"), " repo"]);
    expect(html).toMatch(/^<span class="gh-lead"><svg class="gh-mark".*<\/svg><code>a\/b<\/code><\/span> repo$/);
  });

  test("leaves other links and pictures (badges) alone", () => {
    expect(render("https://example.com/a", "example")).toBe("example");
    const badge = render("https://github.com/a/b/actions", createElement("img", { src: "badge.svg", alt: "CI" }));
    expect(badge).toContain('<img src="badge.svg" alt="CI"/>');
    expect(badge).not.toContain(MARK);
  });
});

describe("links to GitHub across the app", () => {
  test("bare URLs in your own messages", () => {
    const html = renderToStaticMarkup(createElement(Linkify, { text: "see https://github.com/a/b/pull/7, and https://example.com/x." }));
    expect(marks(html)).toBe(1);
    expect(html).toContain(`<a class="link" href="https://github.com/a/b/pull/7" target="_blank" rel="noopener noreferrer"><span class="gh-lead">${MARK}`);
    // The URL still reads in full, with the punctuation after it outside the link.
    expect(html.replace(/<[^>]+>/g, "")).toBe("see https://github.com/a/b/pull/7, and https://example.com/x.");
  });

  test("schemeless github.com addresses in OpenBots", () => {
    const html = renderToStaticMarkup(createElement(Linkify, { text: "github.com/a/b", bare: true }));
    expect(html).toContain('href="https://github.com/a/b"');
    expect(marks(html)).toBe(1);
  });

  test("Markdown links and autolinks in replies", () => {
    const html = renderToStaticMarkup(createElement(Markdown, { content: "Fixed in [#1842](https://github.com/a/b/pull/1842), see https://github.com/a/b/issues/3 and [docs](https://example.com)." }));
    expect(marks(html)).toBe(2);
    expect(html).toContain(`href="https://github.com/a/b/pull/1842" class="link" target="_blank" rel="noopener noreferrer"><span class="gh-lead">${MARK}`);
    expect(html).toMatch(/<a href="https:\/\/example.com" class="link"[^>]*>docs<\/a>/);
  });

  test("Markdown links in OpenBots", () => {
    const html = renderToStaticMarkup(createElement(WebLink, { url: "https://github.com/a/b/commit/abc1234", children: "abc1234" }));
    expect(html).toMatch(/<span class="gh-lead"><svg class="gh-mark".*<\/svg>a<\/span>bc1234<\/a>$/);
  });
});
