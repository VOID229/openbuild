// PR numbers in OpenBots messages, and the GitHub page each one links to.
import { describe, expect, test } from "bun:test";
import { PULL_REF_RE, conversationRepo, inPullContext, pullRefHref, pullRefUrl } from "../src/lib/bots/pullRefs";

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

describe("conversationRepo", () => {
  const crew = { id: "crew", botIds: ["manager", "tracer"] };
  const thread = (url: string, startedBy?: { bot: string; conversation: string }) => ({ pullRequest: { url }, startedBy });
  const A = "https://github.com/VOID229/OpenBuild";
  const B = "https://github.com/a/b";

  test("the repository of the threads started in the conversation", () => {
    expect(conversationRepo(crew, [thread(`${A}/pull/210`, { bot: "manager", conversation: "crew" }), thread(`${B}/pull/3`)])).toBe(A);
  });

  test("else its bots' threads, else any thread's", () => {
    expect(conversationRepo(crew, [thread(`${B}/pull/3`), thread(`${A}/pull/9`, { bot: "tracer", conversation: "elsewhere" })])).toBe(A);
    expect(conversationRepo(crew, [thread(`${A}/pull/1`), { openedPullRequests: [`${A.toLowerCase()}/pull/2`] }])?.toLowerCase()).toBe(A.toLowerCase());
  });

  test("undecided between two repositories, or with none known", () => {
    expect(conversationRepo(crew, [thread(`${A}/pull/1`, { bot: "manager", conversation: "crew" }), thread(`${B}/pull/2`, { bot: "tracer", conversation: "crew" })])).toBeUndefined();
    expect(conversationRepo(crew, [thread(`${A}/pull/1`), thread(`${B}/pull/2`)])).toBeUndefined();
    expect(conversationRepo(crew, [{}, thread("https://example.com/not-a-pull")])).toBeUndefined();
  });
});

describe("pullRefHref", () => {
  const repo = "https://github.com/VOID229/openbuild";
  // Where each "#n" in the text links.
  const hrefs = (text: string, known: { repo?: string; pulls: { number: number; url: string }[] } = { repo, pulls: [] }) =>
    [...text.matchAll(PULL_REF_RE)].map((m) => pullRefHref(text, m.index, m.index + m[0].length, Number(m[1]), known));

  test("links any #n in the conversation's repository, without PR wording", () => {
    expect(hrefs("#213 is docs-only. @tracer #210 (thread f707f90a). Merge #213 and #210 when ready.")).toEqual([`${repo}/pull/213`, `${repo}/pull/210`, `${repo}/pull/213`, `${repo}/pull/210`]);
    expect(hrefs("queued the merges: #204, #212")).toEqual([`${repo}/pull/204`, `${repo}/pull/212`]);
  });

  test("keeps a thread's own URL for its pull request in that repository", () => {
    expect(hrefs("see #74", { repo, pulls: [pr(74, "VOID229/OpenBuild")] })).toEqual(["https://github.com/VOID229/OpenBuild/pull/74"]);
  });

  test("labels, colours and six-digit numbers need PR wording", () => {
    expect(hrefs("GPT 6.1 Sol #2, step #3, color: #333, background: #123, a colour #123456")).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(hrefs("PR #2 and merged #100200")).toEqual([`${repo}/pull/2`, `${repo}/pull/100200`]);
  });

  test("without a repository, only a pull request a thread opened", () => {
    expect(hrefs("#213 and #74", { pulls: [pr(74)] })).toEqual([undefined, "https://github.com/VOID229/OpenBuild/pull/74"]);
    expect(hrefs("#5", { pulls: [pr(5)] })).toEqual([undefined]);
  });
});
