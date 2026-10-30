import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataDir } from "./paths";
import { prepareUserPlugins } from "./pluginFiles";

export type Track = "stable" | "nightly";
export interface Release { tag_name: string; prerelease: boolean; draft: boolean; published_at: string; html_url: string }
const ROOT = resolve(import.meta.dir, "..");
const REPO = "https://github.com/VOID229/openbuild.git";
const statePath = () => join(dataDir(), "release-track.json");
export function releaseTrack(): Track {
  try { return JSON.parse(readFileSync(statePath(), "utf8")).track === "nightly" ? "nightly" : "stable"; }
  catch { return "stable"; }
}
export function setReleaseTrack(track: string) {
  if (track !== "stable" && track !== "nightly") throw new Error("Track must be stable or nightly.");
  mkdirSync(dataDir(), { recursive: true });
  const temp = `${statePath()}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ track }) + "\n", { mode: 0o600 });
  renameSync(temp, statePath());
  cache = undefined;
}
export function selectRelease(releases: Release[], track: Track) {
  return releases.filter(r => !r.draft && r.prerelease === (track === "nightly") && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(r.tag_name))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
}
function git(args: string[], root = ROOT) {
  const p = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim() || "Git command failed.");
  return p.stdout.toString().trim();
}
export interface ReleaseStatus { track: Track; current: string; latest?: string; available: boolean; url?: string }
let cache: { track: Track; root: string; until: number; value: Promise<ReleaseStatus> } | undefined;
export function checkRelease(force = false, root = ROOT): Promise<ReleaseStatus> {
  const track = releaseTrack();
  if (!force && cache?.track === track && cache.root === root && cache.until > Date.now()) return cache.value;
  const value = (async () => {
    const releases: Release[] = [];
    const signal = AbortSignal.timeout(10_000);
    // Paginate so a busy prerelease channel cannot hide the latest stable release.
    for (let page = 1; page <= 20; page++) {
      const res = await fetch(`https://api.github.com/repos/VOID229/openbuild/releases?per_page=100&page=${page}`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "OpenBuild" }, signal,
      });
      if (!res.ok) throw new Error(`Release check failed (GitHub HTTP ${res.status}).`);
      const batch = await res.json() as Release[];
      releases.push(...batch);
      if (batch.length < 100) break;
    }
    const latest = selectRelease(releases, track);
    const head = git(["rev-parse", "HEAD"], root);
    let current = head.slice(0, 12);
    try { current = git(["describe", "--tags", "--exact-match", "HEAD"], root); } catch {}
    let available = !!latest && current !== latest.tag_name;
    // Do not suggest downgrading a checkout already ahead of the release.
    if (latest && available && !releases.some(r => r.tag_name === current && r.prerelease !== (track === "nightly"))) {
      try { git(["merge-base", "--is-ancestor", `refs/tags/${latest.tag_name}`, "HEAD"], root); available = false; } catch {}
    }
    return { track, current, latest: latest?.tag_name, available, url: latest?.html_url };
  })();
  cache = { track, root, until: Date.now() + 60 * 60_000, value };
  value.catch(() => { if (cache?.value === value) cache = undefined; });
  return value;
}
export async function installRelease(root = ROOT) {
  if (git(["status", "--porcelain"], root)) throw new Error("Your checkout has local changes. Commit or stash them before updating.");
  const status = await checkRelease(true, root);
  if (!status.latest) throw new Error(`No published ${status.track} releases yet.`);
  if (!status.available) return status;
  // Preserve the old installation’s plugin copies even when updating before the next startup.
  prepareUserPlugins(join(root, "plugins"), join(dataDir(), "plugins"));
  // Fetch from the canonical repository, never an arbitrary checkout remote.
  git(["fetch", REPO, `refs/tags/${status.latest}`], root);
  const target = git(["rev-parse", "FETCH_HEAD^{commit}"], root);
  const previous = git(["rev-parse", "HEAD"], root);
  const install = () => {
    const p = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
    if (p.exitCode !== 0) throw new Error("Dependency installation failed.");
  };
  try {
    // A detached release checkout leaves local branches and commits intact.
    git(["switch", "--detach", target], root);
    install();
  } catch (error) {
    git(["switch", "--detach", previous], root);
    try { install(); } catch {}
    throw error;
  }
  cache = undefined;
  return { ...status, current: status.latest, available: false };
}
