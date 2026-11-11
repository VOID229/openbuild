import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseOf, tagsOfRefNames, type AppRelease } from "../shared/release";
import { releaseTrack, type Track } from "./releases";

// Which release this server is. OpenBuild has no build step that could stamp a version: every
// installation is the repository at a commit, and a release is a commit with a release tag. So the
// release tags in the commit's history are the version, however the code got here:
//   - the installer clones a release tag, and `ob update` fetches one and switches to it: HEAD is it;
//   - a checkout between releases (a branch, a commit after the last nightly) is named after the
//     newest release in its history;
//   - a source archive has no .git, but git wrote the commit's ref names into .release-ref as it
//     made the archive (export-subst, .gitattributes): an archive of a release tag names it.
// Nothing to go on (an archive of a branch, a history without release tags) shows no label.

const ROOT = resolve(import.meta.dir, "..");

/** The ref names git stamped into a source archive, or undefined in a checkout (still the placeholder). */
function archiveRefs(root: string): string | undefined {
  try {
    const refs = readFileSync(join(root, ".release-ref"), "utf8").trim();
    return refs.startsWith("$Format") ? undefined : refs;
  } catch { return undefined; /* Not there: a checkout from before the file existed. */ }
}

/** The newest commit in HEAD's history with a release tag, newest by commit date, never an ancestor before its descendant. */
function fromHistory(root: string, track: Track): AppRelease | undefined {
  try {
    const p = Bun.spawnSync(
      ["git", "-C", root, "log", "--date-order", "--simplify-by-decoration", "--decorate-refs=refs/tags/", "--format=%D", "HEAD"],
      { stdout: "pipe", stderr: "ignore", timeout: 10_000 },
    );
    if (p.exitCode !== 0) return undefined;
    for (const line of p.stdout.toString().split("\n")) {
      const release = releaseOf(tagsOfRefNames(line), track);
      if (release) return release;
    }
  } catch { /* No git: nothing to name it by. */ }
}

/** The release checked out at `root` right now; undefined when nothing names one. */
export function readRelease(root = ROOT, track: Track = releaseTrack()): AppRelease | undefined {
  // An archive first: unpacked inside some other repository, git would describe that one instead.
  const refs = archiveRefs(root);
  return refs !== undefined ? releaseOf(tagsOfRefNames(refs), track) : fromHistory(root, track);
}

let read = false;
let running: AppRelease | undefined;
/**
 * The release this process is running: read once, when the server starts. An update moves the
 * checkout on while this server keeps running the old code until it restarts.
 */
export function runningRelease(): AppRelease | undefined {
  if (!read) { running = readRelease(); read = true; }
  return running;
}
