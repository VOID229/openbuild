import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseOf, tagsOfRefNames, type AppRelease } from "../shared/release";
import { releaseTrack, type Track } from "./releases";

// Which release this server is. OpenBuild has no build step that could stamp a version: every
// installation is the repository at a commit, and a release is a commit with a release tag. So the
// tags on the commit are the version, however the code got here:
//   - the installer clones a release tag, and `ob update` fetches one and switches to it;
//   - a source archive of a tag (GitHub's "Source code" downloads) has no .git, but git wrote the
//     commit's ref names into .release-ref as it made the archive (export-subst, .gitattributes);
//   - a development checkout sits on a branch whose tip usually has no release tag: "Dev".

const ROOT = resolve(import.meta.dir, "..");

function tagsAtHead(root: string): string[] {
  // An archive first: unpacked inside some other repository, git would describe that one instead.
  try {
    const refs = readFileSync(join(root, ".release-ref"), "utf8").trim();
    if (refs && !refs.startsWith("$Format")) return tagsOfRefNames(refs);
  } catch { /* Not there: a checkout from before the file existed. */ }
  try {
    const p = Bun.spawnSync(["git", "-C", root, "tag", "--points-at", "HEAD"], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
    return p.exitCode === 0 ? p.stdout.toString().split("\n").filter(Boolean) : [];
  } catch { return []; }
}

/** The release checked out at `root` right now. */
export function readRelease(root = ROOT, track: Track = releaseTrack()): AppRelease {
  return releaseOf(tagsAtHead(root), track);
}

let running: AppRelease | undefined;
/**
 * The release this process is running: read once, when the server starts. An update moves the
 * checkout on while this server keeps running the old code until it restarts.
 */
export function runningRelease(): AppRelease {
  return (running ??= readRelease());
}
