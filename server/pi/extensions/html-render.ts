// A Pi extension OpenBuild loads (`-e`) into every thread's `pi --mode rpc` process. It gives the
// model `html_render`: a self-contained HTML page (a chart, diagram, mockup or small interactive
// tool) shown in the thread, in a sandboxed frame above the reply. The page is the call's own
// argument, so it's kept in Pi's session like any tool call and the app draws it from there
// (src/components/HtmlRender.tsx); nothing is stored anywhere else.
//
// `html_preview` lets the model look at a page first: a screenshot from headless Chrome or
// Chromium, the height the page came out at, and what it logged. It's only offered when this
// machine has one of those browsers.
//
// Only Node's own modules and OpenBuild's shared file: Pi loads this file on its own.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  HTML_LAYOUT_GUIDE,
  HTML_PREVIEW_TOOL,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_TOOL,
  HTML_RENDER_WIDTH,
  HTML_THEME_GUIDE,
  htmlProblem,
  htmlTheme,
  withBootstrap,
} from "../../../shared/htmlRender";

export const TOOL = HTML_RENDER_TOOL;
export const PREVIEW_TOOL = HTML_PREVIEW_TOOL;

const text = (t: string) => [{ type: "text", text: t }];

const NOTE = (preview: boolean) =>
  `Answer data with a trend or comparison with a chart, and show any visual the user asks for (a diagram, a mockup, a small interactive tool) right in the thread: write a self-contained HTML page${preview ? `, look at it with ${PREVIEW_TOOL},` : ""} and show it with ${TOOL}. ` +
  `Don't start a server or write a file just to show something. If the user wants an image file to use elsewhere, make a .png and give its path instead.`;

/** A Chrome or Chromium that can run headless here, if there is one. */
export function findBrowser(env: Record<string, string | undefined> = process.env): string | undefined {
  const own = env.OPENBUILD_CHROME || env.CHROME_PATH;
  if (own) return existsSync(own) ? own : undefined;
  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "microsoft-edge", "brave-browser"];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  }
  const apps = ["Google Chrome", "Chromium", "Microsoft Edge", "Brave Browser"].map((app) => `/Applications/${app}.app/Contents/MacOS/${app}`);
  for (const app of apps) if (existsSync(app)) return app;
  // Playwright's own downloads (e.g. from `npx playwright install`).
  for (const cache of [join(homedir(), ".cache", "ms-playwright"), join(homedir(), "Library", "Caches", "ms-playwright")]) {
    let builds: string[];
    try {
      builds = readdirSync(cache).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d)).sort().reverse();
    } catch {
      continue;
    }
    for (const build of builds) {
      for (const sub of readdirSync(join(cache, build))) {
        for (const exe of ["chrome-headless-shell", "chrome", "Chromium.app/Contents/MacOS/Chromium", "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]) {
          if (existsSync(join(cache, build, sub, exe))) return join(cache, build, sub, exe);
        }
      }
    }
  }
  return undefined;
}

const run = (file: string, args: string[], signal?: AbortSignal) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, args, { timeout: 30_000, maxBuffer: 32 * 1024 * 1024, signal }, (error, stdout, stderr) =>
      error && !stdout ? reject(Object.assign(error, { stderr })) : resolve({ stdout: String(stdout), stderr: String(stderr) }),
    );
  });

// After the page has loaded and drawn, it writes its height where --dump-dom shows it.
const MEASURE =
  '<script>addEventListener("load",function(){setTimeout(function(){var r=document.documentElement;' +
  'r.setAttribute("data-openbuild-height",String(Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height)))},250)})</script>';

/** What the page logged, from Chrome's log on stderr. */
function consoleOf(stderr: string) {
  const lines: string[] = [];
  for (const m of stderr.matchAll(/:CONSOLE(?::\d+|\(\d+\))?\] "([\s\S]*?)", source: ([^\n]*)/g)) {
    const source = m[2]!.replace(/^file:\/\/\S*?page\.html/, "page");
    lines.push(`${m[1]} (${source.trim()})`);
    if (lines.length >= 30) break;
  }
  return lines;
}

/** A screenshot of the page as it would be drawn in the thread, its height, and its console. */
export async function previewPage(browser: string, html: string, opts: { width?: number; appearance?: "light" | "dark"; signal?: AbortSignal } = {}) {
  const width = Math.min(1600, Math.max(240, Math.round(opts.width ?? HTML_RENDER_WIDTH)));
  const appearance = opts.appearance === "light" ? "light" : "dark";
  const dir = await mkdtemp(join(tmpdir(), "openbuild-html-"));
  try {
    const page = join(dir, "page.html");
    await writeFile(page, withBootstrap(html, htmlTheme(appearance), { opaque: true }) + MEASURE);
    const common = [
      "--headless", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check",
      "--force-device-scale-factor=1", `--user-data-dir=${join(dir, "profile")}`, "--virtual-time-budget=5000",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ];
    const url = `file://${page}`;
    const measured = await run(browser, [...common, `--window-size=${width},800`, "--dump-dom", url], opts.signal);
    const height = Number(/data-openbuild-height="(\d+)"/.exec(measured.stdout)?.[1]) || 0;
    const captured = Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, height || 600));
    const shot = join(dir, "shot.png");
    await run(browser, [...common, `--window-size=${width},${captured}`, `--screenshot=${shot}`, url], opts.signal);
    const png = (await readFile(shot)).toString("base64");
    return { width, contentHeight: height, capturedHeight: captured, console: consoleOf(measured.stderr), png };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export default function htmlRender(pi: any) {
  const browser = findBrowser();
  let wired = false;
  pi.on("session_start", () => {
    if (wired) return;
    wired = true;
    pi.on("before_agent_start", (event: any) => {
      const opts = event.systemPromptOptions;
      const current = String(opts.appendSystemPrompt ?? "");
      opts.appendSystemPrompt = current.includes(`with ${TOOL}`) ? current : `${current}\n\n${NOTE(!!browser)}`.trim();
    });
  });

  pi.registerTool({
    name: TOOL,
    label: "Show HTML",
    description:
      `Show a finished HTML page (a chart, diagram, mockup or small interactive tool) in this thread, above your reply. ` +
      `It runs in a sandboxed frame: inline <style> and <script> work, and libraries load from CDNs, but it can't reach the app, the user's files or a local server. ` +
      `Don't announce or restate the page in your reply. ${HTML_LAYOUT_GUIDE} ${HTML_THEME_GUIDE}`,
    parameters: {
      type: "object",
      properties: {
        html: { type: "string", description: "A complete, self-contained HTML document." },
        title: { type: "string", description: "A short name for the page, e.g. \"Weekly signups\"." },
        height: {
          type: "integer",
          description: `Its height in CSS pixels until it has loaded (${browser ? `the contentHeight from ${PREVIEW_TOOL}` : "your best guess"}); the frame then fits the page.`,
        },
      },
      required: ["html", "title"],
      additionalProperties: false,
    },
    exposure: "model-only",

    async execute(_id: string, params: { html: string; title: string; height?: number }) {
      const html = String(params.html ?? "");
      const title = String(params.title ?? "").trim().slice(0, HTML_RENDER_MAX_TITLE) || "Page";
      const problem = htmlProblem(html);
      if (problem) return { content: text(`Error: ${problem}`), details: { title }, isError: true };
      return {
        content: text("Shown to the user above your reply. Don't mention or describe the page; reply with only what it doesn't already say."),
        details: { title, bytes: html.length },
      };
    },
  });

  if (!browser) return;
  pi.registerTool({
    name: PREVIEW_TOOL,
    label: "Preview HTML",
    description:
      `Look at an HTML page before showing it with ${TOOL}: a screenshot as it will be drawn in the thread, the height it came out at (pass it to ${TOOL} as height), and what it logged to the console. ` +
      `Only you see this. Layout and theme rules are in ${TOOL}.`,
    parameters: {
      type: "object",
      properties: {
        html: { type: "string", description: "A complete, self-contained HTML document." },
        width: { type: "integer", description: `CSS pixels, 240 to 1600. Default ${HTML_RENDER_WIDTH}; about 390 for a phone.` },
        appearance: { type: "string", enum: ["dark", "light"], description: "Default dark." },
      },
      required: ["html"],
      additionalProperties: false,
    },
    exposure: "model-only",

    async execute(_id: string, params: { html: string; width?: number; appearance?: "light" | "dark" }, signal?: AbortSignal) {
      const html = String(params.html ?? "");
      const problem = htmlProblem(html);
      if (problem) return { content: text(`Error: ${problem}`), details: {}, isError: true };
      try {
        const p = await previewPage(browser, html, { width: params.width, appearance: params.appearance, signal });
        const summary = [
          p.contentHeight ? `contentHeight: ${p.contentHeight}px at ${p.width}px wide.` : `Couldn't measure the page's height; the screenshot is ${p.capturedHeight}px tall.`,
          p.contentHeight > HTML_RENDER_MAX_HEIGHT ? `Taller than ${HTML_RENDER_MAX_HEIGHT}px: the screenshot is cut there, and in the thread the rest scrolls inside the frame.` : "",
          p.console.length ? `Console:\n${p.console.join("\n")}` : "Console: nothing logged.",
        ].filter(Boolean).join("\n");
        return {
          content: [...text(summary), { type: "image", data: p.png, mimeType: "image/png" }],
          details: { width: p.width, contentHeight: p.contentHeight },
        };
      } catch (error: any) {
        if (signal?.aborted) return { content: text("Preview cancelled."), details: {}, isError: true };
        return { content: text(`Error: the browser couldn't render the page (${String(error?.stderr || error?.message || error).trim().split("\n").at(-1)}).`), details: {}, isError: true };
      }
    },
  });
}
