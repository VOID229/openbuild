import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const release = (tag_name: string, prerelease: boolean, published_at = "2026-10-01", draft = false) => ({ tag_name, prerelease, published_at, draft });

// Execute the real shell installer and release-selection JS with fake downloads.
// No network requests, real clones, dependency installs, or global links.
function install(pages: unknown[][], nightly = false, wrapper = false, curlFails = false) {
  const temp = mkdtempSync(join(tmpdir(), "ob-installer-test-"));
  const bin = join(temp, "bin");
  mkdirSync(bin);
  const script = (name: string, code: string) => writeFileSync(join(bin, name), `#!${process.execPath}\n${code}`, { mode: 0o755 });
  script("bun", `
    const args = process.argv.slice(2);
    if (args[0] !== "-e") process.exit(0);
    if (args[1].includes('const track =')) {
      args[1] = 'globalThis.fetch = async (url) => { const pages = JSON.parse(process.env.TEST_PAGES); const page = Number(new URL(url).searchParams.get("page") || 1); return {ok:true, json:async () => url.endsWith("/latest") ? pages[0][0] : (pages[page-1] || [])}; };\\n' + args[1];
    }
    const result = Bun.spawnSync([process.execPath, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    process.exit(result.exitCode);
  `);
  script("git", `
    const { mkdirSync, writeFileSync } = require("node:fs");
    const args = process.argv.slice(2);
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
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI: "1", OPENBUILD_INSTALL_DIR: join(temp, "app"),
        TEST_PAGES: JSON.stringify(pages), TEST_TAG: join(temp, "tag"), TEST_TRACK: join(temp, "track"),
        TEST_INSTALLER: join(root, "install.sh"), TEST_CURL_FAIL: curlFails ? "1" : "0" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const read = (name: string) => { try { return readFileSync(join(temp, name), "utf8"); } catch { return undefined; } };
    return { code: result.exitCode, stderr: result.stderr.toString(), tag: read("tag"), track: read("track") };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

test("stable installer installs the stable release and saves its update track", () => {
  expect(install([[release("v1.2.3", false)]])).toEqual({ code: 0, stderr: "", tag: "v1.2.3", track: "stable" });
});

test("nightly installer paginates and selects newest published prerelease, excluding drafts and invalid tags", () => {
  const page = Array.from({ length: 100 }, () => release("v1.0.0", false));
  const result = install([page, [
    release("v1.1.0-nightly.1", true, "2026-10-01"),
    release("v1.1.0-nightly.3", true, "2026-10-03", true),
    release("unsafe/tag", true, "2026-10-04"),
    release("v1.1.0-nightly.2", true, "2026-10-02"),
  ]], true);
  expect(result).toEqual({ code: 0, stderr: "", tag: "v1.1.0-nightly.2", track: "nightly" });
});

test("nightly fails without prereleases instead of falling back to stable", () => {
  const result = install([[release("v1.2.3", false)]], true);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Could not find a published nightly release");
  expect(result.tag).toBeUndefined();
  expect(result.track).toBeUndefined();
});

test("nightly URL entry point selects nightly and stops on download failure", () => {
  expect(install([[release("v1.2.4-beta.1", true)]], false, true)).toEqual({ code: 0, stderr: "", tag: "v1.2.4-beta.1", track: "nightly" });
  const failed = install([], false, true, true);
  expect(failed.code).toBe(22);
  expect(failed.tag).toBeUndefined();
});
