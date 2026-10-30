import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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
