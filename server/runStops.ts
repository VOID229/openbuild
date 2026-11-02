// A Stop can beat the original POST's body/plugin/workspace admission. Remember that intent
// independently of an existing Run, so a late POST cannot silently start the stopped action.
// Like replayable local runs, intents survive hot reload, not a server-process death.
const KEEP = 15 * 60 * 1000;
const MAX = 2000;
const hot = globalThis as typeof globalThis & { openbuildRunStops?: Map<string, number> };
const stops = hot.openbuildRunStops ??= new Map<string, number>();

export function requestRunStop(id: string) {
  const now = Date.now();
  for (const [key, expires] of stops) if (expires <= now) stops.delete(key);
  stops.delete(id);
  stops.set(id, now + KEEP);
  while (stops.size > MAX) stops.delete(stops.keys().next().value!);
}

export function runStopRequested(id: string): boolean {
  const expires = stops.get(id);
  if (expires === undefined) return false;
  if (expires <= Date.now()) { stops.delete(id); return false; }
  return true;
}
