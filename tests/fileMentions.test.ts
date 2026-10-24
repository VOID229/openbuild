// The "@" menu filters a workspace's files and folders locally; these are its ranking rules.
import { describe, expect, test } from "bun:test";
import type { WorkspaceEntry } from "../shared/types";
import { matchEntries } from "../src/lib/fileMentions";

const f = (path: string): WorkspaceEntry => ({ path, dir: false });
const d = (path: string): WorkspaceEntry => ({ path, dir: true });

const entries = [
  d("src"),
  d("src/lib"),
  d("shared"),
  d("tests"),
  d("convex"),
  d("convex/_generated"),
  f("src/styles.css"),
  f("src/lib/types.ts"),
  f("shared/types.ts"),
  f("src/App.tsx"),
  f("tests/sync.test.ts"),
  f("convex/_generated/ai-files.state.json"),
  f("src/lib/ui.ts"),
  f("README.md"),
];

describe("file mentions", () => {
  test("an empty query lists entries", () => {
    expect(matchEntries(entries, "", 3)).toEqual(entries.slice(0, 3));
  });

  test("a basename prefix ranks above a path match", () => {
    expect(matchEntries(entries, "styl")[0]?.path).toBe("src/styles.css");
  });

  test("the same basename in different folders is offered", () => {
    expect(matchEntries(entries, "types.ts").map((e) => e.path)).toEqual(["shared/types.ts", "src/lib/types.ts"]);
  });

  test("fuzzy subsequences find a file", () => {
    expect(matchEntries(entries, "stycs")[0]?.path).toBe("src/styles.css");
    expect(matchEntries(entries, "aifstate")[0]?.path).toBe("convex/_generated/ai-files.state.json");
  });

  test("folders are listed and selectable", () => {
    expect(matchEntries(entries, "lib")[0]).toEqual(d("src/lib"));
    expect(matchEntries(entries, "conv")[0]).toEqual(d("convex"));
  });

  test("a folder path narrows to what's inside it", () => {
    const inside = matchEntries(entries, "src/lib/");
    expect(inside.map((e) => e.path)).toContain("src/lib/types.ts");
    expect(inside.map((e) => e.path)).toContain("src/lib/ui.ts");
    expect(inside.map((e) => e.path)).not.toContain("src/lib");
  });

  test("no match returns nothing", () => {
    expect(matchEntries(entries, "zzzzz")).toEqual([]);
  });
});
