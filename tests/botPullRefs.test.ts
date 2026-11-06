// PR numbers in OpenBots messages, and the GitHub page each one links to.
import { describe, expect, test } from "bun:test";
import { PULL_REF_RE, inPullContext, pullRefUrl } from "../src/lib/bots/pullRefs";

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

  test("never guesses a number no thread opened, even with one repository known", () => {
    expect(pullRefUrl(53, [pr(74), pr(70)])).toBeUndefined();
    expect(pullRefUrl(2, [pr(101)])).toBeUndefined();
    expect(pullRefUrl(333, [pr(74)])).toBeUndefined();
    expect(pullRefUrl(1, [])).toBeUndefined();
  });

  test("stays text when two repositories share the number", () => {
    expect(pullRefUrl(5, [pr(5), pr(5, "a/b")])).toBeUndefined();
  });
});

describe("inPullContext", () => {
  // Which "#n" in the text read as pull requests.
  const pullsIn = (text: string) => [...text.matchAll(PULL_REF_RE)].filter((m) => inPullContext(text, m.index, m.index + m[0].length)).map((m) => m[0]);

  test("reads PR wording before or after the number", () => {
    expect(pullsIn("#101 is merged too—CI passed on retry.")).toEqual(["#101"]);
    expect(pullsIn("Opened PR #74, and pull request #75 was closed.")).toEqual(["#74", "#75"]);
    expect(pullsIn("Merged #12 after #11 landed.")).toEqual(["#12", "#11"]);
    expect(pullsIn("PRs #3, #4 and #5 are up.")).toEqual(["#3", "#4", "#5"]);
  });

  test("leaves model, account and numbered labels as text", () => {
    expect(pullsIn("manager switched to fallback model GPT 6.1 Sol #2 (From codex 2).")).toEqual([]);
    expect(pullsIn("Started on Claude #2; step #3 next, then option #1.")).toEqual([]);
    expect(pullsIn("The PR is up. Account #2 ran it.")).toEqual([]);
  });
});
