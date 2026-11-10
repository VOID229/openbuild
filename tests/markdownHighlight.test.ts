// Code in replies is highlighted by one highlighter shared by every block (components/Markdown.tsx),
// rather than a new one per block: each language still comes out highlighted, block after block.
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown";

const render = (content: string) => renderToStaticMarkup(createElement(Markdown, { content }));

test("every code block is highlighted in its own language, and plain blocks stay plain", () => {
  const html = render("```ts\nconst a = 1;\n```\n\nSome text.\n\n```python\ndef f():\n    return 2\n```\n\n```\nplain text\n```\n\n```nosuchlanguage\nx\n```\n");
  expect(html).toContain('class="hljs language-ts"');
  expect(html).toContain('<span class="hljs-keyword">const</span>');
  expect(html).toContain('class="hljs language-python"');
  expect(html).toContain('<span class="hljs-keyword">def</span>');
  expect(html).toContain("plain text");
  expect(html).not.toContain('class="hljs"');
  // A language the highlighter doesn't know is left as it is.
  expect(html).toContain("language-nosuchlanguage");
  // The same again in a later message: the shared highlighter is still good.
  expect(render("```ts\nlet b = 2;\n```")).toContain('<span class="hljs-keyword">let</span>');
});
