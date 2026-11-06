// PR numbers in OpenBots messages, and the GitHub page each one links to.
import { describe, expect, test } from "bun:test";
import { PULL_REF_RE, pullRefUrl } from "../src/lib/bots/pullRefs";

const pr = (number: number, repo = "VOID229/OpenBuild") => ({ number, url: `https://github.com/${repo}/pull/${number}` });
const refs = (text: string) => [...text.matchAll(PULL_REF_RE)].map((m) => m[0]);

describe("PULL_REF_RE", () => {
  test("finds PR numbers in a sentence", () => {
    expect(refs("Opened #74 (after #73), see #12.")).toEqual(["#74", "#73", "#12"]);
  });

  test("leaves words, addresses, headings and colours alone", () => {
    expect(refs("PR#74 a/#3 &#39; ##4 #4a #fff #1-2")).toEqual([]);
  });
});

describe("pullRefUrl", () => {
  test("links a thread's own pull request", () => {
    expect(pullRefUrl(74, [pr(74), pr(9, "a/b")])).toBe("https://github.com/VOID229/OpenBuild/pull/74");
  });

  test("links an older number in the only repository known", () => {
    expect(pullRefUrl(53, [pr(74), pr(70)])).toBe("https://github.com/VOID229/OpenBuild/pull/53");
  });

  test("stays text when the repository is unclear or the number is past the newest", () => {
    expect(pullRefUrl(53, [pr(74), pr(60, "a/b")])).toBeUndefined();
    expect(pullRefUrl(5, [pr(5), pr(5, "a/b")])).toBeUndefined();
    expect(pullRefUrl(333, [pr(74)])).toBeUndefined();
    expect(pullRefUrl(1, [])).toBeUndefined();
  });
});
