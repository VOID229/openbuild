import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRelease, installRelease, releaseTrack, selectRelease, setReleaseTrack, type Release } from "../server/releases";

const release = (tag: string, prerelease = false, date = "2026-10-30"): Release => ({ tag_name: tag, prerelease, draft: false, published_at: date, html_url: `https://github.com/VOID229/openbuild/releases/tag/${tag}` });
test("release tracks select published releases, ignoring drafts and unsafe tags", () => {
  const releases = [release("v1.0.0"), release("v1.1.0-nightly.1", true), { ...release("v9.0.0"), draft: true }, release("--evil"), release("v0.9.0", false, "2026-01-01")];
  expect(selectRelease(releases, "stable")?.tag_name).toBe("v1.0.0");
  expect(selectRelease(releases, "nightly")?.tag_name).toBe("v1.1.0-nightly.1");
  expect(selectRelease([release("v1.0.0")], "nightly")).toBeUndefined();
});

test("track persistence, cached release checks, switching tracks, offline recovery, and local-edit guard", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-releases-"));
  const previous = process.env.OPENCHAT_DATA_DIR;
  const originalFetch = globalThis.fetch;
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", temp, ...args]);
    expect(result.exitCode).toBe(0);
  };
  try {
    process.env.OPENCHAT_DATA_DIR = join(temp, "data");
    expect(releaseTrack()).toBe("stable");
    expect(() => setReleaseTrack("typo")).toThrow();
    git("init"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "initial");
    git("tag", "v1.0.0");
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json([release("v1.0.0"), release("v1.1.0-nightly.1", true)]); }) as unknown as typeof fetch;
    expect((await checkRelease(true, temp)).available).toBe(false);
    await checkRelease(false, temp);
    expect(calls).toBe(1);
    setReleaseTrack("nightly");
    expect(releaseTrack()).toBe("nightly");
    expect((await checkRelease(false, temp)).latest).toBe("v1.1.0-nightly.1");
    expect((await checkRelease(false, temp)).available).toBe(true);
    expect(calls).toBe(2);
    writeFileSync(join(temp, "local.txt"), "preserve me");
    await expect(installRelease(temp)).rejects.toThrow("local changes");
    globalThis.fetch = (async () => new Response("limited", { status: 403 })) as unknown as typeof fetch;
    await expect(checkRelease(true, temp)).rejects.toThrow("HTTP 403");
    globalThis.fetch = (async () => Response.json([])) as unknown as typeof fetch;
    expect((await checkRelease(false, temp)).latest).toBeUndefined();
    setReleaseTrack("stable");
    expect(releaseTrack()).toBe("stable");
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.OPENCHAT_DATA_DIR; else process.env.OPENCHAT_DATA_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

test("updates fetch a release, keep branches, and roll back after failed dependencies", async () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-release-install-"));
  const source = join(temp, "source"), checkout = join(temp, "checkout");
  const previous = process.env.OPENCHAT_DATA_DIR, originalFetch = globalThis.fetch;
  const command = (args: string[], cwd = temp) => {
    const p = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode) throw new Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  const git = (...args: string[]) => command(["git", ...args], source);
  try {
    process.env.OPENCHAT_DATA_DIR = join(temp, "data");
    command(["git", "init", source]);
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "release-fixture", version: "1.0.0" }));
    mkdirSync(join(source, "plugins", "custom"), { recursive: true });
    writeFileSync(join(source, "plugins", "custom", "plugin.json"), "original user plugin");
    command([process.execPath, "install"], source);
    git("add", "."); git("commit", "-m", "initial"); git("tag", "v1.0.0");
    command(["git", "clone", source, checkout]);
    command(["git", "config", `url.${source}.insteadOf`, "https://github.com/VOID229/openbuild.git"], checkout);
    writeFileSync(join(source, "release.txt"), "new release");
    writeFileSync(join(source, "plugins", "custom", "plugin.json"), "new bundled contents");
    git("add", "."); git("commit", "-m", "release"); git("tag", "v1.1.0");
    const branch = command(["git", "symbolic-ref", "--short", "HEAD"], checkout);
    const originalHead = command(["git", "rev-parse", "HEAD"], checkout);
    setReleaseTrack("stable");
    globalThis.fetch = (async () => Response.json([release("v1.1.0")])) as unknown as typeof fetch;
    expect((await installRelease(checkout)).current).toBe("v1.1.0");
    expect(readFileSync(join(temp, "data", "plugins", "custom", "plugin.json"), "utf8")).toBe("original user plugin");
    expect(command(["git", "rev-parse", branch], checkout)).toBe(originalHead);
    const installed = command(["git", "rev-parse", "HEAD"], checkout);
    writeFileSync(join(source, "package.json"), "{invalid json");
    git("add", "."); git("commit", "-m", "broken dependencies"); git("tag", "v1.2.0");
    globalThis.fetch = (async () => Response.json([release("v1.2.0")])) as unknown as typeof fetch;
    await expect(installRelease(checkout)).rejects.toThrow("Dependency installation failed");
    expect(command(["git", "rev-parse", "HEAD"], checkout)).toBe(installed);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.OPENCHAT_DATA_DIR; else process.env.OPENCHAT_DATA_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  }
});

test("curl installer selects a stable tag under sh and bash and refuses overwrite", () => {
  const temp = mkdtempSync(join(tmpdir(), "ob-track-installer-"));
  try {
    const { mkdirSync, chmodSync } = require("node:fs");
    const bin = join(temp, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "bun"), '#!/bin/sh\ncase "$*" in *api.github.com*) echo v1.2.3;; esac\n');
    writeFileSync(join(bin, "git"), '#!/bin/sh\n[ "$1" = clone ] && [ "$2" = --branch ] && [ "$3" = v1.2.3 ] || exit 1\nfor target do :; done\nmkdir -p "$target"\n');
    chmodSync(join(bin, "bun"), 0o755); chmodSync(join(bin, "git"), 0o755);
    for (const shell of ["sh", "bash"]) {
      const options = { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OPENBUILD_INSTALL_DIR: join(temp, `${shell} install`) }, stdout: "pipe" as const, stderr: "pipe" as const };
      const script = join(import.meta.dir, "..", "install.sh");
      expect(Bun.spawnSync([shell, script], options).exitCode).toBe(0);
      expect(Bun.spawnSync([shell, script], options).exitCode).toBe(1);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
