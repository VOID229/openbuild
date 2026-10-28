// The folder field's completion rules (src/components/PathField.tsx): typing "~/Doc" completes to
// "~/Documents/" on Tab, and the same on a paired device, since only the listing is per device.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { commonPrefix, completePath, matchFolders, pathParts } from "../src/lib/pathComplete";

describe("pathParts", () => {
  test("splits at the last slash, keeping what was typed", () => {
    expect(pathParts("~/code/openbuild")).toEqual({ head: "~/code/", dir: "~/code/", fragment: "openbuild" });
  });

  test("after a slash, the folder itself is being listed", () => {
    expect(pathParts("~/code/")).toEqual({ head: "~/code/", dir: "~/code/", fragment: "" });
  });

  test("a bare ~ completes under home", () => {
    expect(pathParts("~")).toEqual({ head: "~/", dir: "~", fragment: "" });
  });

  test("a path with no folder yet completes under home, and gains its ~/ head", () => {
    expect(pathParts("Doc")).toEqual({ head: "~/", dir: "~", fragment: "Doc" });
    expect(pathParts("")).toEqual({ head: "~/", dir: "~", fragment: "" });
  });

  test("absolute paths keep their own root", () => {
    expect(pathParts("/opt/ho")).toEqual({ head: "/opt/", dir: "/opt/", fragment: "ho" });
  });
});

describe("matchFolders", () => {
  const names = ["Documents", "Downloads", "doc-tools", "projects"];
  test("matches a fragment whatever its case", () => {
    expect(matchFolders(names, "doc")).toEqual(["Documents", "doc-tools"]);
    expect(matchFolders(names, "down")).toEqual(["Downloads"]);
  });
  test("everything matches an empty fragment", () => {
    expect(matchFolders(names, "")).toHaveLength(4);
  });
});

describe("completePath", () => {
  test("one match completes to the folder, with its slash", () => {
    expect(completePath("~/proj", ["projects"])).toBe("~/projects/");
  });

  test("several matches complete to what they share, which gets to the next slash", () => {
    expect(completePath("~/o", ["openbuild", "openchat"])).toBe("~/open");
    // Case-insensitively typed, but a shared start no longer than the fragment is left alone.
    expect(completePath("~/doc", ["doc-tools", "docs"])).toBe("~/doc");
  });

  test("a picked folder wins over the common prefix", () => {
    expect(completePath("~/Doc", ["Documents", "Downloads"], 1)).toBe("~/Downloads/");
  });

  test("a common prefix no longer than what's typed changes nothing", () => {
    expect(completePath("~/Documents", ["Documents", "DocumentsOld"])).toBe("~/Documents");
  });

  test("no matches changes nothing", () => {
    expect(completePath("~/nope", [])).toBe("~/nope");
  });
});

describe("commonPrefix", () => {
  test("shares what all names start with", () => {
    expect(commonPrefix(["openbuild", "openchat", "openid"])).toBe("open");
    expect(commonPrefix(["src", "tests"])).toBe("");
    expect(commonPrefix([])).toBe("");
  });
});

// The folder field lists a folder's subfolders from the device that holds it; a path being typed
// that starts with a dot should be able to reach dotfolders too.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browse } from "../server/projects";

describe("browse", () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-browse-"));
  beforeAll(() => {
    for (const name of ["code", ".config", "node_modules"]) mkdirSync(join(dir, name));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("leaves out dotfolders, node_modules and files", () => {
    expect(browse(dir).entries.map((e) => e.name)).toEqual(["code"]);
  });

  test("lists dotfolders when a dot is being typed", () => {
    const names = browse(dir, { hidden: true }).entries.map((e) => e.name);
    expect(names).toContain(".config");
    expect(names).toContain("code");
    expect(names).not.toContain("node_modules");
  });

  test("says so when there's no folder there", () => {
    expect(() => browse(join(dir, "missing"))).toThrow();
  });

});
