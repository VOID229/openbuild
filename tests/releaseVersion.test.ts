import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { asRelease, latestRelease, nextVersion, nightlyTagFor, parseVersionTag, releaseLabel, releaseOf, tagsOfRefNames } from "../shared/version";
import { findRelease, withPromotion } from "../server/version";

const ROOT = resolve(import.meta.dir, "..");

test("version tags: x.y.z-nightly for every merge, plain x.y.z once stable, and the old nightlies", () => {
  expect(parseVersionTag("0.1.9-nightly")).toMatchObject({ version: "0.1.9", stable: false });
  expect(parseVersionTag("0.1.9")).toMatchObject({ version: "0.1.9", stable: true });
  expect(parseVersionTag("0.1.8-nightly.20261111.275")).toMatchObject({ version: "0.1.8", stable: false });
  for (const tag of ["v0.1.9", "0.1.9-rc.1", "0.1.9-nightly.", "stable", "--evil", "0.1"]) expect(parseVersionTag(tag)).toBeUndefined();
});

test("the newest release on each track, across old and new tags", () => {
  const before = ["0.1.7", "0.1.7-nightly.20261102.123", "0.1.8", "0.1.8-nightly.20261111.274", "0.1.8-nightly.20261111.275", "0.1.7-nightly.2"];
  // Today: the old nightlies came after the release they name.
  expect(latestRelease(before, "stable")?.tag).toBe("0.1.8");
  expect(latestRelease(before, "nightly")?.tag).toBe("0.1.8-nightly.20261111.275");
  // Then every merge is a version, and promoting one adds its plain tag.
  const after = [...before, "0.1.9-nightly", "0.1.10-nightly", "0.1.11-nightly", "0.1.10"];
  expect(latestRelease(after, "nightly")?.tag).toBe("0.1.11-nightly");
  expect(latestRelease(after, "stable")?.tag).toBe("0.1.10");
  // A promoted version is the newest: the nightly track names it by its nightly tag, whatever the order.
  expect(latestRelease(["0.1.10", "0.1.10-nightly"], "nightly")?.tag).toBe("0.1.10-nightly");
  expect(latestRelease(["0.1.10-nightly", "0.1.10"], "nightly")?.tag).toBe("0.1.10-nightly");
  expect(latestRelease(["0.2.0-nightly", "0.1.99"], "stable")?.tag).toBe("0.1.99");
  expect(latestRelease(["0.1.9-nightly"], "stable")).toBeUndefined();
  expect(latestRelease([], "nightly")).toBeUndefined();
});

test("each merge is the next patch, and z rolls over after 99", () => {
  expect(nextVersion(["0.1.8", "0.1.8-nightly.20261111.275"])).toBe("0.1.9");
  expect(nextVersion(["0.1.8", "0.1.9-nightly"])).toBe("0.1.10");
  expect(nextVersion(["0.1.98-nightly", "0.1.99-nightly", "0.1.50"])).toBe("0.2.0");
  expect(nextVersion(["0.2.0-nightly", "0.1.99"])).toBe("0.2.1");
  expect(nextVersion(["1.9.99-nightly"])).toBe("1.10.0");
  expect(() => nextVersion(["something"])).toThrow();
  // A rerun keeps the tag its commit already has.
  expect(nightlyTagFor(["0.1.9-nightly"], ["0.1.9-nightly", "0.1.10-nightly"])).toBe("0.1.9-nightly");
  expect(nightlyTagFor(["0.1.8-nightly.20261111.275"], ["0.1.8-nightly.20261111.275"])).toBe("0.1.9-nightly");
});

test("the label is the channel and x.y.z: stable when the commit has a plain tag", () => {
  const label = (tags: string[]) => { const r = releaseOf(tags); return r && releaseLabel(r); };
  expect(label(["0.1.9-nightly"])).toBe("Nightly 0.1.9");
  expect(label(["0.1.9-nightly", "0.1.9"])).toBe("Stable 0.1.9");
  expect(label(["0.1.8"])).toBe("Stable 0.1.8");
  expect(label(["0.1.8-nightly.20261111.275"])).toBe("Nightly 0.1.8");
  expect(label(["0.1.8", "0.1.8-nightly.20261111.200"])).toBe("Stable 0.1.8");
  expect(label(["some-marker"])).toBeUndefined();
  expect(asRelease({ channel: "nightly", version: "0.1.9" })).toEqual({ channel: "nightly", version: "0.1.9" });
  for (const bad of [{ channel: "dev" }, { channel: "nightly", version: "<b>" }, { channel: "stable" }, undefined]) expect(asRelease(bad)).toBeUndefined();
  expect(tagsOfRefNames("HEAD -> main, tag: 0.1.9-nightly, tag: 0.1.9, origin/main")).toEqual(["0.1.9-nightly", "0.1.9"]);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ob-version-"));
  // Commit dates a second apart, so "newest" doesn't come down to a tie.
  let clock = Date.UTC(2026, 10, 1) / 1000;
  const git = (...args: string[]) => {
    const date = `${clock}`;
    const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    if (p.exitCode !== 0) throw new Error(p.stderr.toString() || p.stdout.toString());
    return p.stdout.toString().trim();
  };
  let n = 0;
  const commit = () => { clock++; n++; writeFileSync(join(dir, `file-${n}`), String(n)); git("add", "-A"); git("commit", "-q", "-m", `commit ${n}`); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  return { dir, git, commit };
}

const label = (root: string) => { const r = findRelease(root)?.release; return r && releaseLabel(r); };

test("a checkout is named after the newest release in its history", () => {
  const { dir, git, commit } = repo();
  try {
    commit();
    expect(findRelease(dir)).toBeUndefined();
    git("tag", "0.1.8");
    expect(label(dir)).toBe("Stable 0.1.8");
    commit();
    git("tag", "0.1.8-nightly.20261111.275");
    expect(label(dir)).toBe("Nightly 0.1.8");
    const nine = commit();
    git("tag", "0.1.9-nightly");
    expect(label(dir)).toBe("Nightly 0.1.9");
    // A development commit after it, past a tag that isn't a release.
    commit();
    git("tag", "some-marker");
    commit();
    expect(findRelease(dir)).toEqual({ release: { channel: "nightly", version: "0.1.9" }, commit: nine });
    // Promoted: a plain tag on the same commit.
    git("tag", "0.1.9", "0.1.9-nightly");
    expect(label(dir)).toBe("Stable 0.1.9");
    // Installed releases are detached at their tag (install.sh, `ob update`).
    git("switch", "-q", "--detach", "0.1.8");
    expect(label(dir)).toBe("Stable 0.1.8");
    expect(findRelease(join(dir, "missing"))).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("across a merge, the newer release wins, whichever side it's on", () => {
  const { dir, git, commit } = repo();
  try {
    commit();
    git("tag", "0.1.8");
    git("switch", "-q", "-c", "side");
    commit();
    git("switch", "-q", "main");
    commit();
    git("tag", "0.1.9-nightly");
    git("switch", "-q", "side");
    commit();
    git("tag", "0.1.10-nightly");
    git("switch", "-q", "main");
    commit();
    git("merge", "-q", "--no-edit", "side");
    expect(git("log", "-1", "--format=%p").split(" ")).toHaveLength(2);
    expect(label(dir)).toBe("Nightly 0.1.10");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a nightly promoted after it was fetched is stable, from the release check's tags", () => {
  const found = { release: { channel: "nightly" as const, version: "0.1.9" }, commit: "abc" };
  expect(withPromotion(found, undefined)).toEqual({ channel: "nightly", version: "0.1.9" });
  expect(withPromotion(found, { "0.1.9-nightly": "abc", "0.1.10-nightly": "def" })).toEqual({ channel: "nightly", version: "0.1.9" });
  expect(withPromotion(found, { "0.1.9-nightly": "abc", "0.1.9": "abc" })).toEqual({ channel: "stable", version: "0.1.9" });
  // Another commit's stable tag says nothing about this one.
  expect(withPromotion(found, { "0.1.8": "zzz" })).toEqual({ channel: "nightly", version: "0.1.9" });
  expect(withPromotion(undefined, { "0.1.8": "zzz" })).toBeUndefined();
});

test("a source archive of a release tag knows its release without a repository", () => {
  const { dir, git, commit } = repo();
  const out = mkdtempSync(join(tmpdir(), "ob-archive-"));
  try {
    // The repository's own attributes and placeholder, so this fails if either stops matching.
    cpSync(join(ROOT, ".gitattributes"), join(dir, ".gitattributes"));
    cpSync(join(ROOT, ".release-ref"), join(dir, ".release-ref"));
    expect(readFileSync(join(dir, ".release-ref"), "utf8")).toStartWith("$Format");
    commit();
    git("tag", "0.1.8");
    const nine = commit();
    git("tag", "0.1.9-nightly");
    const unpack = (ref: string) => {
      const to = mkdtempSync(join(out, "x-"));
      const tar = join(out, "a.tar");
      git("archive", "-o", tar, ref);
      expect(Bun.spawnSync(["tar", "-xf", tar, "-C", to]).exitCode).toBe(0);
      return to;
    };
    expect(findRelease(unpack("0.1.9-nightly"))).toEqual({ release: { channel: "nightly", version: "0.1.9" }, commit: nine });
    expect(label(unpack("0.1.8"))).toBe("Stable 0.1.8");
    git("tag", "0.1.9", nine);
    expect(label(unpack("0.1.9"))).toBe("Stable 0.1.9");
    // An archive of an untagged commit has no history to look back through.
    commit();
    expect(findRelease(unpack("HEAD"))).toBeUndefined();
    // In the checkout the placeholder is untouched, and the history is read from git.
    expect(label(dir)).toBe("Stable 0.1.9");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test("the nightly workflow's tag: the next version for a new commit, the same one on a rerun", () => {
  const { dir, git, commit } = repo();
  const tag = (ref: string) => {
    const p = Bun.spawnSync([process.execPath, join(ROOT, "scripts", "next-version.ts"), ref], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : `failed: ${p.stderr.toString().trim()}`;
  };
  try {
    commit();
    expect(tag("HEAD")).toContain("failed: No version tag");
    git("tag", "0.1.8");
    commit();
    git("tag", "0.1.8-nightly.20261111.275");
    commit();
    expect(tag("HEAD")).toBe("0.1.9-nightly");
    git("tag", "0.1.9-nightly");
    expect(tag("HEAD")).toBe("0.1.9-nightly");
    commit();
    expect(tag("HEAD")).toBe("0.1.10-nightly");
    // Promotion adds no number of its own.
    git("tag", "0.1.9", "0.1.9-nightly");
    expect(tag("HEAD")).toBe("0.1.10-nightly");
    git("tag", "0.1.99-nightly");
    expect(tag("HEAD~1")).toBe("0.1.9-nightly");
    commit();
    expect(tag("HEAD")).toBe("0.2.0-nightly");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
