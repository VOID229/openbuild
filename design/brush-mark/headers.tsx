// Renders the two sidebar header rows with the app's real CSS, before (plain name) and after (Wordmark),
// screenshots them on desktop and phone in both themes, and checks the surrounding controls did not move.
// Run: bun design/brush-mark/headers.tsx
import { Blocks, ListFilter, PanelLeft, Plus, Search } from "lucide-react";
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { IconButton } from "../../src/components/primitives";
import { Wordmark } from "../../src/components/Wordmark";

const dir = import.meta.dir;
const src = resolve(dir, "../../src");
const chrome = process.env.CHROME ?? (() => {
  const base = join(process.env.HOME!, ".cache/ms-playwright");
  const c = readdirSync(base).filter((d) => d.startsWith("chromium-")).sort().at(-1)!;
  return join(base, c, readdirSync(join(base, c)).find((d) => d.startsWith("chrome-linux"))!, "chrome");
})();

const btn = (label: string, icon: ReactNode) => h(IconButton, { label }, icon);
const old = (cls: string, text: string) => h("span", { className: cls }, text);
// Mirrors the brand rows in Sidebar.tsx and BotsSidebar.tsx (the phone drops close and search on OpenBots).
const buildRow = (name: ReactNode) =>
  h("div", { className: "brand-row" }, btn("Close sidebar", h(PanelLeft, { size: 18 })), name, btn("Filter", h(ListFilter, { size: 18 })));
const botsRow = (name: ReactNode, phone: boolean) =>
  h("div", { className: "brand-row" }, !phone && btn("Close sidebar", h(PanelLeft, { size: 18 })), name, !phone && btn("Search", h(Search, { size: 18 })), btn("Apps", h(Blocks, { size: 18 })), btn("New", h(Plus, { size: 18 })));

const page = (theme: string, phone: boolean) => {
  const pane = (title: string, cls: string, row: ReactNode) =>
    `<div class="cap">${title}</div><aside class="sidebar sidebar-open ${cls}" style="position:static;transform:none;height:auto"><div class="sidebar-inner" style="height:auto">${renderToStaticMarkup(row as never)}</div></aside>`;
  const rows = [
    pane("OpenBuild — before", "", buildRow(old("wordmark", "OpenBuild"))),
    pane("OpenBuild — after", "", buildRow(h(Wordmark, { brand: "openbuild" }))),
    pane("OpenBots — before", "bots-sidebar", botsRow(old("wordmark bots-wordmark", "OpenBots"), phone)),
    pane("OpenBots — after", "bots-sidebar", botsRow(h(Wordmark, { brand: "openbots", className: "bots-wordmark" }), phone)),
  ];
  return `<!doctype html><html data-theme="${theme}" data-font="fun"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="file://${src}/styles.css"><link rel="stylesheet" href="file://${src}/bots.css"><link rel="stylesheet" href="file://${src}/mobile.css">
<style>body{overflow:visible;height:auto;padding:12px 0}.cap{font:11px system-ui;color:var(--text-3);padding:8px 14px 0}.sidebar{width:var(--sidebar-w);border-right:0}</style></head>
<body>${rows.join("")}
<script>
  // Every control's box in each row; before and after must match.
  const rows = [...document.querySelectorAll(".brand-row")].map((r) => ({ h: r.getBoundingClientRect().height, btns: [...r.querySelectorAll(".icon-btn")].map((b) => { const x = b.getBoundingClientRect(); return [x.left, x.top - r.getBoundingClientRect().top, x.width, x.height]; }), art: (r.querySelector(".wordmark-art svg") || r.querySelector(".wordmark")).getBoundingClientRect().height }));
  document.body.insertAdjacentHTML("beforeend", "<pre id=m>" + JSON.stringify(rows) + "</pre>");
</script></body></html>`;
};

mkdirSync(join(dir, "screenshots"), { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "wordmark-headers-"));
let ok = true;
for (const [theme, phone, w, hgt] of [["dark", false, 1280, 380], ["light", false, 1280, 380], ["dark", true, 390, 400]] as const) {
  const name = `headers-${phone ? "phone" : "desktop"}-${theme}`;
  const file = join(scratch, `${name}.html`);
  writeFileSync(file, page(theme, phone));
  const args = ["--headless=new", "--no-sandbox", "--hide-scrollbars", "--disable-gpu", "--virtual-time-budget=3000", `--window-size=${w},${hgt}`];
  const shot = Bun.spawnSync([chrome, ...args, "--force-device-scale-factor=2", `--screenshot=${join(dir, "screenshots", `${name}.png`)}`, `file://${file}`]);
  const dom = Bun.spawnSync([chrome, ...args, "--dump-dom", `file://${file}`]).stdout.toString();
  const rows = JSON.parse(dom.match(/<pre id="m">(.*?)<\/pre>/s)![1].replace(/&quot;/g, '"'));
  for (const [before, after, what] of [[rows[0], rows[1], "OpenBuild"], [rows[2], rows[3], "OpenBots"]]) {
    const same = JSON.stringify([before.h, before.btns]) === JSON.stringify([after.h, after.btns]);
    ok &&= same && shot.exitCode === 0;
    console.log(`${name} ${what}: row ${after.h}px, controls ${same ? "unchanged" : `MOVED ${JSON.stringify(before.btns)} -> ${JSON.stringify(after.btns)}`}, art ${after.art.toFixed(1)}px tall`);
  }
}
process.exit(ok ? 0 : 1);
