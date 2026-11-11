import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
// Execute the real shell installer and release-selection JS with fake downloads: `git ls-remote`
// lists `tags`. No network requests, real clones, dependency installs, or global links.
function install(tags: string[], nightly = false, wrapper = false, curlFails = false) {
  const temp = mkdtempSync(join(tmpdir(), "ob-installer-test-"));
  const bin = join(temp, "bin");
  mkdirSync(bin);
  const script = (name: string, code: string) => writeFileSync(join(bin, name), `#!${process.execPath}\n${code}`, { mode: 0o755 });
  script("bun", `
    const args = process.argv.slice(2);
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
        TEST_INSTALLER: join(root, "install.sh"), TEST_CURL_FAIL: curlFails ? "1" : "0" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const read = (name: string) => { try { return readFileSync(join(temp, name), "utf8"); } catch { return undefined; } };
    return { code: result.exitCode, stderr: result.stderr.toString(), tag: read("tag"), track: read("track") };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

// Today's tags: plain stable releases, and the old nightlies after the release they name.
const TODAY = ["0.1.7", "0.1.7-nightly.20261102.123", "0.1.8", "0.1.8-nightly.20261111.274", "0.1.8-nightly.20261111.275", "0.1.7-nightly.2"];
// Then every merge is x.y.z-nightly, and promoting one adds its plain tag.
const LATER = [...TODAY, "0.1.9-nightly", "0.1.10-nightly", "0.1.10", "0.1.11-nightly", "stable", "9.9.9-rc.1", "--evil"];

test("stable installer installs the newest promoted version and saves its update track", () => {
  expect(install(TODAY)).toEqual({ code: 0, stderr: "", tag: "0.1.8", track: "stable" });
  expect(install(LATER)).toEqual({ code: 0, stderr: "", tag: "0.1.10", track: "stable" });
});

test("nightly installer installs the newest version, by its nightly tag when it's also stable", () => {
  expect(install(TODAY, true)).toEqual({ code: 0, stderr: "", tag: "0.1.8-nightly.20261111.275", track: "nightly" });
  expect(install(LATER, true)).toEqual({ code: 0, stderr: "", tag: "0.1.11-nightly", track: "nightly" });
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
  expect(install(LATER, false, true)).toEqual({ code: 0, stderr: "", tag: "0.1.11-nightly", track: "nightly" });
  const failed = install([], false, true, true);
  expect(failed.code).toBe(22);
  expect(failed.tag).toBeUndefined();
});
