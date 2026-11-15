import { useEffect } from "react";
import { create } from "zustand";
import { RELEASE_CHECK_EVERY, updateStepOf, type ReleaseCheck, type UpdateStep } from "../../shared/releaseUpdate";
import { followJob } from "./pi";
import { isHosted } from "./runtime";

// Updating OpenBuild from the app: one state for the button beside the version in either sidebar
// (components/ReleaseUpdate.tsx) and the notice at the top of the window (components/Notices.tsx), so
// an update started from one shows in the other.
//
// Nothing is installed here. The server checks the installation's track (`/api/releases`), runs
// `ob update` as a maintenance job (`/api/releases/update`) and `ob restart` (`/api/releases/restart`);
// this asks for those, follows them and says how they went.

/** What the app is doing about it right now. A check only counts when someone asked for it. */
export type UpdatePhase = "idle" | "checking" | "installing" | "restarting";
/** What the button shows: its icon is the refresh for the first two, the download for the next two, the restart for the last two. */
export type UpdateView = "idle" | "checking" | "available" | "installing" | "ready" | "restarting";

export interface UpdateFailure {
  during: "check" | "install" | "restart";
  message: string;
}

interface ReleaseUpdateState {
  /** The server's last answer. */
  info?: ReleaseCheck;
  phase: UpdatePhase;
  /** How far an installing update is. */
  step?: UpdateStep;
  /** What went wrong last, until the next try or a dismissal. */
  failure?: UpdateFailure;
  /** When a check someone asked for last came back. */
  checkedAt?: number;
}

export const useReleaseUpdate = create<ReleaseUpdateState>(() => ({ phase: "idle" }));
const { getState: get, setState: set } = useReleaseUpdate;

export function updateView(s: Pick<ReleaseUpdateState, "info" | "phase">): UpdateView {
  if (s.phase === "restarting" || s.phase === "installing") return s.phase;
  if (s.info?.restart?.pending) return "ready";
  if (s.info?.available) return "available";
  return s.phase === "checking" ? "checking" : "idle";
}

const RESTART_WAIT_MS = 60_000;
/** A turn of the wheel: a check that answers at once still reads as having looked. */
const CHECK_MIN_MS = 700;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ask(fresh: boolean): Promise<ReleaseCheck> {
  const res = await fetch(`/api/releases${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
  const body = (await res.json().catch(() => undefined)) as ReleaseCheck | undefined;
  if (!res.ok || !body || typeof body !== "object") throw new Error(body?.error || "The server didn't answer. Check that OpenBuild is running.");
  return body;
}

/**
 * Asks the server which release is out. `manual` is the button: it always asks the repository, shows
 * as checking, and says so when it fails. Otherwise it's quiet, and the server may answer from a list
 * of releases a few minutes old.
 */
export async function checkRelease(manual = false): Promise<void> {
  // An install or a restart ends with its own look; a check already running is the answer.
  if (get().phase !== "idle") return;
  if (!manual) {
    try {
      const info = await ask(false);
      // An answer that took a while mustn't undo what an install or a restart has learned since.
      if (get().phase === "idle" || get().phase === "checking") adopt(info);
    } catch { /* The next check, or the button, says. */ }
    return;
  }
  set({ phase: "checking", failure: undefined, checkedAt: undefined });
  const started = Date.now();
  try {
    const info = await ask(true);
    await sleep(Math.max(0, CHECK_MIN_MS - (Date.now() - started)));
    if (get().phase !== "checking") return;
    adopt(info, { phase: "idle", checkedAt: Date.now() });
  } catch (error) {
    if (get().phase === "checking") set({ phase: "idle", failure: { during: "check", message: message(error) } });
  }
}

/** Takes the server's answer; an update it says is installing (started in another tab, or before a reload) is followed here too. */
function adopt(info: ReleaseCheck, also?: Partial<ReleaseUpdateState>) {
  set({ ...also, info });
  if (info.updating && get().phase === "idle") void follow(info.updating);
}

/** `ob update`'s own words for why it stopped: what it printed after "openbuild: ", or the end of its output. */
export function updateError(lines: string[]): string {
  const at = lines.findLastIndex((line) => line.startsWith("openbuild: "));
  const said = at < 0 ? lines.slice(-8) : [lines[at]!.slice("openbuild: ".length), ...lines.slice(at + 1)];
  return said.join("\n").trim().slice(-2000);
}

/** Follows the update's job to its end, each step as it starts, then looks at what it left. */
async function follow(job: string) {
  set({ phase: "installing", step: get().step ?? "check", failure: undefined });
  try {
    const output: string[] = [];
    const result = await followJob((line) => {
      const step = updateStepOf(line);
      if (step) set({ step });
      else if (line.trim()) output.push(line.trimEnd());
    }, undefined, undefined, undefined, job);
    if (result?.code !== 0) throw new Error(result ? updateError(output) || `ob update exited with code ${result.code}.` : "Lost the connection to the server while it was updating. Check it before trying again.");
    // Installed: the server now says a restart is pending. If it can't be asked, say what is known.
    const info = await ask(false).catch((): ReleaseCheck => ({ ...get().info, available: false, restart: { pending: true } }));
    set({ info, phase: "idle", step: undefined });
  } catch (error) {
    set({ phase: "idle", step: undefined, failure: { during: "install", message: message(error) } });
    // The server knows how it really ended (or that it's still going, when only the connection dropped).
    void checkRelease();
  }
}

/** Installs the release on offer: the server runs `ob update`. */
export async function installRelease(): Promise<void> {
  if (get().phase !== "idle") return;
  set({ phase: "installing", step: "check", failure: undefined });
  try {
    const res = await fetch("/api/releases/update", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.job) throw new Error(body.error || "Could not start the update.");
    await follow(body.job);
  } catch (error) {
    set({ phase: "idle", step: undefined, failure: { during: "install", message: message(error) } });
  }
}

/** Restarts the server onto the installed release, and reloads this page once it's back. */
export async function restartServer(): Promise<void> {
  if (get().phase !== "idle") return;
  set({ phase: "restarting", failure: undefined });
  try {
    const res = await fetch("/api/releases/restart", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Could not start the restart.");
    // The old server reports a restart that failed; the new one has nothing pending.
    for (const deadline = Date.now() + RESTART_WAIT_MS; Date.now() < deadline;) {
      await sleep(1000);
      const status = await fetch("/api/releases/restart", { cache: "no-store" }).then((r) => (r.ok ? r.json() : undefined)).catch(() => undefined);
      if (status?.error) throw new Error(status.error);
      if (status && !status.pending) return location.reload();
    }
    throw new Error("The server didn't come back. Run ob restart on this server.");
  } catch (error) {
    set({ phase: "idle", failure: { during: "restart", message: message(error) } });
  }
}

export const dismissUpdateFailure = () => set({ failure: undefined });

let watchers = 0;
let stop: (() => void) | undefined;
/**
 * Checks on its own while anything shows the release: now, every RELEASE_CHECK_EVERY, and on coming
 * back to the tab or online. Not while the tab is hidden. One watch, however many ask for it.
 */
export function watchReleases(): () => void {
  if (watchers++ === 0) {
    const check = () => { if (document.visibilityState === "visible") void checkRelease(); };
    check();
    const timer = setInterval(check, RELEASE_CHECK_EVERY);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    stop = () => { clearInterval(timer); document.removeEventListener("visibilitychange", check); window.removeEventListener("online", check); };
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--watchers === 0) { stop?.(); stop = undefined; }
  };
}

/** Keeps the release checked while the calling component is on screen. The website has no server to update. */
export function useReleaseWatch() {
  useEffect(() => (isHosted() ? undefined : watchReleases()), []);
}
