// Slash commands for the composer: Pi's own (extension commands, prompt templates, skills) for the
// folder the thread works in, plus a few OpenBuild handles itself.
import { useEffect, useState } from "react";
import type { PiCommand } from "../../shared/types";
import { CommandCache } from "../../shared/commandCache";
import { piCommands } from "./pi";
import { fuzzyScore } from "./search";

export const BUILTIN_COMMANDS: PiCommand[] = [
  { name: "compact", description: "Summarize older messages to free up context", source: "openbuild" },
  { name: "new", description: "Start a new thread", source: "openbuild" },
];

const cache = new CommandCache<PiCommand[]>(60_000);
const cacheKey = (cwd?: string, deviceId?: string) => JSON.stringify([deviceId ?? null, cwd ?? null]);

/** Warm discovery before the first slash; opening the menu also revalidates stale data. */
export function usePiCommands(cwd: string | undefined, enabled: boolean, deviceId?: string, menuOpen = false): PiCommand[] | undefined {
  const key = cacheKey(cwd, deviceId);
  const [loaded, setLoaded] = useState<{ key: string; commands: PiCommand[] }>();
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void cache.get(key, () => piCommands(cwd, deviceId), false).then(
      (commands) => live && setLoaded({ key, commands }),
      () => {}, // Keep the last good list; a later open retries discovery.
    );
    return () => {
      live = false;
    };
  }, [key, enabled, menuOpen]);
  // Never show another workspace/device's commands during the render before the effect runs.
  return enabled ? cache.peek(key) ?? (loaded?.key === key ? loaded.commands : undefined) : undefined;
}

/** Commands matching what's typed after "/", best first. */
export function matchCommands(all: PiCommand[], typed: string): PiCommand[] {
  if (!typed) return all;
  return all
    .map((c) => ({ c, s: c.name.toLowerCase().startsWith(typed.toLowerCase()) ? 1000 - c.name.length : fuzzyScore(`${c.name} ${c.description ?? ""}`, typed) }))
    .filter((x) => x.s !== undefined)
    .sort((a, b) => b.s! - a.s!)
    .map((x) => x.c);
}
