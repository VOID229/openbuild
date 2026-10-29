// Which thread runtimes this device can run: a quick look for each one's installed program (no
// spawning), so the new-thread runtime picker can grey out the ones a device doesn't have.
import type { RuntimeAvailability, RuntimeStatus, ThreadRuntime } from "../shared/types";
import * as piInstall from "./pi/install";
import * as fx from "./fx/install";
import * as codex from "./codex/install";
import * as cursor from "./cursor/install";
import * as claude from "./claude/install";
import * as opencode from "./opencode-agent/install";
import { packageRoot, piBin } from "./pi/install";
import { FX_INSTALL, fxBin } from "./fx/install";
import { CODEX_INSTALL, codexBin } from "./codex/install";
import { CURSOR_INSTALL, cursorBin } from "./cursor/install";
import { CLAUDE_INSTALL, claudeBin } from "./claude/install";
import { OPENCODE_INSTALL, opencodeBin } from "./opencode-agent/install";

const PI_INSTALL = "curl -fsSL https://pi.dev/install.sh | sh";

export function runtimes(): Record<ThreadRuntime, RuntimeAvailability> {
  const pi = !!piBin();
  return {
    pi: { installed: pi, install: PI_INSTALL },
    // Durable runs Pi's SDK in-process, so it needs Pi's package, not just a `pi` on PATH.
    durable: { installed: pi && !!packageRoot(), install: PI_INSTALL },
    claude: { installed: !!claudeBin(), install: CLAUDE_INSTALL },
    codex: { installed: !!codexBin(), install: CODEX_INSTALL },
    cursor: { installed: !!cursorBin(), install: CURSOR_INSTALL },
    fx: { installed: !!fxBin(), install: FX_INSTALL },
    opencode: { installed: !!opencodeBin() || !!process.env.OPENCODE_SERVER_URL, install: OPENCODE_INSTALL },
  };
}

/** Only server-owned commands. A remote OpenCode endpoint is not a local installation. */
export function runtimeUpdateCommand(runtime: ThreadRuntime, all = false): string[] {
  const bin = {
    pi: piBin, durable: piBin, claude: claudeBin, codex: codexBin,
    cursor: cursorBin, fx: fxBin, opencode: opencodeBin,
  }[runtime]();
  if (!bin || (runtime === "durable" && !packageRoot())) throw new Error(`${runtime} isn't installed locally`);
  switch (runtime) {
    case "pi":
    case "durable": return [bin, "update", all ? "--all" : "--self"];
    case "claude": return [bin, "update"];
    case "codex": return codex.codexUpdateCommand(bin);
    case "cursor": return ["sh", "-c", CURSOR_INSTALL];
    case "fx": return ["sh", "-c", FX_INSTALL];
    case "opencode": return ["sh", "-c", OPENCODE_INSTALL];
  }
}

/** An installer exiting zero is not enough: the selected executable must actually be current. */
export function assertRuntimeUpdated(status: RuntimeStatus): void {
  if (!status.installed || !status.version) throw new Error("Couldn't verify the updated runtime executable.");
  if (status.checkError) throw new Error(status.checkError);
  if (status.updateAvailable) throw new Error(`Update did not update the executable OpenBuild uses (${status.bin ?? "unknown path"}): still ${status.version}, latest ${status.latest}.`);
}

// ------------------------------------------------------------------ detailed status (Settings → Runtimes)


/** npm packages whose `latest` tells whether a runtime has an update (runtimes without one aren't checked). */
const NPM_PACKAGE: Partial<Record<ThreadRuntime, string>> = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code" };
const latestCache = new Map<string, { at: number; value: Promise<{ version?: string; error?: string }> }>();
function npmLatest(pkg: string, fresh: boolean): Promise<{ version?: string; error?: string }> {
  const hit = latestCache.get(pkg);
  if (!fresh && hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.value;
  const value: Promise<{ version?: string; error?: string }> = fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(10_000) })
    .then(async (r) => (r.ok ? { version: ((await r.json()) as { version?: string }).version } : { error: `npm answered HTTP ${r.status}` }))
    .catch((e: Error) => ({ error: `Couldn't check for updates: ${e.message}` }));
  latestCache.set(pkg, { at: Date.now(), value });
  return value;
}

/** "codex-cli 0.48.0" → "0.48.0"; keeps the raw text when there's no dotted version in it. */
const semver = (v?: string) => (v ? /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(v)?.[0] ?? v.trim() : undefined);

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} didn't answer within ${ms / 1000}s`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

type Probe = { installed: boolean; bin?: string; version?: string; connected?: string[]; error?: string };

type StatusResults = Record<ThreadRuntime, RuntimeStatus>;
let statusCache: { at: number; value: Promise<StatusResults> } | undefined;

/** Drop both settled and in-flight snapshots; old probes cannot repopulate this cache. */
export function forgetRuntimeStatus(): void {
  statusCache = undefined;
  latestCache.clear();
  piInstall.forgetLatestVersion();
}

/** Cache detailed probes for a minute, sharing in-flight work for ordinary requests. */
export function runtimeStatus(fresh = false): Promise<StatusResults> {
  if (!fresh && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  const value = probeRuntimeStatus(fresh);
  statusCache = { at: Date.now(), value };
  value.catch(() => { if (statusCache?.value === value) statusCache = undefined; });
  return value;
}

/** Everything Settings → Runtimes shows: installed, version, update, sign-in and errors, per runtime. */
async function probeRuntimeStatus(fresh: boolean): Promise<StatusResults> {
  const avail = runtimes();
  // Pi and Durable share an installation; probe and check its release only once.
  const piStatus = avail.pi.installed ? piInstall.status(fresh) : undefined;
  const probes: Record<ThreadRuntime, () => Promise<Probe>> = {
    pi: async () => {
      const s = (await piStatus)!;
      return { installed: s.installed, bin: s.bin, version: s.version };
    },
    durable: async () => {
      const s = (await piStatus)!;
      const root = piInstall.packageRoot();
      return { installed: s.installed && !!root, bin: root, version: s.version, error: s.installed && !root ? "Pi is installed, but its SDK package wasn't found" : undefined };
    },
    fx: () => fx.status(),
    codex: () => codex.status(),
    cursor: () => cursor.status(),
    claude: () => claude.status(),
    opencode: () => opencode.status(),
  };
  const entries = await Promise.all(
    (Object.keys(probes) as ThreadRuntime[]).map(async (id): Promise<[ThreadRuntime, RuntimeStatus]> => {
      const base: RuntimeStatus = { installed: avail[id].installed, install: avail[id].install, updateAvailable: false };
      if (!base.installed) return [id, base];
      let probe: Probe;
      try {
        probe = await withTimeout(probes[id](), 35_000, id);
      } catch (e) {
        return [id, { ...base, error: e instanceof Error ? e.message : String(e) }];
      }
      const version = semver(probe.version);
      let latest: string | undefined, checkError: string | undefined;
      if (id === "pi" || id === "durable") {
        const s = (await piStatus)!;
        latest = s.latest;
        checkError = s.checkError;
      } else if (NPM_PACKAGE[id]) {
        const l = await npmLatest(NPM_PACKAGE[id]!, fresh);
        latest = l.version;
        checkError = l.error;
      }
      return [
        id,
        {
          ...base,
          installed: probe.installed,
          bin: probe.bin,
          version,
          latest,
          checkError,
          updateAvailable: !!version && !!latest && piInstall.compareVersions(latest, version) > 0,
          signedIn: probe.connected === undefined ? undefined : probe.connected.length > 0,
          error: probe.error ? String(probe.error).replace(/^Error: /, "").slice(0, 600) : undefined,
        },
      ];
    }),
  );
  return Object.fromEntries(entries) as Record<ThreadRuntime, RuntimeStatus>;
}
