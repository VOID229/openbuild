// Which OpenBuild is running, as the sidebar says it: "Nightly 0.1.9", "Stable 0.1.9" or "Dev".
// A release is a commit with a release tag: a stable one (0.1.9), or a nightly one
// (0.1.9-nightly.<date>.<run>, .github/workflows/nightly.yml). Anything else is a development build.

export type ReleaseChannel = "stable" | "nightly" | "dev";

export interface AppRelease {
  channel: ReleaseChannel;
  /** The release's version without its nightly suffix, e.g. "0.1.9". A dev build has none. */
  version?: string;
}

const DEV: AppRelease = { channel: "dev" };

/** What a tag releases; undefined for one that isn't a stable or nightly release tag. */
export function parseReleaseTag(tag: string): AppRelease | undefined {
  const match = /^v?(\d+\.\d+\.\d+)(-nightly\.[0-9A-Za-z.-]+)?$/.exec(tag.trim());
  return match ? { channel: match[2] ? "nightly" : "stable", version: match[1]! } : undefined;
}

const parts = (version: string) => version.split(".").map(Number);
const newer = (a: string, b: string) => {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
};

/**
 * The release a commit with these tags is. A stable release can share its commit with a nightly:
 * the installation's update track picks between them, and the newest version wins within a channel.
 */
export function releaseOf(tags: string[], track: "stable" | "nightly" = "stable"): AppRelease {
  const releases = tags.map(parseReleaseTag).filter((r): r is AppRelease => !!r);
  const newest = (channel: ReleaseChannel) =>
    releases.filter((r) => r.channel === channel).reduce<AppRelease | undefined>((best, r) => (!best || newer(r.version!, best.version!) ? r : best), undefined);
  return newest(track) ?? newest(track === "stable" ? "nightly" : "stable") ?? DEV;
}

/** The tags in a commit's ref names as `git log --format=%D` prints them: "HEAD -> main, tag: 0.1.9, origin/main". */
export function tagsOfRefNames(refNames: string): string[] {
  return refNames.split(",").map((ref) => ref.trim()).filter((ref) => ref.startsWith("tag: ")).map((ref) => ref.slice(5).trim());
}

/** "Nightly 0.1.9", "Stable 0.1.9", or "Dev". */
export function releaseLabel(release: AppRelease): string {
  if (release.channel === "dev" || !release.version) return "Dev";
  return `${release.channel === "nightly" ? "Nightly" : "Stable"} ${release.version}`;
}

/** A release as it arrives over the wire, or undefined when it isn't one. */
export function asRelease(value: unknown): AppRelease | undefined {
  const r = value as Partial<AppRelease> | null | undefined;
  if (!r || typeof r !== "object") return undefined;
  if (r.channel === "dev") return DEV;
  return (r.channel === "stable" || r.channel === "nightly") && typeof r.version === "string" && /^\d+\.\d+\.\d+$/.test(r.version) ? { channel: r.channel, version: r.version } : undefined;
}
