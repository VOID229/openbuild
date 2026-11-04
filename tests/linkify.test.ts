// Bare URLs in your own messages become links; punctuation after a URL stays outside the link.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Linkify } from "../src/components/Linkify";

const render = (text: string) => renderToStaticMarkup(createElement(Linkify, { text }));

describe("Linkify", () => {
  test("links a URL and opens it in a new tab", () => {
    const html = render("see https://github.com/a/b here");
    expect(html).toContain('href="https://github.com/a/b"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('class="link"');
  });

  test("keeps sentence punctuation out of the link", () => {
    const html = render("Read https://x.dev/docs.");
    expect(html).toContain('href="https://x.dev/docs"');
    expect(html).toMatch(/<\/a>\./);
  });

  test("keeps balanced brackets in the URL", () => {
    expect(render("https://en.wikipedia.org/wiki/Markdown_(film)")).toContain('href="https://en.wikipedia.org/wiki/Markdown_(film)"');
  });

  test("leaves plain text alone", () => {
    expect(render("no links here")).toBe("no links here");
  });
});

describe("file links", () => {
  test("routes file URLs through the sending bot and keeps punctuation outside", () => {
    const html = renderToStaticMarkup(createElement(Linkify, {
      text: "Story: file:///tmp/story.md.",
      fileHref: (url) => `/api/bots/helper/file?url=${encodeURIComponent(url)}`,
    }));
    expect(html).toContain('class="link file-link"');
    expect(html).toContain('href="/api/bots/helper/file?url=file%3A%2F%2F%2Ftmp%2Fstory.md"');
    expect(html).toContain('file:///tmp/story.md</a>.');
  });

  test("leaves file URLs alone without a computer context", () => {
    expect(render("file:///tmp/story.md")).toBe("file:///tmp/story.md");
  });

  test("preserves encoded spaces in file URLs", () => {
    const html = renderToStaticMarkup(createElement(Linkify, {
      text: "file:///tmp/my%20story.md",
      fileHref: (url) => `/files?url=${encodeURIComponent(url)}`,
    }));
    expect(html).toContain('href="/files?url=file%3A%2F%2F%2Ftmp%2Fmy%2520story.md"');
  });
});

describe("bare addresses", () => {
  const bare = (text: string) => renderToStaticMarkup(createElement(Linkify, { text, bare: true }));

  test("links schemeless domains over https, keeping the text as written", () => {
    const html = bare("Sources: The New Stack (thenewstack.io/claude-ultra-session-limit), Notebookcheck (notebookcheck.net, Oct 31).");
    expect(html).toContain('href="https://thenewstack.io/claude-ultra-session-limit"');
    expect(html).toContain(">thenewstack.io/claude-ultra-session-limit</a>),");
    expect(html).toContain('href="https://notebookcheck.net"');
    expect(html).toContain(">notebookcheck.net</a>,");
  });

  test("leaves file names, emails and versions alone", () => {
    expect(bare("edit agent.ts and notes.md, mail me@x.com, v1.2.3")).not.toContain("<a");
  });

  test("still links full URLs once", () => {
    const html = bare("https://x.com/a");
    expect(html.match(/<a /g)?.length).toBe(1);
    expect(html).toContain('href="https://x.com/a"');
  });

  test("is off unless asked for", () => {
    expect(render("thenewstack.io")).toBe("thenewstack.io");
  });
});
