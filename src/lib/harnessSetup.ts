// The startup check for the harnesses OpenBuild and OpenBots run on, on the server this browser is
// connected to (never a paired device): which ones /api/runtimes found, what is missing, and Pi's
// install from the popup that says so (src/components/HarnessSetup.tsx).
import { create } from "zustand";
import type { RuntimeAvailability, ThreadRuntime } from "../../shared/types";

/** Where Pi explains itself; the popup and the bots chat's setup notice both link to it. */
export const PI_SITE = "https://pi.dev";

/** The harnesses OpenBuild can run threads on. Hermes, fx and Durable (which is Pi) don't count. */
export const SUPPORTED_HARNESSES = ["pi", "codex", "claude", "opencode", "grok", "cursor"] as const satisfies readonly ThreadRuntime[];

/** What /api/runtimes says per runtime: whether its program was found, and how to install it. */
export type Availability = Partial<Record<ThreadRuntime, Pick<RuntimeAvailability, "installed"> & Partial<Pick<RuntimeAvailability, "install">>>>;

/** What the server's detection said: not answered yet, couldn't be asked, or a confirmed answer. */
export type Detection = { state: "loading" } | { state: "error"; error: string } | { state: "ready"; runtimes: Availability };

/**
 * What the popup warns about: no supported harness at all ("none", which means Pi too), or only Pi,
 * which OpenBots needs ("pi"). Nothing while detection is loading or failed, since only a confirmed
 * answer counts as missing, and nothing once Pi is installed: a provider to sign in to is the bots
 * chat's own notice (PiSetupNotice).
 */
export type HarnessNeed = "none" | "pi";

export function harnessNeed(detection: Detection): HarnessNeed | undefined {
  // An answer that doesn't mention Pi isn't a confirmed "missing" either.
  if (detection.state !== "ready" || !detection.runtimes.pi) return undefined;
  const installed = (r: ThreadRuntime) => detection.runtimes[r]?.installed === true;
  if (installed("pi")) return undefined;
  return SUPPORTED_HARNESSES.some(installed) ? "pi" : "none";
}

/** The supported harnesses that are installed, for naming what threads can still run on. */
export const installedHarnesses = (runtimes: Availability): ThreadRuntime[] => SUPPORTED_HARNESSES.filter((r) => runtimes[r]?.installed === true);

/** Where Pi's install from the popup is: not started, running, asking the server again afterwards, finished or failed. */
export type InstallPhase = { phase: "idle" } | { phase: "installing" } | { phase: "checking" } | { phase: "done" } | { phase: "failed"; error: string };

export interface InstallSteps {
  /** Starts Pi's installer on the server; resolves with its maintenance job's id. */
  start: () => Promise<{ job: string }>;
  /** Follows that job to its end; undefined when the server no longer has it. */
  follow: (job: string) => Promise<{ code?: number } | undefined>;
  /** Asks the server's detection afresh whether Pi is installed now. */
  check: () => Promise<boolean>;
  onPhase: (phase: InstallPhase) => void;
}

/**
 * Install Pi, then check rather than trust the installer: only the server finding `pi` counts as
 * done. A Pi that's already there (installed from a terminal meanwhile) is done too. Every failure
 * says why, for the popup's retry.
 */
export async function installPiAndCheck({ start, follow, check, onPhase }: InstallSteps): Promise<InstallPhase> {
  const end = (phase: InstallPhase) => (onPhase(phase), phase);
  onPhase({ phase: "installing" });
  let result: { code?: number } | undefined;
  let refused: string | undefined;
  try {
    result = await follow((await start()).job);
  } catch (err) {
    refused = (err as Error).message || String(err);
  }
  onPhase({ phase: "checking" });
  let installed: boolean;
  try {
    installed = await check();
  } catch (err) {
    return end({ phase: "failed", error: `Couldn't check whether Pi is installed now: ${(err as Error).message || err}` });
  }
  if (installed) return end({ phase: "done" });
  if (refused) return end({ phase: "failed", error: refused });
  if (result?.code !== undefined && result.code !== 0) return end({ phase: "failed", error: `Pi's installer failed (exit code ${result.code}).` });
  return end({ phase: "failed", error: "Pi's installer finished, but OpenBuild still can't find the pi program. It may have been installed somewhere OpenBuild doesn't look." });
}

const dismissKey = (server?: string) => `openbuild:harness-setup-dismissed:${server ?? ""}`;

/** Closed once on this server in this tab: not shown again until the next visit, so it can't loop. */
export function wasDismissed(server?: string): boolean {
  try {
    return sessionStorage.getItem(dismissKey(server)) === "1";
  } catch {
    return false;
  }
}

export function rememberDismissed(server?: string) {
  try {
    sessionStorage.setItem(dismissKey(server), "1");
  } catch {
    // Without storage it still stays closed until a reload.
  }
}

/** Whether the popup is showing, so the app behind it can be made inert. */
export const useHarnessSetupOpen = create<{ open: boolean }>(() => ({ open: false }));
