// Bun 1.3.8 can stall while asynchronously loading typebox's large module graph in a
// fresh eval process. Load it synchronously before server imports (and test mocks).
// A stalled import otherwise waits for bun:test to SIGTERM the child at its deadline.
//
// A child that spawnScript starts (OPENBUILD_PRELOAD_TRACE=1) also marks on stderr how far it got:
// the preload starting and finishing, the entry script being loaded, and each import the script
// itself asks for. spawnScript strips the marks from the stderr it hands back and keeps them for the
// tail it logs when a child is SIGTERMed, so a stuck child shows where it froze. A mark ten seconds
// in says the event loop is still turning (a promise that never settles, not a blocked thread).
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
  // Only the entry script and paths spelled from the repository root (as scripts write them, and the
  // server's own modules don't) call into JS; of those, the script's are the ones the entry imports.
  Bun.plugin({
    name: "subprocess-preload-trace",
    setup(build) {
      build.onResolve({ filter: /^\.\/(?:server|shared|src|scripts|bin|convex|fixtures)\/|\[eval\]$/ }, (args) => {
        if (args.importer === "bun:main") mark(`entry ${args.path.split("/").pop()} loading`);
        else if (args.importer.endsWith("[eval]") || args.importer === Bun.main) mark(`script imports ${args.path}`);
        return undefined;
      });
    },
  });
  setTimeout(() => mark(`still running; last mark: ${last}`), 10_000).unref();
}

require("typebox");

mark("preload finished");
