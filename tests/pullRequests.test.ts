// A thread's worktree pull request (server/pullRequests.ts): following it, and closing the thread
// once it merges. Runs in its own process with its own data dir and a fake `gh`, so it never touches
// the user's database, worktrees or GitHub.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = `
  import { strict as assert } from "node:assert";
  import { existsSync, writeFileSync } from "node:fs";
  const root = process.env.TEST_ROOT;
  const sh = (cwd, ...args) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const repo = root + "/repo";
  Bun.spawnSync(["mkdir", "-p", repo]);
  sh(repo, "init", "-b", "main");
  sh(repo, "commit", "--allow-empty", "-m", "first");

  const storage = await import("./server/storage.ts");
  const projects = await import("./server/projects.ts");
  const pr = await import("./server/pullRequests.ts");

  // Pure rules first.
  assert.equal(pr.checksOf([]), undefined);
  assert.equal(pr.checksOf([{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }]), "passing");
  assert.equal(pr.checksOf([{ status: "IN_PROGRESS", conclusion: null }, { status: "COMPLETED", conclusion: "SUCCESS" }]), "pending");
  assert.equal(pr.checksOf([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "failing");
  const t0 = Date.parse("2026-11-01T00:00:00Z");
  const old = { number: 1, url: "u1", state: "MERGED", headRefName: "openbuild/x", createdAt: "2026-10-01T00:00:00Z", mergedAt: "2026-10-02T00:00:00Z" };
  const fresh = { number: 2, url: "u2", state: "CLOSED", headRefName: "openbuild/x", createdAt: "2026-11-02T00:00:00Z" };
  const reopened = { number: 3, url: "u3", state: "OPEN", headRefName: "openbuild/x", createdAt: "2026-11-02T01:00:00Z" };
  assert.equal(pr.pickPullRequest([old], "openbuild/x", t0), undefined, "an older thread's pull request on a reused branch name");
  assert.equal(pr.pickPullRequest([old, fresh, reopened], "openbuild/x", t0).number, 3, "the open one wins");
  assert.equal(pr.pickPullRequest([old, fresh], "openbuild/x", t0).number, 2);
  assert.equal(pr.pickPullRequest([old, fresh], undefined, t0), undefined, "no branch of its own, and it opened nothing");
  assert.equal(pr.pickPullRequest([old, fresh], undefined, t0, ["u1"]).number, 1, "one it opened itself");
  assert.equal(pr.pickPullRequest([old, reopened], undefined, t0, ["u1", "u3"]).number, 3, "an open one holds the thread open");

  const merged = { number: 9, url: "u", state: "merged", mergedAt: t0 + 5000, checkedAt: t0 + 6000 };
  const base = { id: "c", title: "t", createdAt: t0, updatedAt: t0, messages: [
    { id: "u1", role: "user", content: "", createdAt: t0 + 1000 },
    { id: "a1", role: "assistant", content: "", createdAt: t0 + 1001, status: "done" },
  ] };
  assert.equal(pr.shouldClose(base, merged, t0 + 7000), true);
  assert.equal(pr.shouldClose({ ...base, pinned: true }, merged, t0 + 7000), false);
  assert.equal(pr.shouldClose({ ...base, autoCloseOptOut: true }, merged, t0 + 7000), false);
  assert.equal(pr.shouldClose({ ...base, snoozedUntil: t0 + 99999 }, merged, t0 + 7000), false);
  assert.equal(pr.shouldClose({ ...base, messages: [...base.messages.slice(0, 1), { ...base.messages[1], status: "streaming" }] }, merged, t0 + 7000), false);
  assert.equal(pr.shouldClose({ ...base, messages: [...base.messages, { id: "u2", role: "user", content: "", createdAt: t0 + 5500 }] }, merged, t0 + 7000), false, "written to after the merge");
  assert.equal(pr.shouldClose(base, { ...merged, state: "closed" }, t0 + 7000), false);

  // A tab that saved without hearing about the close keeps it closed; one where the user reopened it doesn't.
  const closed = { ...base, archived: true, autoClosedAt: t0 + 6000, pullRequest: merged };
  const stale = pr.keepPullRequestFields({ ...base, unread: false }, closed);
  assert.equal(stale.archived, true);
  assert.equal(stale.pullRequest.number, 9);
  assert.equal(pr.keepPullRequestFields({ ...base, archived: false, autoCloseOptOut: true }, closed).archived, false);

  // End to end: a worktree thread whose pull request merged gets closed, and its clean worktree removed.
  const project = await projects.addProject(repo);
  const ws = await projects.prepareWorkspace(project.id, "worktree", undefined, "fix the thing");
  const ws2 = await projects.prepareWorkspace(project.id, "worktree", undefined, "other thing");
  const head = sh(ws.cwd, "rev-parse", "HEAD");
  const now = Date.now();
  const chat = (id, workspace, extra = {}) => ({ id, title: id, createdAt: now - 60_000, updatedAt: now - 60_000, workspace, messages: [
    { id: id + "u", role: "user", content: "go", createdAt: now - 60_000 },
    { id: id + "a", role: "assistant", content: "done", createdAt: now - 59_000, status: "done" },
  ], ...extra });
  storage.putChat(chat("merged", ws));
  storage.putChat(chat("open", ws2));
  writeFileSync(process.env.FAKE_GH_JSON, JSON.stringify([
    { number: 41, url: "https://github.com/o/r/pull/41", state: "MERGED", headRefName: ws.branch, headRefOid: head, createdAt: new Date(now - 30_000).toISOString(), mergedAt: new Date(now - 1000).toISOString(), statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
    { number: 42, url: "https://github.com/o/r/pull/42", state: "OPEN", headRefName: ws2.branch, headRefOid: "x", createdAt: new Date(now - 30_000).toISOString(), statusCheckRollup: [{ status: "QUEUED" }] },
  ]));
  await pr.sweep();
  const a = storage.getChat("merged");
  assert.equal(a.archived, true);
  assert.ok(a.autoClosedAt);
  assert.deepEqual([a.pullRequest.number, a.pullRequest.state, a.pullRequest.checks], [41, "merged", "passing"]);
  assert.equal(existsSync(ws.cwd), false, "the clean worktree is removed");
  assert.equal(sh(repo, "branch", "--list", ws.branch), "", "and its squash-merged branch");
  const b = storage.getChat("open");
  assert.equal(b.archived, undefined);
  assert.deepEqual([b.pullRequest.number, b.pullRequest.state, b.pullRequest.checks], [42, "open", "pending"]);
  assert.equal(existsSync(ws2.cwd), true);

  // Unchanged results don't rewrite the chat.
  const v = storage.chatIndex().find((e) => e.id === "open").v;
  await pr.sweep();
  assert.equal(storage.chatIndex().find((e) => e.id === "open").v, v);

  // Uncommitted work keeps a merged thread's worktree.
  writeFileSync(ws2.cwd + "/wip.txt", "x");
  writeFileSync(process.env.FAKE_GH_JSON, JSON.stringify([
    { number: 42, url: "https://github.com/o/r/pull/42", state: "MERGED", headRefName: ws2.branch, headRefOid: sh(ws2.cwd, "rev-parse", "HEAD"), createdAt: new Date(now - 30_000).toISOString(), mergedAt: new Date().toISOString() },
  ]));
  await pr.sweep();
  assert.equal(storage.getChat("open").archived, true);
  assert.equal(existsSync(ws2.cwd), true);

  // A thread in the project's own checkout follows the pull request its agent opened from elsewhere.
  const created = (url, command = "cd ~/elsewhere && gh pr create --fill") => ({ id: "a", role: "assistant", content: "", createdAt: now - 59_000, status: "done", parts: [{ type: "tool", id: "t", name: "bash", args: { command }, status: "done", output: url + "\\n" }] });
  const checkout = { cwd: repo, branch: "main", projectId: project.id };
  const url = "https://github.com/o/r/pull/50";
  storage.putChat(chat("checkout", checkout, { messages: [{ id: "u", role: "user", content: "go", createdAt: now - 60_000 }, created(url)] }));
  storage.putChat(chat("neighbour", checkout));
  storage.putChat(chat("searched", checkout, { messages: [created(url, "grep 'gh pr create' AGENTS.md")] }));
  const pullRequests = [{ number: 50, url, state: "OPEN", headRefName: "feat/elsewhere", headRefOid: "x", createdAt: new Date(now - 30_000).toISOString() }];
  writeFileSync(process.env.FAKE_GH_JSON, JSON.stringify(pullRequests));
  await pr.sweep();
  assert.deepEqual([storage.getChat("checkout").pullRequest.number, storage.getChat("checkout").archived], [50, undefined]);
  writeFileSync(process.env.FAKE_GH_JSON, JSON.stringify([{ ...pullRequests[0], state: "MERGED", mergedAt: new Date().toISOString() }]));
  await pr.sweep();
  assert.equal(storage.getChat("checkout").archived, true);
  assert.equal(existsSync(repo + "/.git"), true, "the project's checkout is never removed");
  assert.equal(storage.getChat("neighbour").pullRequest, undefined, "a thread sharing the checkout isn't touched");
  assert.equal(storage.getChat("searched").pullRequest, undefined, "mentioning the command isn't running it");

  // Nobody has the app open: the sweep brings a finished reply up to date, so the thread still closes.
  const streaming = chat("unattended", checkout, { messages: [{ id: "u", role: "user", content: "go", createdAt: now - 60_000 }, { ...created(url), status: "streaming" }] });
  storage.putChat(streaming);
  await pr.sweep();
  assert.equal(storage.getChat("unattended").archived, undefined, "still working");
  await pr.sweep(async () => { storage.putChat({ ...streaming, messages: [streaming.messages[0], created(url)] }); });
  assert.equal(storage.getChat("unattended").archived, true);

  // Just after a merge, a sweep already under way may have asked GitHub before it: another follows it.
  const asks = () => (existsSync(process.env.FAKE_GH_LOG) ? Bun.file(process.env.FAKE_GH_LOG).text() : Promise.resolve("")).then((t) => t.split("\\n").filter(Boolean).length);
  storage.putChat(chat("following", checkout, { messages: [{ id: "u", role: "user", content: "go", createdAt: now - 60_000 }, created(url)] }));
  writeFileSync(process.env.FAKE_GH_JSON, JSON.stringify(pullRequests));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const before = await asks();
  const running = pr.sweep(() => gate);
  assert.equal(pr.sweep(), running, "an ordinary sweep joins the one under way");
  const after = pr.sweep(undefined, true);
  assert.equal(pr.sweep(undefined, true), after, "and so do fresh ones, after it");
  release();
  await after;
  assert.equal(await asks(), before + 2);
  console.log("ok");
`;

test("worktree threads follow their pull request and close when it merges", async () => {
  const root = mkdtempSync(join(tmpdir(), "openbuild-pull-requests-"));
  try {
    const bin = join(root, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "$FAKE_GH_LOG"\ncat "$FAKE_GH_JSON"\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const proc = Bun.spawn([process.execPath, "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OPENCHAT_DATA_DIR: join(root, "data"), TEST_ROOT: root, FAKE_GH_JSON: join(root, "prs.json"), FAKE_GH_LOG: join(root, "gh.log"), PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) console.error(out, err);
    expect(code).toBe(0);
    expect(out).toContain("ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
