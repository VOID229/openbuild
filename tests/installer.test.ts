import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
// Execute the real shell installer and release-selection JS with fake downloads: `git ls-remote`
// lists `tags`. No network requests, real clones, dependency installs, or global links.
// `bun` reports `bun.version` (1.4.4 unless given), and `bun upgrade` moves it to `bun.upgradesTo`
// or, without one, fails the way a Homebrew-installed Bun does.
function install(tags: string[], nightly = false, wrapper = false, curlFails = false, bun: { version?: string; upgradesTo?: string } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "ob-installer-test-"));
  const bin = join(temp, "bin");
  mkdirSync(bin);
  const script = (name: string, code: string) => writeFileSync(join(bin, name), `#!${process.execPath}\n${code}`, { mode: 0o755 });
  writeFileSync(join(temp, "bun-version"), bun.version ?? "1.4.4");
  script("bun", `
    const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
    const args = process.argv.slice(2);
    appendFileSync(process.env.TEST_BUN_CALLS, args[0] + "\\n");
    if (args[0] === "--version") { console.log(readFileSync(process.env.TEST_BUN_VERSION, "utf8")); process.exit(0); }
    if (args[0] === "upgrade") {
      if (!process.env.TEST_BUN_UPGRADE) { console.error("error: Bun was installed with Homebrew; run brew upgrade bun"); process.exit(1); }
      writeFileSync(process.env.TEST_BUN_VERSION, process.env.TEST_BUN_UPGRADE);
      process.exit(0);
    }
    if (args[0] !== "-e") process.exit(0);
    const result = Bun.spawnSync([process.execPath, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exit(result.exitCode);
  `);
  script("git", `
    const { mkdirSync, writeFileSync } = require("node:fs");
    const args = process.argv.slice(2);
    if (args[0] === "ls-remote") {
      if (args.at(-1) !== "https://github.com/VOID229/openbuild.git" || !args.includes("--tags")) process.exit(2);
      for (const tag of JSON.parse(process.env.TEST_TAGS)) console.log("0123abcd\\trefs/tags/" + tag);
      process.exit(0);
    }
    if (args[0] !== "clone") process.exit(1);
    writeFileSync(process.env.TEST_TAG, args[2]);
    const target = args.at(-1);
    mkdirSync(target + "/.git", { recursive: true });
    mkdirSync(target + "/server");
    writeFileSync(target + "/server/releases.ts", 'export function setReleaseTrack(track) { require("node:fs").writeFileSync(process.env.TEST_TRACK, track); }');
  `);
  script("curl", `
    if (process.env.TEST_CURL_FAIL === "1") process.exit(22);
    const args = process.argv.slice(2);
    require("node:fs").copyFileSync(process.env.TEST_INSTALLER, args[args.indexOf("-o") + 1]);
  `);
  try {
    const result = Bun.spawnSync(["sh", join(root, wrapper ? "nightly/install.sh" : "install.sh"), ...(nightly ? ["--nightly"] : [])], {
      env: { ...process.env, GH_TOKEN: "test-token", PATH: `${bin}:${process.env.PATH}`, CI: "1", OPENBUILD_INSTALL_DIR: join(temp, "app"),
        TEST_TAGS: JSON.stringify(tags), TEST_TAG: join(temp, "tag"), TEST_TRACK: join(temp, "track"),
        TEST_INSTALLER: join(root, "install.sh"), TEST_CURL_FAIL: curlFails ? "1" : "0",
        TEST_BUN_VERSION: join(temp, "bun-version"), TEST_BUN_CALLS: join(temp, "bun-calls"), TEST_BUN_UPGRADE: bun.upgradesTo ?? "" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const read = (name: string) => { try { return readFileSync(join(temp, name), "utf8"); } catch { return undefined; } };
    const upgraded = read("bun-calls")?.split("\n").includes("upgrade") ?? false;
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), tag: read("tag"), track: read("track"), upgraded };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

// Today's tags: plain stable releases, and the old nightlies after the release they name.
const TODAY = ["0.1.7", "0.1.7-nightly.20261102.123", "0.1.8", "0.1.8-nightly.20261111.274", "0.1.8-nightly.20261111.275", "0.1.7-nightly.2"];
// Then every merge is x.y.z-nightly, and promoting one adds its plain tag.
const LATER = [...TODAY, "0.1.9-nightly", "0.1.10-nightly", "0.1.10", "0.1.11-nightly", "stable", "9.9.9-rc.1", "--evil"];

test("stable installer installs the newest promoted version and saves its update track", () => {
  expect(install(TODAY)).toMatchObject({ code: 0, stderr: "", tag: "0.1.8", track: "stable" });
  expect(install(LATER)).toMatchObject({ code: 0, stderr: "", tag: "0.1.10", track: "stable" });
});

test("nightly installer installs the newest version, by its nightly tag when it's also stable", () => {
  expect(install(TODAY, true)).toMatchObject({ code: 0, stderr: "", tag: "0.1.8-nightly.20261111.275", track: "nightly" });
  expect(install(LATER, true)).toMatchObject({ code: 0, stderr: "", tag: "0.1.11-nightly", track: "nightly" });
  expect(install(["0.1.10", "0.1.10-nightly", "0.1.9-nightly"], true).tag).toBe("0.1.10-nightly");
  expect(install(["0.1.99-nightly", "0.2.0-nightly", "0.1.100-nightly.1"], true).tag).toBe("0.2.0-nightly");
});

test("a track with nothing to install fails instead of falling back to the other", () => {
  const stable = install(["0.1.9-nightly", "0.1.10-nightly"]);
  expect(stable.code).toBe(1);
  expect(stable.stderr).toContain("Could not find a published stable release");
  expect(stable.tag).toBeUndefined();
  expect(stable.track).toBeUndefined();
  const nightly = install(["stable", "v1.0.0"], true);
  expect(nightly.code).toBe(1);
  expect(nightly.stderr).toContain("Could not find a published nightly release");
});

test("nightly URL entry point selects nightly and stops on download failure", () => {
  expect(install(LATER, false, true)).toMatchObject({ code: 0, stderr: "", tag: "0.1.11-nightly", track: "nightly" });
  const failed = install([], false, true, true);
  expect(failed.code).toBe(22);
  expect(failed.tag).toBeUndefined();
});

test("a new enough Bun is used as it is", () => {
  for (const version of ["1.4.0", "1.4.4", "1.10.0", "2.0.0", "1.5.0-canary.3+abc"]) {
    const result = install(TODAY, false, false, false, { version });
    expect({ version, code: result.code, stderr: result.stderr, tag: result.tag, upgraded: result.upgraded }).toEqual({ version, code: 0, stderr: "", tag: "0.1.8", upgraded: false });
    expect(result.stdout).not.toContain("Upgraded Bun");
  }
});

test("a Bun older than 1.4 is upgraded before installing", () => {
  for (const version of ["1.3.8", "1.3.12", "1.2.0", "0.9.9"]) {
    const result = install(TODAY, false, false, false, { version, upgradesTo: "1.4.4" });
    expect({ version, code: result.code, stderr: result.stderr, tag: result.tag, upgraded: result.upgraded }).toEqual({ version, code: 0, stderr: "", tag: "0.1.8", upgraded: true });
    expect(result.stdout).toContain(`Upgraded Bun from ${version} to 1.4.4.`);
  }
});

test("a Bun older than 1.4 that can't be upgraded stops the install and says how to upgrade it", () => {
  for (const bun of [{ version: "1.3.8" }, { version: "1.3.8", upgradesTo: "1.3.14" }, { version: "garbage" }]) {
    const result = install(TODAY, false, false, false, bun);
    expect(result.code).toBe(1);
    expect(result.upgraded).toBe(true);
    expect(result.tag).toBeUndefined();
    expect(result.track).toBeUndefined();
    expect(result.stderr).toContain("OpenBuild needs Bun 1.4 or newer");
    expect(result.stderr).toContain("brew upgrade bun");
    expect(result.stderr).toContain("then run this installer again");
  }
  expect(install(TODAY, false, false, false, { version: "1.3.8" }).stderr).toContain("is 1.3.8 and `bun upgrade` could not update it");
});
