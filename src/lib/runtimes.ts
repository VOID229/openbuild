// The thread runtimes OpenBuild offers, and which of them are turned on for a device
// (Settings → Runtimes). A turned-off runtime is hidden from the new-thread runtime picker.
import type { ThreadRuntime } from "../../shared/types";
import type { Settings } from "./types";

export const RUNTIMES: { runtime: ThreadRuntime; label: string; desc: string }[] = [
  { runtime: "pi", label: "Default", desc: "Tools and extensions" },
  { runtime: "durable", label: "Durable", desc: "Resumes after crashes" },
  { runtime: "claude", label: "Claude Code", desc: "Anthropic's native coding agent" },
  { runtime: "opencode", label: "OpenCode", desc: "OpenCode's native coding agent" },
  { runtime: "codex", label: "Codex", desc: "OpenAI's native coding agent" },
  { runtime: "cursor", label: "Cursor", desc: "Cursor's native coding agent" },
  { runtime: "fx", label: "fx", desc: "Vercel's coding agent" },
];

/**
 * The runtimes OpenBuild can tell are out of date (server/runtimes.ts asks each one's registry).
 * Durable runs Pi's own package, so it shares Pi's release and isn't listed twice.
 */
export const UPDATABLE_RUNTIMES: ThreadRuntime[] = ["pi", "claude", "codex"];

/** How a runtime is named in prose (Pi isn't "Default" there). */
export const runtimeName = (runtime: ThreadRuntime): string =>
  runtime === "pi" ? "Pi" : RUNTIMES.find((r) => r.runtime === runtime)?.label ?? runtime;

/** The runtimes turned off on a device (undefined = this server). */
export const disabledRuntimes = (settings: Pick<Settings, "disabledRuntimes">, deviceId?: string): ThreadRuntime[] =>
  settings.disabledRuntimes?.[deviceId ?? ""] ?? [];

export const runtimeEnabled = (settings: Pick<Settings, "disabledRuntimes">, runtime: ThreadRuntime, deviceId?: string): boolean =>
  !disabledRuntimes(settings, deviceId).includes(runtime);

/** The settings patch that turns a runtime on or off for a device. */
export function setRuntimeEnabled(settings: Pick<Settings, "disabledRuntimes">, runtime: ThreadRuntime, enabled: boolean, deviceId?: string): Pick<Settings, "disabledRuntimes"> {
  const key = deviceId ?? "";
  const rest = disabledRuntimes(settings, deviceId).filter((r) => r !== runtime);
  const next = enabled ? rest : [...rest, runtime];
  const map = { ...settings.disabledRuntimes };
  if (next.length) map[key] = next;
  else delete map[key];
  return { disabledRuntimes: map };
}
