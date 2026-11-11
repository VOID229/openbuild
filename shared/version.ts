// OpenBuild's versions, as tags. Every merge to main is the next version, tagged x.y.z-nightly
// (.github/workflows/nightly.yml); promoting one to stable adds a plain x.y.z tag on the same commit
// (.github/workflows/promote.yml). So a plain tag is a stable release, from the tags alone.
//
// Tags from before this scheme keep their meaning: plain x.y.z tags were the stable releases, and
// x.y.z-nightly.<date>.<run> nightlies came after the x.y.z they name.

export type ReleaseChannel = "stable" | "nightly";

/** What the sidebar shows: "Nightly 0.1.9" or "Stable 0.1.9". */
export interface AppRelease {
  channel: ReleaseChannel;
  /** x.y.z, without a nightly suffix. */
  version: string;
}

export interface VersionTag {
  tag: string;
  /** x.y.z. */
  version: string;
  /** A plain x.y.z tag: a stable release. */
  stable: boolean;
  /** Sorts versions: x, y, z, then an old-style nightly after the release it names, by date and run. */
  key: number[];
}

/** After z = 99 the next version is the next y, at z = 0. */
const LAST_PATCH = 99;
const TAG = /^(\d+)\.(\d+)\.(\d+)(-nightly(?:\.(\d+(?:\.\d+)*))?)?$/;

/** A version tag, or undefined for any other tag. */
export function parseVersionTag(tag: string): VersionTag | undefined {
  const m = TAG.exec(tag);
  if (!m) return undefined;
  const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const old = m[5]?.split(".").map(Number);
  return { tag, version: `${x}.${y}.${z}`, stable: !m[4], key: [x, y, z, old ? 1 : 0, ...(old ?? [])] };
}

export function compareVersions(a: VersionTag, b: VersionTag): number {
  for (let i = 0; i < Math.max(a.key.length, b.key.length); i++) {
    const d = (a.key[i] ?? -1) - (b.key[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

/**
 * The newest release on a track among these tags: any version for nightly, a plain one for stable.
 * A promoted version is tagged both ways on one commit; the nightly track names it by its nightly tag.
 */
export function latestRelease(tags: Iterable<string>, track: ReleaseChannel): VersionTag | undefined {
  let best: VersionTag | undefined;
  for (const tag of tags) {
    const v = parseVersionTag(tag);
    if (!v || (track === "stable" && !v.stable)) continue;
    const d = best ? compareVersions(v, best) : 1;
    if (d > 0 || (d === 0 && !v.stable)) best = v;
  }
  return best;
}

/** The version after the newest one tagged: 0.1.8 → 0.1.9, 0.1.99 → 0.2.0. */
export function nextVersion(tags: Iterable<string>): string {
  const latest = latestRelease(tags, "nightly");
  if (!latest) throw new Error("No version tag to count on from.");
  const [x, y, z] = latest.key as [number, number, number];
  return z >= LAST_PATCH ? `${x}.${y + 1}.0` : `${x}.${y}.${z + 1}`;
}

/** The tag for a commit merged to main: the one it already has (a rerun), or the next version's. */
export function nightlyTagFor(tagsAtCommit: Iterable<string>, allTags: Iterable<string>): string {
  for (const tag of tagsAtCommit) if (/^\d+\.\d+\.\d+-nightly$/.test(tag)) return tag;
  return `${nextVersion(allTags)}-nightly`;
}

/** The release a commit with these tags is: stable if it has a plain version tag. */
export function releaseOf(tags: Iterable<string>): AppRelease | undefined {
  const list = [...tags];
  const v = latestRelease(list, "stable") ?? latestRelease(list, "nightly");
  return v && { channel: v.stable ? "stable" : "nightly", version: v.version };
}

/** The tags in a commit's ref names as `git log --format=%D` prints them: "HEAD -> main, tag: 0.1.9, origin/main". */
export function tagsOfRefNames(refNames: string): string[] {
  return refNames.split(",").map((ref) => ref.trim()).filter((ref) => ref.startsWith("tag: ")).map((ref) => ref.slice(5).trim());
}

/** "Nightly" or "Stable". */
export function channelName(channel: AppRelease["channel"]): string {
  return channel === "nightly" ? "Nightly" : "Stable";
}

/** "Nightly 0.1.9" or "Stable 0.1.9". */
export function releaseLabel(release: AppRelease): string {
  return `${channelName(release.channel)} ${release.version}`;
}

/** A release as it arrives over the wire, or undefined when it isn't one. */
export function asRelease(value: unknown): AppRelease | undefined {
  const r = value as Partial<AppRelease> | null | undefined;
  if (!r || typeof r !== "object") return undefined;
  return (r.channel === "stable" || r.channel === "nightly") && typeof r.version === "string" && /^\d+\.\d+\.\d+$/.test(r.version) ? { channel: r.channel, version: r.version } : undefined;
}
