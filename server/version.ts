import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseVersionTag, releaseOf, tagsOfRefNames, type AppRelease } from "../shared/version";
import { knownTags, type RemoteTags } from "./releases";

// Which release this server is. OpenBuild has no build step that could stamp a version: every
// installation is the repository at a commit, and a release is a commit with a version tag
// (shared/version.ts). So the tags in the commit's history are the version, however it got here:
//   - the installer clones a release tag, and `ob update` fetches one and switches to it: HEAD is it;
//   - a checkout between releases (a branch, a commit after the last nightly) is named after the
//     newest release in its history;
//   - a source archive has no .git, but git wrote the commit and its ref names into .release-ref as
//     it made the archive (export-subst, .gitattributes): an archive of a release tag names it.
// Nothing to go on (an archive of an untagged commit, a history without releases) shows no label.

const ROOT = resolve(import.meta.dir, "..");

/** The release, and the commit whose tags name it. */
export interface Found { release: AppRelease; commit?: string }

/** What git stamped into a source archive ("<commit> <ref names>"), or undefined in a checkout (still the placeholder). */
function fromArchive(root: string): Found | undefined | null {
  let stamped: string;
  try { stamped = readFileSync(join(root, ".release-ref"), "utf8").trim(); } catch { return null; }
  if (stamped.startsWith("$Format")) return null;
  const [commit, ...refs] = stamped.split(" ");
  const release = releaseOf(tagsOfRefNames(refs.join(" ")));
  return release && { release, commit };
}

/** The newest commit in HEAD's history with a version tag: newest by commit date, never an ancestor before its descendant. */
function fromHistory(root: string): Found | undefined {
  try {
    const p = Bun.spawnSync(
      ["git", "-C", root, "log", "--date-order", "--simplify-by-decoration", "--decorate-refs=refs/tags/", "--format=%H %D", "HEAD"],
      { stdout: "pipe", stderr: "ignore", timeout: 10_000 },
    );
    if (p.exitCode !== 0) return undefined;
    for (const line of p.stdout.toString().split("\n")) {
      const [commit, ...refs] = line.split(" ");
      const release = releaseOf(tagsOfRefNames(refs.join(" ")));
      if (release) return { release, commit };
    }
  } catch { /* No git: nothing to name it by. */ }
}

/** The release checked out at `root` right now, as its own tags say. */
export function findRelease(root = ROOT): Found | undefined {
  // An archive first: unpacked inside some other repository, git would describe that one instead.
  const archived = fromArchive(root);
  return archived === null ? fromHistory(root) : archived;
}

/** A nightly promoted since it was fetched: the canonical repository has a plain tag on its commit now. */
export function withPromotion(found: Found | undefined, remote: RemoteTags | undefined): AppRelease | undefined {
  if (!found || found.release.channel === "stable" || !found.commit || !remote) return found?.release;
  for (const [tag, commit] of Object.entries(remote)) {
    const v = commit === found.commit ? parseVersionTag(tag) : undefined;
    if (v?.stable) return { channel: "stable", version: v.version };
  }
  return found.release;
}

let running: { found: Found | undefined } | undefined;
/**
 * The release this process is running. Its commit is read once, when the server starts: an update
 * moves the checkout on while this server keeps running the old code until it restarts. Whether that
 * commit has since been promoted to stable comes from the release check's list of tags.
 */
export function currentRelease(): AppRelease | undefined {
  running ??= { found: findRelease() };
  return withPromotion(running.found, knownTags());
}
