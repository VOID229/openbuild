import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RELEASE_CHECK_EVERY, type ReleaseChanges } from "../shared/releaseUpdate";
import { latestRelease, parseVersionTag } from "../shared/version";
import { dataDir } from "./paths";
import { prepareUserPlugins } from "./pluginFiles";

export type Track = "stable" | "nightly";
/** Every tag in the canonical repository, and the commit it names. */
export type RemoteTags = Record<string, string>;
const ROOT = resolve(import.meta.dir, "..");
// Releases come from here, whatever a checkout's origin says. The repository moved from
// VOID229/openbuild, which GitHub redirects: checkouts cloned from there still update from here.
const REPO = "https://github.com/dkod-ai/openbuild.git";
const RELEASES = "https://github.com/dkod-ai/openbuild/releases/tag/";
const statePath = () => join(dataDir(), "release-track.json");
const cachePath = () => join(dataDir(), "release-cache.json");
const FRESH_FOR = 60 * 60_000, RETRY_AFTER = 5 * 60_000;
/**
 * How old a list of tags may be for an open app, which asks every RELEASE_CHECK_EVERY: just under
 * that, so each of its checks asks the repository, and several tabs' checks share one answer.
 */
export const APP_FRESH_FOR = RELEASE_CHECK_EVERY - 30_000;
/** The maintenance job (server/pi/jobs.ts) that runs `ob update` for the app. */
export const UPDATE_JOB = "Updating OpenBuild";
/** A changelog is a tooltip: this many changes, and a count of the rest. */
const CHANGES_SHOWN = 40;
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
/** The release to install on a track (shared/version.ts): the newest version, or the newest stable one. */
export function selectRelease(tags: RemoteTags, track: Track) {
  return latestRelease(Object.keys(tags), track)?.tag;
}
function git(args: string[], root = ROOT) {
  const p = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim() || "Git command failed.");
  return p.stdout.toString().trim();
}
/** `git ls-remote --tags` output as tag → commit. An annotated tag's peeled line (`^{}`) names its commit. */
export function parseLsRemote(out: string): RemoteTags {
  const tags: RemoteTags = {};
  for (const line of out.split("\n")) {
    const [sha, ref] = line.trim().split("\t");
    if (!sha || !ref?.startsWith("refs/tags/")) continue;
    const peeled = ref.endsWith("^{}");
    const name = ref.slice("refs/tags/".length, peeled ? -3 : undefined);
    if (peeled || !(name in tags)) tags[name] = sha;
  }
  return tags;
}
/** Releases are tags, so git lists them: one request, no token, and no API rate limit. */
async function downloadTags(root: string): Promise<RemoteTags> {
  const p = Bun.spawn(["git", "-C", root, "ls-remote", "--tags", REPO], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`Release check failed (${err.trim().split("\n").at(-1) || `git ls-remote exited with ${code}`}).`);
  return parseLsRemote(out);
}
/** Shared by the server and every CLI run, so a burst of them asks once. */
interface ReleaseCache { tags: RemoteTags; checkedAt: number; retryAt?: number; error?: string }
function readCache(): ReleaseCache | undefined {
  try {
    const saved = JSON.parse(readFileSync(cachePath(), "utf8"));
    // A cache from before releases were read from tags has `releases` instead: ask again.
    return saved.tags && typeof saved.tags === "object" ? saved : undefined;
  } catch { return undefined; }
}
function writeCache(value: ReleaseCache) {
  try { writeState(cachePath(), value); } catch { /* The cache only saves requests. */ }
}
/** The canonical repository's tags as last seen, without asking again; undefined before any check. */
export function knownTags(): RemoteTags | undefined {
  const saved = readCache();
  return saved?.checkedAt ? saved.tags : undefined;
}
/**
 * `force` always asks and reports failure. Otherwise a list no older than `freshFor`, or failing that
 * the last one known, is enough, and a failure holds off further requests.
 */
async function listTags(force: boolean, root: string, freshFor = FRESH_FOR) {
  const saved = readCache();
  if (!force && saved) {
    if (saved.retryAt ? saved.retryAt > Date.now() : Date.now() - saved.checkedAt < freshFor) {
      if (saved.checkedAt) return saved.tags;
      throw new Error(saved.error ?? "Release check failed.");
    }
  }
  try {
    const tags = await downloadTags(root);
    writeCache({ tags, checkedAt: Date.now() });
    return tags;
  } catch (error) {
    writeCache({ tags: saved?.tags ?? {}, checkedAt: saved?.checkedAt ?? 0, retryAt: Date.now() + RETRY_AFTER, error: (error as Error).message });
    if (!force && saved?.checkedAt) return saved.tags;
    throw error;
  }
}
export interface ReleaseStatus {
  track: Track; current: string; latest?: string; available: boolean; url?: string;
  /** The checkout's commit, and the commit `latest` names. */
  head: string; target?: string;
}
let cache: { track: Track; root: string; until: number; value: Promise<ReleaseStatus> } | undefined;
export function checkRelease(force = false, root = ROOT, freshFor = FRESH_FOR): Promise<ReleaseStatus> {
  const track = releaseTrack();
  if (!force && cache?.track === track && cache.root === root && cache.until > Date.now()) return cache.value;
  const value = (async () => {
    const tags = await listTags(force, root, freshFor);
    const latest = latestRelease(Object.keys(tags), track);
    const head = git(["rev-parse", "HEAD"], root);
    // HEAD's version: its own tags, and the canonical ones on its commit (a promotion since it was fetched).
    const here = [...new Set([...git(["tag", "--points-at", "HEAD"], root).split("\n").filter(Boolean), ...Object.keys(tags).filter((tag) => tags[tag] === head)])];
    const ours = latestRelease(here, track) ?? latestRelease(here, "nightly");
    const current = ours?.tag ?? here[0] ?? head.slice(0, 12);
    let available = !!latest && tags[latest.tag] !== head && !here.includes(latest.tag);
    // Don't suggest going back to an older commit, except from a nightly to the stable track's release.
    const leavingNightly = track === "stable" && !!ours && !ours.stable;
    if (latest && available && !leavingNightly) {
      try { git(["merge-base", "--is-ancestor", tags[latest.tag]!, "HEAD"], root); available = false; } catch {}
    }
    return { track, current, latest: latest?.tag, available, url: latest && RELEASES + latest.tag, head, target: latest && tags[latest.tag] };
  })();
  // Only spares git calls in a burst: the cache file decides when the repository is asked again.
  cache = { track, root, until: Date.now() + 60_000, value };
  value.catch(() => { if (cache?.value === value) cache = undefined; });
  return value;
}

async function gitAsync(args: string[], root: string, timeout = 60_000) {
  const p = Bun.spawn(["git", "-C", root, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(err.trim().split("\n").at(-1) || `git ${args[0]} exited with ${code}`);
  return out.trim();
}
let changelog: { key: string; value: Promise<ReleaseChanges | undefined> } | undefined;
/**
 * What an available release changes: the subjects of the commits it adds to the checkout, newest
 * first. Every merge to main is one commit and one version, so that is the list of changes.
 *
 * The commits are read with git, like the tags: the release's history is fetched from the canonical
 * repository (the same objects the update then needs, so installing it downloads nothing twice),
 * without a ref of its own, so nothing about the checkout or what names it changes. Asked once per
 * release: every later check answers from memory.
 */
export function releaseChanges(status: ReleaseStatus, root = ROOT): Promise<ReleaseChanges | undefined> {
  const { latest, target, head } = status;
  if (!status.available || !latest || !target) return Promise.resolve(undefined);
  const key = `${root}\n${head}\n${target}`;
  if (changelog?.key === key) return changelog.value;
  const value = (async () => {
    const known = await gitAsync(["cat-file", "-e", `${target}^{commit}`], root).then(() => true, () => false);
    if (!known) await gitAsync(["fetch", "--quiet", "--no-tags", REPO, `refs/tags/${latest}`], root);
    // A merge's own commits aren't changes of their own: only what main itself gained.
    const subjects = (await gitAsync(["log", "--first-parent", "--format=%s", `${head}..${target}`], root)).split("\n").filter(Boolean);
    return { changes: subjects.slice(0, CHANGES_SHOWN), total: subjects.length };
  })();
  changelog = { key, value };
  // A failure isn't kept: the next check tries again.
  value.catch(() => { if (changelog?.value === value) changelog = undefined; });
  return value;
}

/**
 * With `progress`, the caller is told each step. `capture` keeps dependency output off the terminal
 * (the caller owns it, drawing those steps), and puts it in the error if the installation fails.
 */
export async function installRelease(root = ROOT, progress?: (step: "download" | "install", tag: string) => void, capture = !!progress) {
  if (git(["status", "--porcelain"], root)) throw new Error("Your checkout has local changes. Commit or stash them before updating.");
  const status = await checkRelease(true, root);
  if (!status.latest) throw new Error(`No published ${status.track} releases yet.`);
  if (!status.available) return { ...status, installed: false };
  progress?.("download", status.latest);
  // Preserve the old installation’s plugin copies even when updating before the next startup.
  prepareUserPlugins(join(root, "plugins"), join(dataDir(), "plugins"));
  // Fetch from the canonical repository, never an arbitrary checkout remote. Store its tags
  // locally, both of a promoted version's: they name what's installed, to later checks and to the
  // sidebar (server/version.ts), without asking the repository again.
  const tags = await listTags(false, root);
  const sha = tags[status.latest];
  const named = Object.keys(tags).filter((tag) => sha && tags[tag] === sha && parseVersionTag(tag));
  git(["fetch", "--no-tags", REPO, ...new Set([status.latest, ...named].map((tag) => `+refs/tags/${tag}:refs/tags/${tag}`))], root);
  const target = git(["rev-parse", `refs/tags/${status.latest}^{commit}`], root);
  const previous = git(["rev-parse", "HEAD"], root);
  const install = () => {
    const p = Bun.spawnSync([process.execPath, "install", "--frozen-lockfile"], { cwd: root, stdio: capture ? ["ignore", "pipe", "pipe"] : ["inherit", "inherit", "inherit"] });
    if (p.exitCode !== 0) throw new Error(`Dependency installation failed.${capture ? `\n${p.stderr?.toString().trim() ?? ""}` : ""}`);
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
