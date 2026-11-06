// The thread runtimes OpenBuild offers, and which of them are turned on for a device
// (Settings → Runtimes). A turned-off runtime is hidden from the new-thread runtime picker.
import type { RuntimeStatus, ThreadRuntime } from "../../shared/types";
import type { Settings } from "./types";

export const RUNTIMES: { runtime: ThreadRuntime; label: string; desc: string }[] = [
  { runtime: "pi", label: "Default", desc: "Tools and extensions" },
  { runtime: "durable", label: "Durable", desc: "Resumes after crashes" },
  { runtime: "claude", label: "Claude Code", desc: "Anthropic's native coding agent" },
  { runtime: "opencode", label: "OpenCode", desc: "OpenCode's native coding agent" },
  { runtime: "codex", label: "Codex", desc: "OpenAI's native coding agent" },
  { runtime: "cursor", label: "Cursor", desc: "Cursor's native coding agent" },
  { runtime: "hermes", label: "Hermes", desc: "Nous Research’s agent" },
  { runtime: "grok", label: "Grok", desc: "SpaceXAI's native coding agent" },
  { runtime: "fx", label: "fx", desc: "Vercel's coding agent" },
];

/**
 * The runtimes whose releases Settings → Notifications can announce (server/runtimes.ts reports
 * which have an update). Durable runs Pi's own package, so it shares Pi's release and isn't listed twice.
 */
export const UPDATABLE_RUNTIMES: ThreadRuntime[] = RUNTIMES.map((r) => r.runtime).filter((r) => r !== "durable");

/**
 * How tightly the runtime picker sets its rows, so a longer list still fits beside the composer:
 * full two-line rows, then tighter ones, then a single line each. Past that the list scrolls.
 */
export const runtimeMenuDensity = (count: number): "roomy" | "tight" | "dense" =>
  count <= 6 ? "roomy" : count <= 8 ? "tight" : "dense";

/** How a runtime is named in prose (Pi isn't "Default" there). */
export const runtimeName = (runtime: ThreadRuntime): string =>
  runtime === "pi" ? "Pi" : RUNTIMES.find((r) => r.runtime === runtime)?.label ?? runtime;

/** What each runtime's detection found on a device (server/runtimes.ts), once it has been asked. */
export type RuntimeStatuses = Partial<Record<ThreadRuntime, Pick<RuntimeStatus, "installed">>>;

/**
 * The runtimes turned off on a device (undefined = this server). Until the user chooses for that
 * device, the ones its detection didn't find are off and every one it found is on; before anything
 * is known about the device, nothing is turned off (the picker greys out the missing ones once it hears).
 */
export const disabledRuntimes = (settings: Pick<Settings, "disabledRuntimes">, deviceId?: string, statuses?: RuntimeStatuses): ThreadRuntime[] =>
  settings.disabledRuntimes?.[deviceId ?? ""] ?? (statuses ? RUNTIMES.map((r) => r.runtime).filter((r) => !statuses[r]?.installed) : []);

export const runtimeEnabled = (settings: Pick<Settings, "disabledRuntimes">, runtime: ThreadRuntime, deviceId?: string, statuses?: RuntimeStatuses): boolean =>
  !disabledRuntimes(settings, deviceId, statuses).includes(runtime);

/** The settings patch that turns a runtime on or off for a device. */
export function setRuntimeEnabled(settings: Pick<Settings, "disabledRuntimes">, runtime: ThreadRuntime, enabled: boolean, deviceId?: string, statuses?: RuntimeStatuses): Pick<Settings, "disabledRuntimes"> {
  const key = deviceId ?? "";
  const rest = disabledRuntimes(settings, deviceId, statuses).filter((r) => r !== runtime);
  const next = enabled ? rest : [...rest, runtime];
  const map = { ...settings.disabledRuntimes };
  map[key] = next;
  return { disabledRuntimes: map };
}
