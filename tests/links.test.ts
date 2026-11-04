// Which links are pull requests, so a click can open them in the side panel's pull requests tab.
import { describe, expect, test } from "bun:test";
import { parsePullUrl } from "../src/lib/links";

describe("parsePullUrl", () => {
  test("reads a pull request's repository and number", () => {
    expect(parsePullUrl("https://github.com/VOID229/OpenBuild/pull/24")).toEqual({ repo: "github.com/void229/openbuild", number: 24 });
  });

  test("takes any of its tabs, a query or an anchor", () => {
    expect(parsePullUrl("https://github.com/a/b/pull/7/files#diff-1")?.number).toBe(7);
    expect(parsePullUrl("https://github.com/a/b/pull/7?w=1")?.number).toBe(7);
  });

  test("keeps the host, for GitHub Enterprise", () => {
    expect(parsePullUrl("https://git.corp.dev/a/b/pull/3")?.repo).toBe("git.corp.dev/a/b");
  });

  test("ignores everything else", () => {
    expect(parsePullUrl("https://github.com/a/b/pulls")).toBeUndefined();
    expect(parsePullUrl("https://github.com/a/b/issues/3")).toBeUndefined();
    expect(parsePullUrl("https://github.com/a/b/pull/x")).toBeUndefined();
    expect(parsePullUrl("not a url")).toBeUndefined();
  });
});
