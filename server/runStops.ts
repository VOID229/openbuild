import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { dataDir } from "./paths";
// A Stop can beat the original POST's body/plugin/workspace admission. Remember that intent
// independently of an existing Run, so a late POST cannot silently start the stopped action.
// A short-lived private marker also carries Stop across the server/worker boundary.
const KEEP = 15 * 60 * 1000;
const MAX = 2000;
const hot = globalThis as typeof globalThis & { openbuildRunStops?: Map<string, number> };
const stops = hot.openbuildRunStops ??= new Map<string, number>();

const directory = () => join(dataDir(), "run-stops");
const marker = (id: string) => join(directory(), createHash("sha256").update(id).digest("hex"));

export function requestRunStop(id: string) {
  const now = Date.now();
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  for (const name of readdirSync(directory())) {
    try { if (Number(readFileSync(join(directory(), name), "utf8")) <= now) rmSync(join(directory(), name), { force: true }); } catch {}
  }
  writeFileSync(marker(id), String(now + KEEP), { mode: 0o600 });
  for (const [key, expires] of stops) if (expires <= now) stops.delete(key);
  stops.delete(id);
  stops.set(id, now + KEEP);
  while (stops.size > MAX) stops.delete(stops.keys().next().value!);
}

export function runStopRequested(id: string): boolean {
  let expires = stops.get(id);
  if (expires === undefined) {
    try { expires = Number(readFileSync(marker(id), "utf8")); } catch {}
  }
  if (expires === undefined) return false;
  if (expires <= Date.now()) { stops.delete(id); return false; }
  return true;
}
