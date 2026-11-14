// The dark theme's ground is a white wash over black, not an opaque near-black, because Chromium on KDE
// Plasma's Wayland lifts opaque near-blacks (#0a0a0a shows as #121212) but not a wash blended over black.
// These keep the two spellings of the ground in step and keep the sidebar off the opaque one.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  return css.slice(at, css.indexOf("\n}", at));
}

function token(block: string, name: string): string {
  const m = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(block);
  if (!m) throw new Error(`no ${name}`);
  return m[1]!.trim();
}

describe("dark ground", () => {
  const dark = rule(':root[data-theme="dark"]');

  test("the wash over the canvas is exactly --bg", () => {
    expect(token(dark, "--canvas")).toBe("#000000");
    const bg = token(dark, "--bg");
    const level = parseInt(bg.slice(1, 3), 16);
    expect(bg).toBe(`#${level.toString(16).padStart(2, "0").repeat(3)}`);
    const wash = /^rgb\(255 255 255 \/ ([\d.]+)\)$/.exec(token(dark, "--bg-wash"));
    expect(wash).not.toBeNull();
    // Chromium blends in 8 bits: white at this alpha over black lands on --bg's level.
    expect(Math.round(Number(wash![1]) * 255)).toBe(level);
    expect(token(dark, "--bg-fill")).toBe("linear-gradient(var(--bg-wash), var(--bg-wash)) var(--canvas)");
  });

  test("the light theme keeps an opaque ground", () => {
    const light = rule(":root");
    expect(token(light, "--canvas")).toBe("var(--bg)");
    expect(token(light, "--bg-wash")).toBe("transparent");
    expect(token(light, "--bg-fill")).toBe("var(--bg)");
  });

  test("the page and the thread rows paint the wash, not opaque --bg", () => {
    expect(rule("body")).toContain("background: var(--bg-fill);");
    const rows = css.slice(css.indexOf("\n.history-row {"), css.indexOf("\n/* A row: the title on one line"));
    expect(rows).not.toContain("var(--bg)");
    expect(rule(".history-actions")).toContain("var(--bg-fill)");
    expect(rule(".history-actions::before")).toContain("var(--bg-fill)");
    expect(css).not.toContain("--row-bg");
  });
});
