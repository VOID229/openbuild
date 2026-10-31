import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete } from "../server/pi/sessions";

const directory = mkdtempSync(join(tmpdir(), "openbuild-pi-complete-test-"));
const realBin = process.env.PI_BIN;

afterEach(() => {
  if (realBin === undefined) delete process.env.PI_BIN;
  else process.env.PI_BIN = realBin;
});

describe("complete", () => {
  test("passes images to Pi as files and removes them afterwards", async () => {
    const fake = join(directory, "pi");
    writeFileSync(fake, '#!/bin/sh\nfor a; do case "$a" in @*) echo "${a#@}"; cat "${a#@}"; echo;; esac; done\n');
    chmodSync(fake, 0o755);
    process.env.PI_BIN = fake;
    const out = await complete("a/b", "system", "prompt", new AbortController().signal, [{ data: btoa("first") }, { data: btoa("second") }]);
    const [path, first, , second] = out.split("\n");
    expect(first).toBe("first");
    expect(second).toBe("second");
    expect(existsSync(path!)).toBe(false);
    rmSync(directory, { recursive: true, force: true });
  });
});
