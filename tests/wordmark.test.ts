import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Wordmark } from "../src/components/Wordmark";

test("the sidebar wordmarks draw the brushstroke lockups and keep the names as text", () => {
  for (const [brand, label] of [["openbuild", "OpenBuild"], ["openbots", "OpenBots"]] as const) {
    const html = renderToStaticMarkup(createElement(Wordmark, { brand, className: "extra" }));
    expect(html).toStartWith('<span class="wordmark extra">');
    // The art is hidden from assistive tech; the name is what gets read, searched and copied.
    expect(html).toContain('<span class="wordmark-art" aria-hidden="true"><svg');
    expect(html).toContain(`<span class="wordmark-label">${label}</span>`);
    const svg = html.match(/<svg[^>]*>/)![0];
    // It follows the header's text colour and lets CSS size it from the font size.
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toMatch(/\s(width|height)=/);
    expect(svg).toMatch(/viewBox="[\d. -]+"/);
  }
});

test("both sidebar headers use the wordmark in place of the plain name", () => {
  expect(readFileSync("src/components/Sidebar.tsx", "utf8")).toContain('<Wordmark brand="openbuild" />');
  const bots = readFileSync("src/components/bots/BotsSidebar.tsx", "utf8");
  expect(bots).toContain('<Wordmark brand="openbots" className="bots-wordmark" />');
  expect(bots).not.toContain(">OpenBots</span>");
  // One font size tall, so the existing desktop and phone sizes still decide how big the name is.
  expect(readFileSync("src/styles.css", "utf8")).toMatch(/\.wordmark-art svg \{[^}]*height: 1em;/);
});
