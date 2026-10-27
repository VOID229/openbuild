import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CommandResult = { ok: boolean; out: string; err: string };
export type Runner = (command: string, args: string[]) => CommandResult;
export const UNIT = "openbuild.service";

/** Only network settings belong here; leave ExecStart and worker lifecycle untouched. */
export function systemdNetworkOverride(env: Record<string, string>) {
  const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
  return "# Managed by openbuild start [local|lan|tailscale].\n[Service]\n" +
    ["HOST", "OPENCHAT_ALLOWED_HOSTS", "OPENBUILD_PUBLIC_HTTPS"].map((key) => `Environment=${quote(`${key}=${env[key] ?? ""}`)}`).join("\n") + "\n";
}

export function systemdNetworkOverridePath() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user", `${UNIT}.d`, "zz-openbuild-network.conf");
}

/** Only adopt a user service whose executable points at this installation. */
export function systemdService(root: string, run: Runner, platform = process.platform) {
  if (platform !== "linux") return undefined;
  const result = run("systemctl", ["--user", "show", UNIT, "--property=LoadState,ActiveState,ExecStart,KillMode"]);
  if (!result.ok) return undefined;
  const properties = Object.fromEntries(result.out.split("\n").map((line) => {
    const i = line.indexOf("=");
    return [line.slice(0, i), line.slice(i + 1)];
  }));
  if (properties.LoadState !== "loaded") return undefined;
  const executable = properties.ExecStart ?? "";
  // Match complete argv tokens, not a substring of another installation's path.
  const paths = ["server/index.ts", "bin/openbuild.ts"].map((file) => {
    try { return realpathSync(`${root}/${file}`); } catch { return `${root}/${file}`; }
  });
  if (!paths.some((path) => executable.split(/\s+/).includes(path))) return undefined;
  return {
    active: ["active", "activating", "reloading", "deactivating"].includes(properties.ActiveState ?? ""),
    // Detached children remain in the unit's cgroup. Both control-group and
    // mixed kill them on stop/restart; require process-only lifecycle control.
    workerSurvives: properties.KillMode === "process",
  };
}
