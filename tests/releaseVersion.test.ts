import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { asRelease, parseReleaseTag, releaseLabel, releaseOf, tagsOfRefNames } from "../shared/release";
import { readRelease } from "../server/version";

const ROOT = resolve(import.meta.dir, "..");

test("the label is the channel and the version, without the nightly's date and run", () => {
  expect(releaseLabel(parseReleaseTag("0.1.9-nightly.20261111.275")!)).toBe("Nightly 0.1.9");
  expect(releaseLabel(parseReleaseTag("0.1.9")!)).toBe("Stable 0.1.9");
  expect(releaseLabel(parseReleaseTag("v1.12.0")!)).toBe("Stable 1.12.0");
  expect(releaseOf([])).toBeUndefined();
  expect(releaseOf(["some-tag", "0.1.9-rc.1", "--evil"])).toBeUndefined();
});

test("a commit that is both a stable release and a nightly is named by the update track", () => {
  const tags = ["0.1.9-nightly.20261111.275", "0.1.9"];
  expect(releaseOf(tags, "stable")).toEqual({ channel: "stable", version: "0.1.9" });
  expect(releaseOf(tags, "nightly")).toEqual({ channel: "nightly", version: "0.1.9" });
  // Only the other track's tag is here: it's still what's running.
  expect(releaseOf(["0.1.9-nightly.20261111.275"], "stable")).toEqual({ channel: "nightly", version: "0.1.9" });
  expect(releaseOf(["0.1.9"], "nightly")).toEqual({ channel: "stable", version: "0.1.9" });
  // A rerun can tag one commit twice.
  expect(releaseOf(["0.1.9-nightly.20261111.275", "0.1.10-nightly.20261111.276"], "nightly")?.version).toBe("0.1.10");
});

test("what the server sends is checked before it's shown", () => {
  expect(asRelease({ channel: "nightly", version: "0.1.9" })).toEqual({ channel: "nightly", version: "0.1.9" });
  expect(asRelease({ channel: "dev" })).toBeUndefined();
  expect(asRelease({ channel: "nightly", version: "<b>" })).toBeUndefined();
  expect(asRelease({ channel: "stable" })).toBeUndefined();
  expect(asRelease(undefined)).toBeUndefined();
});

test("ref names from a source archive give its tags", () => {
  expect(tagsOfRefNames("HEAD -> main, tag: 0.1.9-nightly.20261111.275, tag: 0.1.9, origin/main")).toEqual(["0.1.9-nightly.20261111.275", "0.1.9"]);
  expect(tagsOfRefNames("HEAD -> main")).toEqual([]);
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
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  let n = 0;
  const commit = () => { clock++; n++; writeFileSync(join(dir, `file-${n}`), String(n)); git("add", "-A"); git("commit", "-q", "-m", `commit ${n}`); };
  git("init", "-q", "-b", "main");
  return { dir, git, commit };
}

const label = (release: ReturnType<typeof readRelease>) => release && releaseLabel(release);

test("a checkout is named after the newest release tag in its history", () => {
  const { dir, git, commit } = repo();
  try {
    commit();
    // No release anywhere in its history: nothing to show.
    expect(readRelease(dir, "stable")).toBeUndefined();
    git("tag", "0.1.8");
    expect(label(readRelease(dir, "stable"))).toBe("Stable 0.1.8");
    // A development commit after it: still built on 0.1.8.
    commit();
    expect(label(readRelease(dir, "nightly"))).toBe("Stable 0.1.8");
    git("tag", "0.1.9-nightly.20261111.276");
    expect(label(readRelease(dir, "nightly"))).toBe("Nightly 0.1.9");
    commit();
    // A tag that isn't a release is passed over.
    git("tag", "some-marker");
    commit();
    expect(label(readRelease(dir, "stable"))).toBe("Nightly 0.1.9");
    // A commit tagged both ways is named by the track, in history as on HEAD.
    git("tag", "0.1.9-nightly.20261112.277");
    git("tag", "0.1.9");
    commit();
    expect(label(readRelease(dir, "stable"))).toBe("Stable 0.1.9");
    expect(label(readRelease(dir, "nightly"))).toBe("Nightly 0.1.9");
    // Installed releases are detached at their tag (install.sh, `ob update`).
    git("switch", "-q", "--detach", "0.1.8");
    expect(label(readRelease(dir, "nightly"))).toBe("Stable 0.1.8");
    // Not a repository at all.
    expect(readRelease(join(dir, "missing"), "stable")).toBeUndefined();
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
    git("tag", "0.1.9-nightly.20261111.276");
    git("switch", "-q", "side");
    commit();
    git("tag", "0.1.9-nightly.20261111.277");
    git("switch", "-q", "main");
    commit();
    git("merge", "-q", "--no-edit", "side");
    expect(git("log", "-1", "--format=%p").split(" ")).toHaveLength(2);
    expect(readRelease(dir, "nightly")).toEqual({ channel: "nightly", version: "0.1.9" });
    // The older tag is on the first parent's side; the newer one, from the branch, still names it.
    git("tag", "-d", "0.1.9-nightly.20261111.277");
    git("tag", "0.1.10-nightly.20261111.277", "side");
    expect(label(readRelease(dir, "nightly"))).toBe("Nightly 0.1.10");
  } finally { rmSync(dir, { recursive: true, force: true }); }
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
    commit();
    git("tag", "0.1.9-nightly.20261111.276");
    const unpack = (ref: string) => {
      const to = mkdtempSync(join(out, "x-"));
      const tar = join(out, "a.tar");
      git("archive", "-o", tar, ref);
      expect(Bun.spawnSync(["tar", "-xf", tar, "-C", to]).exitCode).toBe(0);
      return to;
    };
    expect(label(readRelease(unpack("0.1.9-nightly.20261111.276"), "stable"))).toBe("Nightly 0.1.9");
    expect(label(readRelease(unpack("0.1.8"), "stable"))).toBe("Stable 0.1.8");
    // An archive of an untagged commit has no history to look back through.
    commit();
    expect(readRelease(unpack("HEAD"), "stable")).toBeUndefined();
    // In the checkout the placeholder is untouched, and the history is read from git.
    expect(label(readRelease(dir, "nightly"))).toBe("Nightly 0.1.9");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test("nightlies are prereleases of the patch after the latest stable release", () => {
  const { dir, git, commit } = repo();
  const tag = (ref: string, run: string) => {
    const p = Bun.spawnSync(["bash", join(ROOT, "scripts", "nightly-tag.sh"), ref, run], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : `failed: ${p.stderr.toString().trim()}`;
  };
  try {
    commit();
    expect(tag("HEAD", "1")).toContain("No stable version tag");
    git("tag", "0.1.7");
    commit();
    git("tag", "0.1.8");
    // The nightlies of old, named after the release behind them, don't count as stable.
    git("tag", "0.1.8-nightly.20261111.275");
    commit();
    const date = git("show", "-s", "--format=%cs", "HEAD").replaceAll("-", "");
    expect(tag("HEAD", "276")).toBe(`0.1.9-nightly.${date}.276`);
    expect(releaseLabel(parseReleaseTag(tag("HEAD", "276"))!)).toBe("Nightly 0.1.9");
    // The release commit's own nightly already heads for the next one.
    expect(tag("0.1.8", "277")).toStartWith("0.1.9-nightly.");
    git("tag", "0.1.9");
    expect(tag("HEAD", "278")).toStartWith("0.1.10-nightly.");
    git("tag", "v1.9.99");
    expect(tag("HEAD", "279")).toStartWith("v1.9.100-nightly.");
    // A stable tag on another branch isn't in this commit's history.
    expect(tag("0.1.7", "280")).toStartWith("0.1.8-nightly.");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
