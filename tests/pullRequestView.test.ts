// The side panel's pull requests tab: what gh's answers become, the exact commands an action runs,
// and what a pull request's state means for its Merge button. The server half runs in its own
// process with its own data dir and a fake `gh`, so it never touches the user's database or GitHub.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullCheck } from "../shared/types";
import { usePanel } from "../src/lib/panel";
import { mergeReadiness, mergeUnsettled } from "../src/lib/pulls";

const fakeGh = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "repo view") cat <<'JSON'
{"nameWithOwner":"o/r","url":"https://github.com/o/r","squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":true,"viewerPermission":"WRITE"}
JSON
  ;;
  "pr list") cat <<'JSON'
[
  {"number":8,"title":"From a fork","url":"https://github.com/o/r/pull/8","state":"OPEN","isCrossRepository":true,"author":{"login":"stranger"},"headRefName":"main","baseRefName":"main","additions":1,"deletions":0,"updatedAt":"2026-11-01T00:00:00Z","statusCheckRollup":[]},
  {"number":7,"title":"Mine","url":"https://github.com/o/r/pull/7","state":"OPEN","isDraft":true,"author":{"login":"me"},"headRefName":"main","baseRefName":"trunk","additions":3,"deletions":2,"updatedAt":"2026-11-02T00:00:00Z","statusCheckRollup":[{"status":"IN_PROGRESS","conclusion":""}]}
]
JSON
  ;;
  "pr view")
    # #9 settles on the second ask for only its mergeability, #10 never does.
    case "$3 $5" in
      "9 mergeable,mergeStateStatus")
        if [ "$(grep -c '^pr view 9 --json mergeable' "$GH_LOG")" -ge 2 ]; then echo '{"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN"}'; else echo '{"mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"}'; fi
        exit 0 ;;
      "10 mergeable,mergeStateStatus") echo '{"mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"}'; exit 0 ;;
      "9 "*|"10 "*) printf '{"number":%s,"title":"T","url":"u","state":"OPEN","headRefName":"f","baseRefName":"main","updatedAt":"2026-11-02T00:00:00Z","headRefOid":"abc1234","mergeable":"UNKNOWN","mergeStateStatus":"UNKNOWN"}\\n' "$3"; exit 0 ;;
    esac
    cat <<'JSON'
{"number":7,"title":"Mine","url":"https://github.com/o/r/pull/7","state":"OPEN","author":null,"headRefName":"feat","baseRefName":"main","updatedAt":"2026-11-02T00:00:00Z","body":"Why","headRefOid":"abc1234def","changedFiles":2,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"test","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://ci/1"},{"context":"lint","state":"SUCCESS"},{"name":"docs","status":"COMPLETED","conclusion":"SKIPPED"},{"name":"e2e","status":"IN_PROGRESS","conclusion":""}],"latestReviews":[{"author":{"login":"ann"},"state":"APPROVED"}],"reviewRequests":[{"login":"ann"},{"slug":"core"}],"reviews":[{"id":"r1","author":{"login":"ann"},"state":"APPROVED","body":"","submittedAt":"2026-11-02T01:00:00Z"},{"id":"r2","author":{"login":"bob"},"state":"COMMENTED","body":"Hm","submittedAt":"2026-11-02T03:00:00Z"}],"labels":[{"name":"bug","color":"ff0000"}],"comments":[{"id":"c1","author":{"login":"cat"},"body":"Nice","createdAt":"2026-11-02T02:00:00Z"}],"commits":[{"oid":"abc1234def","messageHeadline":"first","committedDate":"2026-11-02T00:00:00Z","authors":[{"login":"","name":"Me"}]}]}
JSON
  ;;
  "pr diff") printf 'diff --git a/a b/a\\n' ;;
  "api "*) printf 'commit diff\\n' ;;
  "pr merge") if [ -n "$GH_FAIL" ]; then echo "Head branch was modified. Review and try the merge again." >&2; exit 1; fi ;;
esac
`;

const script = `
  import { strict as assert } from "node:assert";
  import { readFileSync, writeFileSync } from "node:fs";
  const cwd = process.env.TEST_ROOT + "/repo";
  const sh = (...args) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  Bun.spawnSync(["mkdir", "-p", cwd]);
  sh("init", "-b", "main");
  sh("commit", "--allow-empty", "-m", "first");
  const view = await import("./server/pullRequestView.ts");
  const log = process.env.GH_LOG;
  const calls = () => {
    const lines = readFileSync(log, "utf8").trim().split("\\n");
    writeFileSync(log, "");
    return lines.filter((l) => !l.startsWith("repo view"));
  };
  writeFileSync(log, "");

  // The list: this branch's own pull request, and not a fork's branch of the same name.
  const listed = await view.list(cwd, "bogus");
  assert.equal(listed.current, 7);
  assert.deepEqual(listed.pulls.map((p) => [p.number, p.state, p.draft, p.checks]), [[8, "open", undefined, undefined], [7, "open", true, "pending"]]);
  assert.ok(calls()[0].startsWith("pr list --state open --limit 50"), "an unknown state means open");
  await view.list(cwd, "merged");
  assert.ok(calls()[0].startsWith("pr list --state merged"));
  assert.deepEqual(await view.list(process.env.TEST_ROOT, "open"), { gh: true, repo: false, pulls: [] });

  // Lists are shared for a moment, across the repository's worktrees too, but not past a refresh.
  assert.equal((await view.list(cwd, "open")).current, 7);
  assert.deepEqual(calls().filter(Boolean), [], "a list just read is read once");
  await view.list(cwd, "open", true);
  assert.ok(calls()[0].startsWith("pr list --state open"), "fresh asks again");
  const tree = process.env.TEST_ROOT + "/tree";
  sh("worktree", "add", "-b", "other", tree);
  const there = await view.list(tree, "open");
  assert.equal(there.current, undefined, "another branch has no pull request of its own");
  assert.equal(there.pulls.length, 2);
  assert.deepEqual(calls().filter(Boolean), [], "a worktree shares its repository's list");

  // One pull request.
  const pr = await view.view(cwd, "7");
  assert.equal(pr.repo, "o/r");
  assert.equal(pr.author, "ghost");
  assert.deepEqual(pr.methods, ["squash", "rebase"]);
  assert.equal(pr.canWrite, true);
  assert.deepEqual(pr.checkList.map((c) => [c.name, c.state]), [["test", "failing"], ["lint", "passing"], ["docs", "skipped"], ["e2e", "pending"]]);
  assert.equal(pr.checkList[0].url, "https://ci/1");
  assert.deepEqual(pr.reviewers, [{ login: "ann", state: "APPROVED" }, { login: "core" }], "an answer beats a request, a team by its slug");
  assert.deepEqual(pr.comments.map((c) => [c.id, c.verdict]), [["c1", undefined], ["r2", "COMMENTED"]], "by time, without a review that says nothing");
  assert.equal(pr.commits[0].author, "Me");
  calls();
  await view.view(cwd, 7);
  assert.deepEqual(calls().filter(Boolean), [], "a pull request just read is read once");

  // GitHub still working out whether it can merge: asked again, for only that, until it says.
  const views = () => calls().map((l) => l.replace(/^pr view (\\d+) --json (mergeable)?.*/, "$1 $2").trim());
  calls();
  const answered = await view.view(cwd, 9);
  assert.deepEqual([answered.mergeable, answered.mergeState, answered.title], ["MERGEABLE", "CLEAN", "T"]);
  assert.deepEqual(views(), ["9", "9 mergeable", "9 mergeable"]);
  await view.view(cwd, 9);
  assert.deepEqual(calls().filter(Boolean), [], "an answer is shared");
  const undecided = await view.view(cwd, 10);
  assert.equal(undecided.mergeable, "UNKNOWN", "it stops waiting eventually");
  assert.deepEqual(views(), ["10", "10 mergeable", "10 mergeable", "10 mergeable", "10 mergeable"]);
  await view.view(cwd, 10);
  assert.equal(views()[0], "10", "no answer yet, so the next read asks GitHub");

  // Diffs.
  assert.equal((await view.patch(cwd, 7)).patch, "diff --git a/a b/a");
  assert.deepEqual(calls(), ["pr diff 7 --color never"]);
  assert.equal((await view.patch(cwd, 7, "abc1234")).patch, "commit diff");
  assert.deepEqual(calls(), ["api --hostname github.com -H Accept: application/vnd.github.diff repos/o/r/commits/abc1234"]);
  await assert.rejects(view.patch(cwd, 7, "../../evil"), /Expected a commit/);

  // Actions name the repository, and a merge pins the commit that was on screen.
  await view.merge(cwd, 7, "squash", "abc1234def", false);
  assert.deepEqual(calls(), ["pr merge 7 --repo github.com/o/r --squash --match-head-commit abc1234def"]);
  await view.view(cwd, 7);
  assert.ok(calls()[0].startsWith("pr view 7"), "acting on it forgets what was read");
  await view.merge(cwd, 7, "rebase", "abc1234def", true);
  assert.deepEqual(calls(), ["pr merge 7 --repo github.com/o/r --rebase --match-head-commit abc1234def --delete-branch"]);
  await assert.rejects(view.merge(cwd, 7, "--admin", "abc1234def", false), /merge method/);
  await assert.rejects(view.merge(cwd, 7, "squash", "--admin", false), /Expected a commit/);
  await assert.rejects(view.merge(cwd, "7 --admin", "squash", "abc1234def", false), /pull request number/);
  assert.deepEqual(calls().filter(Boolean), [], "nothing invalid reached gh");
  process.env.GH_FAIL = "1";
  await assert.rejects(view.merge(cwd, 7, "squash", "abc1234def", false), /Head branch was modified/, "gh's own words come back");
  delete process.env.GH_FAIL;
  calls();

  await view.edit(cwd, 7, " New title ", "--not a flag");
  assert.deepEqual(calls(), ["pr edit 7 --repo github.com/o/r --title New title --body --not a flag"]);
  await assert.rejects(view.edit(cwd, 7, "  ", "x"), /needs a title/);
  await view.comment(cwd, 7, "Thanks");
  assert.deepEqual(calls(), ["pr comment 7 --repo github.com/o/r --body Thanks"]);
  await assert.rejects(view.comment(cwd, 7, "  "), /needs some text/);
  await view.setState(cwd, 7, "ready");
  assert.deepEqual(calls(), ["pr ready 7 --repo github.com/o/r"]);
  await assert.rejects(view.setState(cwd, 7, "delete"), /Expected close/);
  console.log("ok");
`;

test("pull requests are read and acted on through gh", async () => {
  const root = mkdtempSync(join(tmpdir(), "openbuild-pull-view-"));
  try {
    const bin = join(root, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "gh"), fakeGh);
    chmodSync(join(bin, "gh"), 0o755);
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, TEST_ROOT: root, OPENCHAT_DATA_DIR: join(root, "data"), GH_LOG: join(root, "gh.log"), PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(err || out);
    expect(out).toContain("ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

describe("mergeReadiness", () => {
  const base = { state: "open" as const, base: "main", mergeable: "MERGEABLE", mergeState: "CLEAN", checkList: [] as PullCheck[], canWrite: true };
  const failing: PullCheck[] = [{ name: "t", state: "failing" }];
  const running: PullCheck[] = [{ name: "t", state: "pending" }, { name: "u", state: "pending" }];
  const check = (over: Partial<Parameters<typeof mergeReadiness>[0]>) => {
    const r = mergeReadiness({ ...base, ...over });
    return [r.tone, r.text, r.canMerge];
  };

  test("a clean pull request can merge", () => {
    expect(check({})).toEqual(["ok", "Ready to merge", true]);
  });
  test("only someone with write access can merge", () => {
    expect(check({ canWrite: false })).toEqual(["warn", "You can't merge in this repository", false]);
  });
  test("finished, draft and conflicting pull requests can't", () => {
    expect(check({ state: "merged" })[2]).toBe(false);
    expect(check({ state: "closed" })[2]).toBe(false);
    expect(check({ draft: true })[0]).toBe("draft");
    expect(check({ mergeable: "CONFLICTING", mergeState: "DIRTY" })).toEqual(["bad", "Conflicts with main", false]);
  });
  test("a branch rule blocking it says the likeliest reason", () => {
    const blocked = { mergeState: "BLOCKED" };
    expect(check({ ...blocked, checkList: failing })).toEqual(["bad", "1 check failing", false]);
    expect(check({ ...blocked, checkList: running })).toEqual(["wait", "Waiting on 2 checks", false]);
    expect(check({ ...blocked, reviewDecision: "CHANGES_REQUESTED" })).toEqual(["bad", "Changes requested", false]);
    expect(check({ ...blocked, reviewDecision: "REVIEW_REQUIRED" })).toEqual(["warn", "Needs a review", false]);
    expect(check(blocked)[1]).toBe("Blocked by main's branch rules");
  });
  test("checks that aren't required warn without stopping the merge", () => {
    expect(check({ mergeState: "UNSTABLE", checkList: failing })).toEqual(["bad", "1 check failing, not required", true]);
    expect(check({ checkList: running })).toEqual(["wait", "2 checks still running", true]);
  });
  test("while GitHub is working it out, or the branch is behind, it waits", () => {
    expect(check({ mergeable: "UNKNOWN", mergeState: "UNKNOWN" })).toEqual(["wait", "GitHub is checking if it can merge", false]);
    expect(check({ mergeState: "BEHIND" })[2]).toBe(false);
  });
  test("only an open pull request ready for review is worth asking about again", () => {
    const unknown = { state: "open" as const, mergeable: "UNKNOWN", mergeState: "UNKNOWN" };
    expect(mergeUnsettled(unknown)).toBe(true);
    expect(mergeUnsettled({ ...unknown, mergeable: "MERGEABLE" })).toBe(true);
    expect(mergeUnsettled({ ...unknown, draft: true })).toBe(false);
    expect(mergeUnsettled({ ...unknown, state: "merged" })).toBe(false);
    expect(mergeUnsettled({ state: "open", mergeable: "MERGEABLE", mergeState: "CLEAN" })).toBe(false);
  });
});

describe("the pull requests tab", () => {
  test("opens on this branch's, comes back where it was, and forgets when closed", () => {
    const panel = usePanel.getState();
    panel.openPulls();
    expect(usePanel.getState()).toMatchObject({ pulls: true, view: "pulls", activePull: "current", panel: true });
    panel.setActivePull(7);
    panel.setView("diff");
    panel.openPulls();
    expect(usePanel.getState()).toMatchObject({ view: "pulls", activePull: 7 });
    panel.openPulls(9);
    expect(usePanel.getState().activePull).toBe(9);
    panel.closePulls();
    expect(usePanel.getState()).toMatchObject({ pulls: false, activePull: undefined });
    panel.openPulls();
    expect(usePanel.getState().activePull).toBe("current");
    panel.closePulls();
    panel.setPanel(false);
  });
});
