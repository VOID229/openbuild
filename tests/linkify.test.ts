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
