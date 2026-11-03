import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GITHUB_SCOPE } from "../shared/types";
import { dataDir } from "./paths";
import { prepareUserPlugins } from "./pluginFiles";
import { secrets } from "./vault";

export type Track = "stable" | "nightly";
export interface Release { tag_name: string; prerelease: boolean; draft: boolean; published_at: string; html_url: string }
const ROOT = resolve(import.meta.dir, "..");
const REPO = "https://github.com/VOID229/openbuild.git";
const statePath = () => join(dataDir(), "release-track.json");
const cachePath = () => join(dataDir(), "release-cache.json");
const FRESH_FOR = 60 * 60_000, RETRY_AFTER = 5 * 60_000, PER_PAGE = 100;
function writeState(path: string, value: unknown) {
  mkdirSync(dataDir(), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}
export function releaseTrack(): Track {
  try { return JSON.parse(readFileSync(statePath(), "utf8")).track === "nightly" ? "nightly" : "stable"; }
  catch { return "stable"; }
}
export function setReleaseTrack(track: string) {
  if (track !== "stable" && track !== "nightly") throw new Error("Track must be stable or nightly.");
  writeState(statePath(), { track });
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
/** A token raises GitHub's limit from 60 to 5,000 requests an hour. The repository is public, so none is required. */
async function githubToken() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  const saved = await secrets(GITHUB_SCOPE).catch(() => [] as string[]);
  if (saved[0]) return saved[0];
  const gh = Bun.which("gh", { PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin` });
  if (!gh) return undefined;
  try {
    const p = Bun.spawn([gh, "auth", "token", "--hostname", "github.com"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5_000 });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim() || undefined : undefined;
  } catch { return undefined; }
}
/** Shared by the server and every CLI run, which otherwise each spend their own requests. Holds no token. */
interface ReleaseCache { releases: Release[]; checkedAt: number; etag?: string; retryAt?: number; error?: string }
function readCache(): ReleaseCache | undefined {
  try {
    const saved = JSON.parse(readFileSync(cachePath(), "utf8"));
    return Array.isArray(saved.releases) ? saved : undefined;
  } catch { return undefined; }
}
function writeCache(value: ReleaseCache) {
  try { writeState(cachePath(), value); } catch { /* The cache only saves requests. */ }
}
class ReleaseCheckFailure extends Error { constructor(message: string, readonly retryAt: number) { super(message); } }
function failure(res: Response, authenticated: boolean) {
  const retryAfter = Number(res.headers.get("retry-after")) * 1000;
  const reset = res.headers.get("x-ratelimit-remaining") === "0" ? Number(res.headers.get("x-ratelimit-reset")) * 1000 : 0;
  const message = `Release check failed (GitHub HTTP ${res.status}).`;
  if (!retryAfter && !reset && res.status !== 429) return new ReleaseCheckFailure(message, Date.now() + RETRY_AFTER);
  const retryAt = retryAfter ? Date.now() + retryAfter : reset || Date.now() + RETRY_AFTER;
  const hint = authenticated ? "" : " The limit is shared by everyone on your network or VPN; run gh auth login or set GITHUB_TOKEN to raise it.";
  return new ReleaseCheckFailure(`${message} GitHub's rate limit lifts at ${new Date(retryAt).toLocaleTimeString()}.${hint}`, retryAt);
}
async function downloadReleases(saved?: ReleaseCache): Promise<ReleaseCache> {
  const token = await githubToken();
  const signal = AbortSignal.timeout(10_000);
  const known = new Set(saved?.releases.map(r => r.tag_name));
  const releases: Release[] = [];
  let etag: string | undefined;
  // Paginate so a busy prerelease channel cannot hide the latest stable release.
  for (let page = 1; page <= 20; page++) {
    const get = (auth?: string) => fetch(`https://api.github.com/repos/VOID229/openbuild/releases?per_page=${PER_PAGE}&page=${page}`, {
      headers: {
        Accept: "application/vnd.github+json", "User-Agent": "OpenBuild",
        ...(page === 1 && saved?.etag ? { "If-None-Match": saved.etag } : {}),
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      }, signal,
    });
    let res = await get(token);
    // A token GitHub refuses or has exhausted must not lock anyone out of a public repository.
    const refused = !!token && !res.ok && res.status !== 304 && res.status < 500;
    if (refused) res = await get();
    // Unchanged. With a token GitHub doesn't count this against the limit.
    if (res.status === 304 && saved) return { releases: saved.releases, etag: saved.etag, checkedAt: Date.now() };
    if (!res.ok) throw failure(res, !!token && !refused);
    if (page === 1) etag = res.headers.get("etag") ?? undefined;
    const batch = await res.json() as Release[];
    // Drafts are only visible with a token, and are never installed.
    releases.push(...batch.filter(r => !r.draft).map(({ tag_name, prerelease, draft, published_at, html_url }) => ({ tag_name, prerelease, draft, published_at, html_url })));
    if (batch.length < PER_PAGE) break;
    // The rest of the list is already saved: only what changed since then needs fetching.
    if (batch.some(r => known.has(r.tag_name))) {
      const fetched = new Set(releases.map(r => r.tag_name));
      const oldest = Math.min(...releases.map(r => Date.parse(r.published_at)));
      releases.push(...saved!.releases.filter(r => !fetched.has(r.tag_name) && Date.parse(r.published_at) < oldest));
      break;
    }
  }
  return { releases, etag, checkedAt: Date.now() };
}
/** `force` always asks GitHub and reports failure. Otherwise a recent or last-known list is enough, and a failure holds off further requests. */
async function listReleases(force: boolean) {
  const saved = readCache();
  if (!force && saved) {
    if (saved.retryAt ? saved.retryAt > Date.now() : Date.now() - saved.checkedAt < FRESH_FOR) {
      if (saved.checkedAt) return saved.releases;
      throw new Error(saved.error ?? "Release check failed.");
    }
  }
  try {
    const fetched = await downloadReleases(saved);
    writeCache(fetched);
    return fetched.releases;
  } catch (error) {
    writeCache({ releases: saved?.releases ?? [], etag: saved?.etag, checkedAt: saved?.checkedAt ?? 0, retryAt: error instanceof ReleaseCheckFailure ? error.retryAt : Date.now() + RETRY_AFTER, error: (error as Error).message });
    if (!force && saved?.checkedAt) return saved.releases;
    throw error;
  }
}
export interface ReleaseStatus { track: Track; current: string; latest?: string; available: boolean; url?: string }
let cache: { track: Track; root: string; until: number; value: Promise<ReleaseStatus> } | undefined;
export function checkRelease(force = false, root = ROOT): Promise<ReleaseStatus> {
  const track = releaseTrack();
  if (!force && cache?.track === track && cache.root === root && cache.until > Date.now()) return cache.value;
  const value = (async () => {
    const releases = await listReleases(force);
    const latest = selectRelease(releases, track);
    const head = git(["rev-parse", "HEAD"], root);
    // A stable release can share its commit with a nightly: name HEAD by its track's tag, and
    // treat it as current when any of its tags is the latest, so it isn't installed again.
    const tags = git(["tag", "--points-at", "HEAD"], root).split("\n").filter(Boolean);
    const onTrack = (tag: string) => releases.some(r => r.tag_name === tag && r.prerelease === (track === "nightly"));
    const current = (latest && tags.includes(latest.tag_name) ? latest.tag_name : tags.find(onTrack) ?? tags[0]) ?? head.slice(0, 12);
    let available = !!latest && current !== latest.tag_name;
    // Do not suggest downgrading a checkout already ahead of the release.
    if (latest && available && !releases.some(r => r.tag_name === current && r.prerelease !== (track === "nightly"))) {
      try { git(["merge-base", "--is-ancestor", `refs/tags/${latest.tag_name}`, "HEAD"], root); available = false; } catch {}
    }
    return { track, current, latest: latest?.tag_name, available, url: latest?.html_url };
  })();
  // Only spares git calls in a burst: the file above decides when GitHub is asked again.
  cache = { track, root, until: Date.now() + 60_000, value };
  value.catch(() => { if (cache?.value === value) cache = undefined; });
  return value;
}
/** With `progress`, the caller owns the terminal, so dependency output stays captured. */
export async function installRelease(root = ROOT, progress?: (step: "download" | "install", tag: string) => void) {
  if (git(["status", "--porcelain"], root)) throw new Error("Your checkout has local changes. Commit or stash them before updating.");
  const status = await checkRelease(true, root);
  if (!status.latest) throw new Error(`No published ${status.track} releases yet.`);
  if (!status.available) return { ...status, installed: false };
  progress?.("download", status.latest);
  // Preserve the old installation’s plugin copies even when updating before the next startup.
  prepareUserPlugins(join(root, "plugins"), join(dataDir(), "plugins"));
  // Fetch from the canonical repository, never an arbitrary checkout remote. Store the tag
  // locally: checkRelease names the installed version with `git describe`, so without it
  // every later check would see an untagged HEAD and download the same release again.
  git(["fetch", REPO, `+refs/tags/${status.latest}:refs/tags/${status.latest}`], root);
  const target = git(["rev-parse", `refs/tags/${status.latest}^{commit}`], root);
  const previous = git(["rev-parse", "HEAD"], root);
  const install = () => {
    const p = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], { cwd: root, stdio: progress ? ["ignore", "pipe", "pipe"] : ["inherit", "inherit", "inherit"] });
    if (p.exitCode !== 0) throw new Error(`Dependency installation failed.${progress ? `\n${p.stderr?.toString().trim() ?? ""}` : ""}`);
  };
  try {
    // A detached release checkout leaves local branches and commits intact.
    git(["switch", "--detach", target], root);
    progress?.("install", status.latest);
    install();
  } catch (error) {
    git(["switch", "--detach", previous], root);
    try { install(); } catch {}
    throw error;
  }
  cache = undefined;
  return { ...status, current: status.latest, available: false, installed: true };
}

// Held in memory: the server that starts next is already running what was installed.
let installedHead: string | undefined;
let restarting = false;
let restartError: string | undefined;
export const restartStatus = () => ({ pending: !!installedHead, head: installedHead, error: restartError });
/** Call before an install; the result, given the finished job, notes whether this server now runs old code. */
export function watchInstall(root = ROOT) {
  const before = git(["rev-parse", "HEAD"], root);
  return ({ code }: { code?: number }) => {
    // The install ran in another process, so this one's check still describes the old checkout.
    cache = undefined;
    const head = git(["rev-parse", "HEAD"], root);
    if (code === 0 && head !== before) installedHead = head;
  };
}
/** Runs `openbuild restart` outside this server, which it stops. Its output goes to a file, since a pipe would break with us. */
export function restartServer(command = [process.execPath, join(ROOT, "bin", "openbuild.ts"), "restart"]) {
  if (restarting) return;
  restarting = true;
  restartError = undefined;
  const failed = (message: string) => { restarting = false; restartError = message; };
  // The response has to reach the client first.
  setTimeout(() => {
    try {
      mkdirSync(dataDir(), { recursive: true });
      const path = join(dataDir(), "restart.log");
      const log = openSync(path, "w");
      const child = spawn(command[0]!, command.slice(1), { env: { ...process.env, NO_COLOR: "1" }, detached: true, stdio: ["ignore", log, log] });
      closeSync(log);
      child.unref();
      child.on("error", (error) => failed(error.message));
      child.on("close", (code) => {
        if (code === 0) restarting = false;
        else failed(readFileSync(path, "utf8").trim().slice(-12000) || `openbuild restart exited with code ${code}.`);
      });
    } catch (error) { failed((error as Error).message); }
  }, 300);
}
