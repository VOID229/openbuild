import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the favicon is a white ring on a dark rounded tile", () => {
  const html = readFileSync("src/index.html", "utf8");
  const icons = [...html.matchAll(/<link\s+rel="icon"\s+href="([^"]+)"/g)].map((m) => m[1]!);
  expect(icons).toHaveLength(1);
  const [icon = ""] = icons;
  expect(icon).toStartWith("data:image/svg+xml,");
  const svg = decodeURIComponent(icon.slice("data:image/svg+xml,".length)).replace(/'/g, '"');
  expect(svg).toBe(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="8" fill="#1e1e1e"/>' +
      '<circle cx="16" cy="16" r="7" fill="none" stroke="white" stroke-width="3"/>' +
      "</svg>",
  );
});
