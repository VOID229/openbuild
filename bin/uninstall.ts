import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return !path || (!path.startsWith("..") && !isAbsolute(path));
};
const canonical = (path: string): string => {
  try { return realpathSync(path); } catch { return resolve(path); }
};

/** Plan before confirmation; never mistake an arbitrary source checkout for an installed app. */
export function uninstallPlan(root: string, data: string) {
  root = canonical(root); data = canonical(data);
  const home = canonical(homedir());
  const marker = join(root, ".git", "openbuild-installed");
  const installed = existsSync(marker) && readMarker(marker) === root;
  if (data === dirname(data) || inside(data, home) || data === root || (inside(data, root) && !installed)) {
    throw new Error("Unsafe data directory: it contains your home or this source checkout. Move the checkout outside it before uninstalling.");
  }
  if (installed && (root === dirname(root) || inside(root, home) || inside(root, data))) {
    throw new Error("Unsafe installation directory.");
  }
  const links = [
    ...["ob", "openbuild"].map(name => join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "bin", name)),
    join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "install", "global", "node_modules", "openbuild"),
  ].filter(path => {
    try { return lstatSync(path).isSymbolicLink() && [root, join(root, "bin", "openbuild.ts")].includes(realpathSync(path)); }
    catch { return false; }
  });
  return { root, data, installed, links };
}

function readMarker(path: string) { try { return readFileSync(path, "utf8").trim(); } catch { return ""; } }

export function removeInstallation(plan: ReturnType<typeof uninstallPlan>) {
  for (const link of plan.links) rmSync(link, { force: true });
  rmSync(plan.data, { recursive: true, force: true });
  if (plan.installed) rmSync(plan.root, { recursive: true, force: true });
}

/** What `ob uninstall` shows before asking: what goes, what stays, wrapped to the terminal. */
export function describeUninstall(plan: ReturnType<typeof uninstallPlan>, { columns = 80, color = false, home = homedir() } = {}) {
  const sgr = (code: string) => (text: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const bold = sgr("1"), dim = sgr("2"), red = sgr("31"), green = sgr("32"), yellow = sgr("33");
  const short = (path: string) => inside(home, path) && path !== home ? `~/${relative(home, path)}` : path;
  const indent = 20;
  const wrap = (text: string) => {
    const width = Math.max(24, Math.min(60, columns - indent - 2)), lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
      if (line && line.length + word.length + 1 > width) { lines.push(line); line = word; }
      else line = line ? `${line} ${word}` : word;
    }
    return [...lines, line];
  };
  // Paths stay whole so they can be copied; prose wraps under its label.
  const row = (sign: string, label: string, value: string, note?: string) => {
    const [first, ...rest] = value.startsWith("/") || value.startsWith("~/") ? [value] : wrap(value);
    return [
      `    ${sign} ${label.padEnd(indent - 6)}${first}`,
      ...rest.map(line => `${" ".repeat(indent)}${line}`),
      ...(note ? wrap(note).map(line => `${" ".repeat(indent)}${dim(line)}`) : []),
    ];
  };
  const gone = red("✕"), kept = green("✓");
  const commands = plan.links.map(link => basename(dirname(link)) === "node_modules" ? "bun global package" : basename(link));
  return [
    "",
    `  ${bold("Uninstall OpenBuild")}`,
    "",
    `  ${dim("Removes")}`,
    ...row(gone, "Data", short(plan.data), "All chats, settings, plugins, scratch projects and managed worktrees, including uncommitted work."),
    ...(plan.installed ? row(gone, "App", short(plan.root)) : []),
    ...(commands.length ? row(gone, "Commands", commands.join(", ")) : []),
    ...row(gone, "Credentials", "saved keys and device pairings"),
    "",
    `  ${dim("Keeps")}`,
    ...(plan.installed ? [] : row(kept, "Source", short(plan.root))),
    ...row(kept, "Projects", "your project folders and native agent sessions"),
    "",
    `  ${yellow("!")} Running agent turns will stop.`,
    "",
  ];
}
