import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the favicon is the brush mark in the reference's ivory on its near-black tile", () => {
  const html = readFileSync("src/index.html", "utf8");
  const icons = [...html.matchAll(/<link\s+rel="icon"\s+href="([^"]+)"/g)].map((m) => m[1]!);
  expect(icons).toHaveLength(1);
  const [icon = ""] = icons;
  expect(icon).toStartWith("data:image/svg+xml,");
  const svg = decodeURIComponent(icon.slice("data:image/svg+xml,".length)).replace(/'/g, '"');
  // Kept in step with its source: rerun design/brush-mark/build.ts after changing the mark.
  expect(svg).toBe(readFileSync("design/brush-mark/svg/favicon.svg", "utf8").trim());
  expect(svg).toContain('viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1f201d"/>');
  expect(svg).toContain('<g fill="#ece5d5" fill-rule="evenodd"');
  // The ring and the brush B, nothing else.
  expect(svg.match(/<path /g)).toHaveLength(2);
});
