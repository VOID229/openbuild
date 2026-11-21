// The dark theme has to look the same on a Mac's panel and on PC monitors that lift near-black (an sRGB
// toe, a shadow boost, IPS glow, Chromium's gamma 2.2 re-encode on KDE Wayland). Black is the one level
// none of them moves, so the ground is black everywhere; the levels on it are far enough apart that a
// lifted display doesn't merge them; and lines are solid, not faint white over black.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");
const bots = readFileSync(join(import.meta.dir, "../src/bots.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string, sheet = css): string {
  const at = sheet.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`no rule ${selector}`);
  return sheet.slice(at, sheet.indexOf("\n}", at));
}

function token(block: string, name: string): string {
  const m = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(block);
  if (!m) throw new Error(`no ${name}`);
  return m[1]!.trim();
}

/** A solid grey's level, 0–255, or undefined for anything else (a wash, a mix, a colour). */
function grey(value: string): number | undefined {
  const m = /^#([0-9a-f]{2})\1\1$/i.exec(value);
  return m ? parseInt(m[1]!, 16) : undefined;
}

describe("dark ground", () => {
  const dark = rule(':root[data-theme="dark"]');

  test("the sidebar's ground and the main pane are the same black", () => {
    expect(token(dark, "--bg")).toBe("#000000");
    expect(token(dark, "--surface")).toBe("#000000");
    // The page and its sidebars paint --bg, the main pane --surface.
    expect(rule("body")).toContain("background: var(--bg);");
    expect(rule(".main")).toContain("background: var(--surface);");
    expect(css).not.toContain("--bg-fill");
  });

  test("the raised levels are solid greys at least 8 apart, from black and from each other", () => {
    const levels = ["--surface-raised", "--surface-2", "--surface-3"].map((name) => grey(token(dark, name)));
    expect(levels.every((l) => l !== undefined)).toBe(true);
    let below = 0;
    for (const level of levels as number[]) {
      expect(level - below).toBeGreaterThanOrEqual(8);
      below = level;
    }
    // Everything else that stands on the ground is one of them, or as far from black.
    for (const name of ["--bubble", "--code-bg", "--seg-track", "--seg-on"]) expect(grey(token(dark, name))).toBeGreaterThanOrEqual(18);
    // A bot's message: the dark block after the one that mixes it for the light theme.
    const after = bots.slice(bots.indexOf("--bm-them: color-mix"));
    expect(token(rule(':root[data-theme="dark"]', after), "--bm-them")).toBe("var(--surface-raised)");
  });

  test("lines are solid, and well clear of black", () => {
    for (const name of ["--border", "--border-strong", "--composer-border", "--composer-border-focus"]) {
      expect(grey(token(dark, name))).toBeGreaterThanOrEqual(32);
    }
    expect(grey(token(dark, "--border-strong"))!).toBeGreaterThan(grey(token(dark, "--border"))!);
    expect(token(dark, "--shadow-md")).toStartWith("0 0 0 1px var(--border),");
    expect(token(dark, "--shadow-lg")).toStartWith("0 0 0 1px var(--border),");
  });

  test("pasted images are outlined with the solid line", () => {
    expect(rule(".msg-image img")).toContain("border: 1px solid var(--border);");
    expect(rule(".attachment")).toContain("border: 1px solid var(--border);");
    expect(rule(".bots-composer-image img", bots)).toContain("border: 1px solid var(--border);");
  });

  test("a thread row's tints are the theme's, the same as OpenBots' rows in the dark", () => {
    expect(token(dark, "--row-hover")).toBe("var(--hover)");
    expect(token(dark, "--row-on")).toBe("var(--active)");
    const rows = css.slice(css.indexOf("\n.history-row {"), css.indexOf("\n/* A row: the title on one line"));
    expect(rows).not.toContain("color-mix");
    expect(rule(".history-actions")).toContain("var(--bg)");
    expect(rule(".history-actions::before")).toContain("var(--bg)");
  });

  test("the light theme keeps its tints", () => {
    const light = rule(":root");
    expect(token(light, "--row-focus")).toBe("color-mix(in srgb, var(--text) 4%, transparent)");
    expect(token(light, "--row-hover")).toBe("color-mix(in srgb, var(--text) 5%, transparent)");
    expect(token(light, "--row-on")).toBe("color-mix(in srgb, var(--text) 9%, transparent)");
    expect(token(light, "--border")).toBe("rgba(0, 0, 0, 0.06)");
  });

  test("a dividing line is the hairline: one device pixel on a sharp screen", () => {
    expect(token(rule(":root"), "--hairline")).toBe("1px");
    expect(css).toContain("@media (min-resolution: 2dppx) {\n  :root {\n    --hairline: 0.5px;\n  }\n}");
    expect(rule(".main")).toContain("border-left: var(--hairline) solid var(--border);");
    expect(rule(".settings-row")).toContain("border-top: var(--hairline) solid var(--border);");
  });

  test("the terminal is the pane's black, not a near-black drawer", () => {
    expect(token(dark, "--terminal-bg")).toBe("#000000");
    expect(rule(".terminal-panel")).toContain("border-top: var(--hairline) solid var(--border);");
  });

  test("no white wash in the dark tokens is too faint to survive a lifted black", () => {
    const blocks = [css, bots].flatMap((sheet) => sheet.split('\n:root[data-theme="dark"] {').slice(1).map((b) => b.slice(0, b.indexOf("\n}"))));
    expect(blocks.length).toBeGreaterThan(2);
    const washes = blocks.join("\n").matchAll(/rgba?\(255,? 255,? 255(?:,| \/) ?([\d.]+)\)/g);
    for (const [wash, alpha] of washes) expect({ wash, faint: Number(alpha) < 0.07 }).toEqual({ wash, faint: false });
    // The editor's current line is the theme's hover wash, as in the light theme.
    expect(blocks.join("\n")).not.toContain("--cm-active-line");
    expect(css).toContain("--cm-active-line: var(--hover);");
  });

  test("the chosen segment's ring is a solid line clear of its fill", () => {
    expect(token(dark, "--seg-on-shadow")).toBe("inset 0 0 0 1px var(--border-strong)");
    expect(grey(token(dark, "--border-strong"))! - grey(token(dark, "--seg-on"))!).toBeGreaterThanOrEqual(8);
  });

  test("nothing bordered with the hairline sits on surface-3, and its dim text stays readable", () => {
    // Every rule that fills with --surface-3 and draws a border draws it with --border-strong: --border is
    // too close to surface-3 to show on it.
    for (const sheet of [css, bots]) {
      for (const [, body] of sheet.matchAll(/\{([^{}]*background: var\(--surface-3[^{}]*)\}/g)) {
        expect(body!).not.toMatch(/border(?:-color)?: [^;]*var\(--border\)/);
      }
    }
    // WCAG contrast of --text-3 on --surface-3 (.msg-usage's label), and on the black ground.
    const lum = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const contrast = (a: number, b: number) => (lum(Math.max(a, b)) + 0.05) / (lum(Math.min(a, b)) + 0.05);
    const text3 = grey(token(dark, "--text-3"))!;
    expect(contrast(text3, grey(token(dark, "--surface-3"))!)).toBeGreaterThanOrEqual(3.3);
    expect(contrast(text3, 0)).toBeGreaterThanOrEqual(4.5);
  });

  test("the page says it's dark", () => {
    expect(token(dark, "color-scheme")).toBe("dark");
  });
});
