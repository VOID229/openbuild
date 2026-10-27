import { expect, test } from "bun:test";
import { HTML_RENDER_MAX_BYTES, htmlFileName, partialTitle, htmlProblem, htmlTheme, readHeightMessage, withBootstrap } from "../shared/htmlRender";
import htmlRender, { findBrowser, previewPage } from "../server/pi/extensions/html-render";

const dark = htmlTheme("dark");

test("the bootstrap goes after the doctype and before the page's own styles", () => {
  const page = "<!-- chart --><!DOCTYPE html><html lang=en><head><style>:root{--background:red}</style></head><body>x</body></html>";
  const out = withBootstrap(page, dark);
  expect(out.startsWith("<!-- chart --><!DOCTYPE html><meta charset")).toBe(true);
  expect(out.indexOf('<style id="openbuild-theme">')).toBeLessThan(out.indexOf(":root{--background:red}"));
  expect(out.endsWith("<html lang=en><head><style>:root{--background:red}</style></head><body>x</body></html>")).toBe(true);
});

test("a fragment gets a doctype, so it never renders in quirks mode", () => {
  const out = withBootstrap("<p>hi</p>", dark);
  expect(out.startsWith("<!doctype html><meta charset")).toBe(true);
  expect(out.endsWith("<p>hi</p>")).toBe(true);
});

test("the theme maps the app's tokens and can't break out of its style element", () => {
  const theme = htmlTheme("light", (token) => (token === "--bg" ? "#fafafa" : token === "--text" ? "red;}</style><script>x()</script>" : ""));
  expect(theme.variables["--background"]).toBe("#fafafa");
  expect(theme.variables["--card"]).toBe("#ffffff");
  expect(theme.variables["--chart-1"]).toBeDefined();
  const out = withBootstrap("<p>hi</p>", theme);
  expect(out).toContain(":root{color-scheme:light;");
  expect(out).not.toContain("</style><script>x()");
  expect(out.match(/<\/style>/g)).toHaveLength(1);
});

test("pages sized by the viewport's height, empty pages and huge ones are turned away", () => {
  expect(htmlProblem("<style>.a{height:100vh}</style>")).toContain("100vh");
  expect(htmlProblem('<div style="min-height: 50dvh">')).toContain("50dvh");
  expect(htmlProblem("<script>const s = '100vh'</script><style>.a{height:300px}</style>")).toBeUndefined();
  expect(htmlProblem('<img src="data:image/png;base64,AAAA1vhBBB">')).toBeUndefined();
  expect(htmlProblem("<!-- 100vh --><p>ok</p>")).toBeUndefined();
  expect(htmlProblem("  ")).toBe("The page is empty.");
  expect(htmlProblem("x".repeat(HTML_RENDER_MAX_BYTES + 1))).toContain("KB");
});

test("only the page's own height messages are read", () => {
  expect(readHeightMessage({ type: "openbuild:html-height", height: 321 })).toBe(321);
  expect(readHeightMessage({ type: "openbuild:html-height", height: "321" })).toBeUndefined();
  expect(readHeightMessage({ type: "other", height: 321 })).toBeUndefined();
  expect(readHeightMessage(null)).toBeUndefined();
  expect(htmlFileName(' Q3: "revenue" / costs ')).toBe("Q3 revenue costs.html");
});

/** The extension against a stand-in for Pi's API. */
function load() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (event: any) => void>();
  htmlRender({ registerTool: (t: any) => tools.set(t.name, t), on: (event: string, fn: any) => handlers.set(event, fn) });
  handlers.get("session_start")!({});
  const prompt = { appendSystemPrompt: "Be brief." };
  handlers.get("before_agent_start")!({ systemPromptOptions: prompt });
  handlers.get("before_agent_start")!({ systemPromptOptions: prompt });
  return { tools, prompt: prompt.appendSystemPrompt };
}

test("html_render accepts a page and turns away one it can't show", async () => {
  const { tools, prompt } = load();
  expect(prompt).toStartWith("Be brief.");
  expect(prompt.match(/with html_render/g)).toHaveLength(1);
  const render = tools.get("html_render");
  const ok = await render.execute("c1", { html: "<p>hi</p>", title: " Signups " });
  expect(ok.isError).toBeUndefined();
  expect(ok.details.title).toBe("Signups");
  const bad = await render.execute("c2", { html: "<style>body{height:100vh}</style>", title: "x" });
  expect(bad.isError).toBe(true);
  expect(tools.has("html_preview")).toBe(!!findBrowser());
});

const browser = findBrowser();
test.skipIf(!browser)("html_preview measures the page and reports what it logged", async () => {
  const html = `<div style="height:300px;background:var(--card)"></div><script>console.log("drawn"); missing();</script>`;
  const p = await previewPage(browser!, html, { width: 400 });
  expect(p.width).toBe(400);
  expect(p.contentHeight).toBe(300);
  expect(p.console.some((l) => l.startsWith("drawn"))).toBe(true);
  expect(p.console.some((l) => l.includes("missing is not defined"))).toBe(true);
  expect(Buffer.from(p.png, "base64").subarray(1, 4).toString()).toBe("PNG");
}, 30_000);

test("a page's title is read from its arguments while they're still being written", () => {
  expect(partialTitle('{"html":"<p>{\\"title\\": \\"no\\"}</p>","title":"Q3 \\"revenue\\"","hei')).toBe('Q3 "revenue"');
  expect(partialTitle('{"title":"Weekly sig')).toBeUndefined();
  expect(partialTitle('{"html":"<title>x</title>')).toBeUndefined();
});
