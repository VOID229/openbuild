// Ori Harness (OpenRouter's `ori`): `ori claude` / `ori codex` launch the real CLI with OpenRouter's
// endpoint, credential and model catalog injected, passing every argument after `--` through. The
// Claude SDK and Codex's app-server take one executable path, so an Ori account runs a small shim
// that OpenBuild writes per harness. OpenBuild never reads Ori's credentials: `ori login` keeps them.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { dataDir } from "./paths";

export const ORI_INSTALL = "curl -fsSL https://openrouter.ai/labs/ori/install.sh | bash";
export const ORI_LOGIN = "ori login";
/** The OpenBuild runtimes Ori can launch as account runtimes. */
export const ORI_HARNESSES = ["claude", "codex"] as const;
export type OriHarness = (typeof ORI_HARNESSES)[number];

export function oriBin(): string | undefined {
  if (process.env.ORI_BIN) return existsSync(process.env.ORI_BIN) ? process.env.ORI_BIN : undefined;
  return Bun.which("ori", { PATH: `${join(homedir(), ".local/bin")}:${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` }) ?? undefined;
}

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
/** The shim's text: Ori finds the harness on PATH, so a chosen binary's directory goes first. */
export function oriShimScript(harness: OriHarness, ori: string, real?: string): string {
  return [
    "#!/bin/sh",
    `# Written by OpenBuild: runs ${harness} through Ori Harness (OpenRouter).`,
    ...(real ? [`PATH=${quote(dirname(real))}:"$PATH"`, "export PATH"] : []),
    `exec ${quote(ori)} ${harness} -- "$@"`,
    "",
  ].join("\n");
}

/** An executable that runs `ori <harness> -- …`, rewritten only when its text changes. */
export function oriShim(harness: OriHarness, real?: string, dir = join(dataDir(), "ori")): string {
  if (process.platform === "win32") throw new Error("Running through Ori isn't supported on Windows yet.");
  const ori = oriBin();
  if (!ori) throw new Error(`Ori isn't installed on this device. Install it with: ${ORI_INSTALL}, then run \`${ORI_LOGIN}\`.`);
  const script = oriShimScript(harness, ori, real);
  const path = join(dir, `${harness}-${createHash("sha256").update(script).digest("hex").slice(0, 12)}`);
  let current = "";
  try { current = readFileSync(path, "utf8"); } catch {}
  if (current !== script) {
    mkdirSync(dir, { recursive: true });
    // Write beside and rename, so a session starting at the same moment never runs half a script.
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, script, { mode: 0o755 });
    chmodSync(temp, 0o755);
    renameSync(temp, path);
  }
  return path;
}
