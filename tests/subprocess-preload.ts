// Bun 1.3.8 can stall while asynchronously loading typebox's large module graph in a
// fresh eval process. Load it synchronously before server imports (and test mocks).
// A stalled import otherwise waits for bun:test to SIGTERM the child at its deadline.
//
// A child that spawnScript starts (OPENBUILD_PRELOAD_TRACE=1) also marks on stderr how far it got:
// the preload starting and finishing, and the script starting (spawnScript puts a call to
// __openbuildPreloadMark before it: import declarations are hoisted, so it runs once the script's
// static imports have loaded). spawnScript strips the marks from the stderr it hands back and keeps
// them for the tail it logs when a child is SIGTERMed, so a stuck child shows where it froze.
// Ten seconds in, a mark says the event loop is still turning (a promise that never settles, not a
// blocked thread) and which modules Bun has loaded by then. Nothing here hooks module loading:
// a loader plugin changed Bun 1.3.8's load order enough to break tests (botRole's runner/routes race).
import { writeSync } from "node:fs";

const trace = process.env.OPENBUILD_PRELOAD_TRACE === "1";
// Not for the child's own children: their stderr isn't stripped.
delete process.env.OPENBUILD_PRELOAD_TRACE;

const started = performance.now();
let last = "preload started";
// Synchronous, so a mark is in the pipe before whatever freezes next.
const mark = (what: string) => {
  last = what;
  if (trace) writeSync(2, `[subprocess-preload] +${((performance.now() - started) / 1000).toFixed(3)} s pid ${process.pid}: ${what}\n`);
};

mark("preload started");

if (trace) {
  (globalThis as { __openbuildPreloadMark?: (what: string) => void }).__openbuildPreloadMark = mark;
  setTimeout(() => {
    // Read, not hooked: Bun's registry of the modules it has fetched so far, in the order it got them.
    const registry = (globalThis as { Loader?: { registry?: Map<string, unknown> } }).Loader?.registry;
    const modules = registry ? [...registry.keys()] : Object.keys(require.cache);
    const recent = modules.slice(-4).map((m) => m.replace(`${process.cwd()}/`, "").replace(/^.*\/node_modules\//, ""));
    mark(`still running; last mark: ${last}; ${modules.length} modules loaded, latest ${recent.join(", ")}`);
  }, 10_000).unref();
}

require("typebox");

mark("preload finished");
