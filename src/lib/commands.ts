// Slash commands for the composer: Pi's own (extension commands, prompt templates, skills) for the
// folder the thread works in, plus a few OpenBuild handles itself.
import { useEffect, useState } from "react";
import type { PiCommand } from "../../shared/types";
import { piCommands } from "./pi";
import { fuzzyScore } from "./search";

export const BUILTIN_COMMANDS: PiCommand[] = [
  { name: "compact", description: "Summarize older messages to free up context", source: "openbuild" },
  { name: "new", description: "Start a new thread", source: "openbuild" },
];

const cache = new Map<string, { at: number; value: Promise<PiCommand[]> }>();

function load(cwd: string | undefined): Promise<PiCommand[]> {
  const key = cwd ?? "";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
  const value = piCommands(cwd).catch(() => {
    cache.delete(key);
    return [] as PiCommand[];
  });
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Pi's commands for `cwd`, loaded the first time the composer needs them (`active`). */
export function usePiCommands(cwd: string | undefined, active: boolean): PiCommand[] | undefined {
  const [commands, setCommands] = useState<PiCommand[]>();
  useEffect(() => {
    if (!active) return;
    let live = true;
    void load(cwd).then((c) => live && setCommands(c));
    return () => {
      live = false;
    };
  }, [cwd, active]);
  return commands;
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
