import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRelease, installRelease, knownTags, parseLsRemote, releaseTrack, restartServer, restartStatus, selectRelease, setReleaseTrack, watchInstall } from "../server/releases";

const CANONICAL = "https://github.com/VOID229/openbuild.git";

test("ls-remote output: tags to commits, an annotated tag by its peeled commit", () => {
  const tags = parseLsRemote([
    "aaa\trefs/tags/0.1.8",
    "ttt\trefs/tags/0.1.9-nightly",
    "bbb\trefs/tags/0.1.9-nightly^{}",
    "ccc\trefs/heads/main",
    "",
  ].join("\n"));
  expect(tags).toEqual({ "0.1.8": "aaa", "0.1.9-nightly": "bbb" });
  expect(selectRelease({ ...tags, "--evil": "x", "9.9.9-rc.1": "y" }, "stable")).toBe("0.1.8");
  expect(selectRelease(tags, "nightly")).toBe("0.1.9-nightly");
});

/**
 * A stand-in for the canonical repository, and a clone of it whose git sends the canonical URL there,
 * each with its own data directory. Nothing reaches GitHub.
 */
async function withRepos(body: (r: { source: string; checkout: string; git: (repo: string, ...args: string[]) => string; commit: (repo: string) => string }) => Promise<void>) {
  const temp = mkdtempSync(join(tmpdir(), "ob-releases-"));
  const previous = process.env.OPENCHAT_DATA_DIR;
  const source = join(temp, "source"), checkout = join(temp, "checkout");
  const git = (repo: string, ...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  let n = 0;
  const commit = (repo: string) => { writeFileSync(join(repo, `file-${++n}`), String(n)); git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", `commit ${n}`); return git(repo, "rev-parse", "HEAD"); };
  try {
    process.env.OPENCHAT_DATA_DIR = join(temp, "data");
    mkdirSync(source);
    git(source, "init", "-q", "-b", "main");
    commit(source);
    git(source, "tag", "0.1.8");
    git(temp, "clone", "-q", source, checkout);
    git(checkout, "config", `url.${source}.insteadOf`, CANONICAL);
    git(checkout, "switch", "-q", "--detach", "0.1.8");
    setReleaseTrack("stable");
    await body({ source, checkout, git, commit });
  } finally {
    if (previous === undefined) delete process.env.OPENCHAT_DATA_DIR; else process.env.OPENCHAT_DATA_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  }
}

test("tracks: the newest nightly, or the newest version promoted to stable, read from the repository's tags", () => withRepos(async ({ source, checkout, git, commit }) => {
  expect(releaseTrack()).toBe("stable");
  expect(() => setReleaseTrack("typo")).toThrow();
  expect(await checkRelease(true, checkout)).toMatchObject({ track: "stable", current: "0.1.8", latest: "0.1.8", available: false });
  // The old scheme's nightlies are after the release they name.
  commit(source);
  git(source, "tag", "0.1.8-nightly.20261111.275");
  const nine = commit(source);
  git(source, "tag", "0.1.9-nightly");
  expect(await checkRelease(true, checkout)).toMatchObject({ latest: "0.1.8", available: false });
  setReleaseTrack("nightly");
  expect(await checkRelease(true, checkout)).toMatchObject({ current: "0.1.8", latest: "0.1.9-nightly", available: true, url: "https://github.com/VOID229/openbuild/releases/tag/0.1.9-nightly" });

  // Promoting adds a plain tag on the same commit: the stable track's release, and no new nightly.
  git(source, "tag", "0.1.9", nine);
  expect(await checkRelease(true, checkout)).toMatchObject({ latest: "0.1.9-nightly", available: true });
  setReleaseTrack("stable");
  expect(await checkRelease(true, checkout)).toMatchObject({ latest: "0.1.9", available: true });

  // On that commit, both tracks are current, and it's named by the track's tag, even before the
  // checkout has fetched the promotion.
  git(checkout, "fetch", "-q", "--no-tags", "origin", "+refs/tags/0.1.9-nightly:refs/tags/0.1.9-nightly");
  git(checkout, "switch", "-q", "--detach", "0.1.9-nightly");
  expect(await checkRelease(true, checkout)).toMatchObject({ current: "0.1.9", available: false });
  setReleaseTrack("nightly");
  expect(await checkRelease(true, checkout)).toMatchObject({ current: "0.1.9-nightly", available: false });

  // From a newer nightly, the stable track goes back to the stable release; a development commit doesn't.
  commit(source);
  git(source, "tag", "0.1.10-nightly");
  git(checkout, "fetch", "-q", "origin", "+refs/tags/0.1.10-nightly:refs/tags/0.1.10-nightly");
  git(checkout, "switch", "-q", "--detach", "0.1.10-nightly");
  expect(await checkRelease(true, checkout)).toMatchObject({ current: "0.1.10-nightly", available: false });
  setReleaseTrack("stable");
  expect(await checkRelease(true, checkout)).toMatchObject({ current: "0.1.10-nightly", latest: "0.1.9", available: true });
  commit(checkout);
  expect(await checkRelease(true, checkout)).toMatchObject({ latest: "0.1.9", available: false });
  setReleaseTrack("nightly");
  expect(await checkRelease(true, checkout)).toMatchObject({ latest: "0.1.10-nightly", available: false });

  writeFileSync(join(checkout, "local.txt"), "preserve me");
  await expect(installRelease(checkout)).rejects.toThrow("local changes");
}));

test("release checks are saved between processes, and a failure keeps the last known tags", () => withRepos(async ({ source, checkout }) => {
  const path = join(process.env.OPENCHAT_DATA_DIR!, "release-cache.json");
  expect(knownTags()).toBeUndefined();
  expect((await checkRelease(false, checkout)).latest).toBe("0.1.8");
  expect(Object.keys(knownTags()!)).toEqual(["0.1.8"]);
  // The repository is gone: a recent list is still the answer, without asking.
  const away = `${source}-away`;
  renameSync(source, away);
  setReleaseTrack("stable"); // Clears the in-memory copy, as a new process would have none.
  expect((await checkRelease(false, checkout)).latest).toBe("0.1.8");
  // An explicit check asks, and says it failed; background checks then hold off and keep the list.
  await expect(checkRelease(true, checkout)).rejects.toThrow("Release check failed");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  expect(saved.retryAt).toBeGreaterThan(Date.now());
  writeFileSync(path, JSON.stringify({ ...saved, checkedAt: saved.checkedAt - 2 * 60 * 60_000 }));
  setReleaseTrack("stable");
  expect((await checkRelease(false, checkout)).latest).toBe("0.1.8");
  renameSync(away, source);
  expect((await checkRelease(true, checkout)).latest).toBe("0.1.8");
  // A cache from before releases were tags is asked again.
  writeFileSync(path, JSON.stringify({ releases: [], checkedAt: Date.now() }));
  expect(knownTags()).toBeUndefined();
}));

test("updates fetch a release with its tags, keep branches, and roll back after failed dependencies", () => withRepos(async ({ source, checkout, git }) => {
  const command = (args: string[], cwd: string) => {
    const p = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  writeFileSync(join(source, "package.json"), JSON.stringify({ name: "release-fixture", version: "1.0.0" }));
  mkdirSync(join(source, "plugins", "custom"), { recursive: true });
  writeFileSync(join(source, "plugins", "custom", "plugin.json"), "original user plugin");
  command([process.execPath, "install"], source);
  git(source, "add", "."); git(source, "commit", "-q", "-m", "initial"); git(source, "tag", "0.1.9-nightly");
  git(checkout, "fetch", "-q", "origin");
  git(checkout, "switch", "-q", "--detach", "origin/main");
  const branch = "main";
  const originalHead = git(checkout, "rev-parse", branch);
  writeFileSync(join(source, "release.txt"), "new release");
  writeFileSync(join(source, "plugins", "custom", "plugin.json"), "new bundled contents");
  git(source, "add", "."); git(source, "commit", "-q", "-m", "release");
  git(source, "tag", "0.1.10-nightly"); git(source, "tag", "0.1.10");
  setReleaseTrack("stable");
  expect(await installRelease(checkout)).toMatchObject({ current: "0.1.10", installed: true });
  // Both of the version's tags came along, so it's recognised without asking: updating again downloads nothing.
  expect(git(checkout, "tag", "--points-at", "HEAD").split("\n").sort()).toEqual(["0.1.10", "0.1.10-nightly"]);
  expect(await checkRelease(true, checkout)).toMatchObject({ current: "0.1.10", available: false });
  expect(await installRelease(checkout)).toMatchObject({ current: "0.1.10", installed: false });
  expect(readFileSync(join(process.env.OPENCHAT_DATA_DIR!, "plugins", "custom", "plugin.json"), "utf8")).toBe("original user plugin");
  expect(git(checkout, "rev-parse", branch)).toBe(originalHead);
  const installed = git(checkout, "rev-parse", "HEAD");
  writeFileSync(join(source, "package.json"), "{invalid json");
  git(source, "add", "."); git(source, "commit", "-q", "-m", "broken dependencies"); git(source, "tag", "0.1.11-nightly");
  setReleaseTrack("nightly");
  await expect(installRelease(checkout)).rejects.toThrow("Dependency installation failed");
  expect(git(checkout, "rev-parse", "HEAD")).toBe(installed);
}));

test("only an install that moved the checkout waits for a restart, and a failed restart reports its output", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-restart-"));
  const previous = process.env.OPENCHAT_DATA_DIR;
  const commit = () => expect(Bun.spawnSync(["git", "-C", temp, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "next"]).exitCode).toBe(0);
  try {
    process.env.OPENCHAT_DATA_DIR = join(temp, "data");
    expect(Bun.spawnSync(["git", "-C", temp, "init"]).exitCode).toBe(0);
    commit();
    watchInstall(temp)({ code: 0 });
    expect(restartStatus().pending).toBe(false);
    let done = watchInstall(temp);
    commit();
    done({ code: 1 });
    expect(restartStatus().pending).toBe(false);
    done = watchInstall(temp);
    commit();
    done({ code: 0 });
    expect(restartStatus().pending).toBe(true);

    restartServer(["sh", "-c", "echo not this way; exit 3"]);
    expect(restartStatus().error).toBeUndefined();
    for (let i = 0; i < 100 && !restartStatus().error; i++) await Bun.sleep(50);
    expect(restartStatus()).toMatchObject({ pending: true, error: "not this way" });
    // A retry clears the failure and can run again.
    restartServer(["sh", "-c", "exit 0"]);
    expect(restartStatus().error).toBeUndefined();
    await Bun.sleep(600);
    expect(restartStatus().error).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.OPENCHAT_DATA_DIR; else process.env.OPENCHAT_DATA_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

test("curl installer selects a stable tag under sh and bash and only replaces an install when told to", () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-track-installer-"));
  try {
    const { mkdirSync, chmodSync } = require("node:fs");
    const bin = join(temp, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "bun"), '#!/bin/sh\ncase "$*" in *Bun.stdin*) echo 1.2.3;; esac\n');
    writeFileSync(join(bin, "git"), '#!/bin/sh\n[ "$1" = ls-remote ] && exit 0\n[ "$1" = clone ] && [ "$2" = --branch ] && [ "$3" = 1.2.3 ] || exit 1\nfor target do :; done\nmkdir -p "$target/.git"\n');
    chmodSync(join(bin, "bun"), 0o755); chmodSync(join(bin, "git"), 0o755);
    for (const shell of ["sh", "bash"]) {
      const target = join(temp, `${shell} install`);
      const options = { detached: true, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENBUILD_INSTALL_DIR: target }, stdout: "pipe" as const, stderr: "pipe" as const };
      const script = join(import.meta.dir, "..", "install.sh");
      expect(Bun.spawnSync([shell, script], options).exitCode).toBe(0);
      const refused = Bun.spawnSync([shell, script], options);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain("--reinstall");
      writeFileSync(join(target, "stale"), "");
      expect(Bun.spawnSync([shell, script, "--reinstall"], options).exitCode).toBe(0);
      expect(require("node:fs").readdirSync(target).sort()).toEqual([".git"]);
      expect(require("node:fs").readdirSync(temp).filter((name: string) => /\.(new|old)\./.test(name))).toEqual([]);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("curl installer removes a failed checkout so it can be retried", () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-track-installer-"));
  try {
    const { mkdirSync, chmodSync, existsSync } = require("node:fs");
    const bin = join(temp, "bin"); mkdirSync(bin);
    const target = join(temp, "install");
    writeFileSync(join(bin, "bun"), '#!/bin/sh\ncase "$*" in *Bun.stdin*) echo 1.2.3;; install*) echo dependency failure; exit 1;; esac\n');
    writeFileSync(join(bin, "git"), '#!/bin/sh\n[ "$1" = ls-remote ] && exit 0\nfor target do :; done\nmkdir -p "$target/.git"\n');
    chmodSync(join(bin, "bun"), 0o755); chmodSync(join(bin, "git"), 0o755);
    const result = Bun.spawnSync(["sh", join(import.meta.dir, "..", "install.sh")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENBUILD_INSTALL_DIR: target }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("dependency failure");
    expect(existsSync(target)).toBe(false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("curl installer restores the old install when a reinstall fails, and won't replace foreign folders", () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-track-installer-"));
  try {
    const { mkdirSync, chmodSync, existsSync } = require("node:fs");
    const bin = join(temp, "bin"); mkdirSync(bin);
    const target = join(temp, "install");
    mkdirSync(join(target, ".git"), { recursive: true });
    writeFileSync(join(target, "keep"), "");
    writeFileSync(join(bin, "bun"), '#!/bin/sh\ncase "$*" in *Bun.stdin*) echo 1.2.3;; run\\ cli:install|"run cli:install") exit 1;; esac\n');
    writeFileSync(join(bin, "git"), '#!/bin/sh\n[ "$1" = clone ] || { [ -e "$OB_OLD" ] && echo https://github.com/VOID229/openbuild.git; exit 0; }\nfor target do :; done\nmkdir -p "$target/.git"\n');
    chmodSync(join(bin, "bun"), 0o755); chmodSync(join(bin, "git"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENBUILD_INSTALL_DIR: target };
    const script = join(import.meta.dir, "..", "install.sh");
    const foreign = Bun.spawnSync(["sh", script, "--reinstall"], { env, stdout: "pipe", stderr: "pipe" });
    expect(foreign.exitCode).toBe(1);
    expect(foreign.stderr.toString()).toContain("not an OpenBuild install");
    // No marker, but the installer's clone URL: an install from before the marker existed.
    const failed = Bun.spawnSync(["sh", script, "--reinstall"], { env: { ...env, OB_OLD: join(temp, "bin") }, stdout: "pipe", stderr: "pipe" });
    expect(failed.exitCode).toBe(1);
    expect(existsSync(join(target, "keep"))).toBe(true);
    expect(require("node:fs").readdirSync(temp).sort()).toEqual(["bin", "install"]);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("curl installer dry run works piped and touches nothing", () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-track-installer-"));
  try {
    const { mkdirSync, chmodSync, existsSync } = require("node:fs");
    const bin = join(temp, "bin"); mkdirSync(bin);
    for (const name of ["bun", "git"]) { writeFileSync(join(bin, name), "#!/bin/sh\nexit 9\n"); chmodSync(join(bin, name), 0o755); }
    const target = join(temp, "install");
    for (const shell of ["sh", "bash"]) {
      const result = Bun.spawnSync([shell, "-s", "--", "--dry-run"], {
        stdin: Bun.file(join(import.meta.dir, "..", "install.sh")),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENBUILD_INSTALL_DIR: target },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain("Dry run");
      expect(result.stdout.toString()).not.toContain("\x1b");
      expect(existsSync(target)).toBe(false);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
