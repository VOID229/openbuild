// The side panel's pull requests tab (src/components/PullRequestsView.tsx): listing a repository's
// pull requests, reading one with its checks, comments, commits and diff, and acting on it (merging,
// editing, commenting, closing). All of it goes through GitHub's `gh`, signed in as the user.
//
// Actions name the repository with `--repo`. Besides being explicit, that keeps `gh pr merge
// --delete-branch` away from local branches: a worktree's checkout is the thread's, not ours to switch.
import type { PullCheck, PullComment, PullCommit, PullDetail, PullList, PullListState, PullMergeMethod, PullPatch, PullSummary } from "../shared/types";
import { checksOf, FAILED, sweep } from "./pullRequests";
import { fail, gh, MAX_VIEW_DIFF, run } from "./workspaceGit";

const READ_TIMEOUT = 45_000;
const ACTION_TIMEOUT = 2 * 60_000;
const LIST_LIMIT = 50;
/** GitHub's own limit on a title. */
const MAX_TITLE = 256;
/** A single command-line argument can't be longer (Linux); GitHub stops at 65,536 characters anyway. */
const MAX_BODY_BYTES = 130_000;

const SUMMARY_FIELDS = "number,title,url,state,isDraft,author,headRefName,baseRefName,additions,deletions,updatedAt,statusCheckRollup";
const DETAIL_FIELDS = `${SUMMARY_FIELDS},body,headRefOid,changedFiles,mergeable,mergeStateStatus,reviewDecision,mergedAt,closedAt,reviewRequests,latestReviews,reviews,labels,comments,commits`;

type GhRollup = { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string; detailsUrl?: string; targetUrl?: string }[];
type GhAuthor = { login?: string } | null;

interface GhSummary {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
  isCrossRepository?: boolean;
  author?: GhAuthor;
  headRefName: string;
  baseRefName: string;
  additions?: number;
  deletions?: number;
  updatedAt: string;
  statusCheckRollup?: GhRollup | null;
}

interface GhDetail extends GhSummary {
  body?: string;
  headRefOid: string;
  changedFiles?: number;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  reviewRequests?: { login?: string; name?: string; slug?: string }[];
  latestReviews?: { author?: GhAuthor; state?: string }[];
  reviews?: { id?: string; author?: GhAuthor; body?: string; state?: string; submittedAt?: string }[];
  labels?: { name: string; color: string }[];
  comments?: { id?: string; author?: GhAuthor; body?: string; createdAt?: string }[];
  commits?: { oid: string; messageHeadline?: string; committedDate?: string; authors?: { login?: string; name?: string }[] }[];
}

interface GhRepo {
  nameWithOwner: string;
  url: string;
  squashMergeAllowed?: boolean;
  mergeCommitAllowed?: boolean;
  rebaseMergeAllowed?: boolean;
  viewerPermission?: string;
}

const time = (at: string | null | undefined) => {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** One check's result, in the words the panel draws. */
export function checkOf(check: GhRollup[number]): PullCheck {
  const result = check.conclusion || check.state;
  const state: PullCheck["state"] =
    result && FAILED.has(result) ? "failing" : result === "SKIPPED" || result === "NEUTRAL" ? "skipped" : (check.status && check.status !== "COMPLETED") || result === "PENDING" || result === "EXPECTED" ? "pending" : "passing";
  const url = check.detailsUrl || check.targetUrl;
  return { name: check.name || check.context || "Check", state, ...(url ? { url } : {}) };
}

export function toSummary(pr: GhSummary): PullSummary {
  const checks = checksOf(pr.statusCheckRollup);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : "open",
    ...(pr.isDraft ? { draft: true } : {}),
    ...(checks ? { checks } : {}),
    author: pr.author?.login ?? "ghost",
    head: pr.headRefName,
    base: pr.baseRefName,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    updatedAt: time(pr.updatedAt) ?? 0,
  };
}

export function toDetail(pr: GhDetail, repo: GhRepo): PullDetail {
  // Latest answers first, then whoever is still being waited on (a team has a name, not a login).
  const reviewers = new Map<string, string | undefined>();
  for (const r of pr.latestReviews ?? []) if (r.author?.login) reviewers.set(r.author.login, r.state);
  for (const r of pr.reviewRequests ?? []) {
    const login = r.login ?? r.slug ?? r.name;
    if (login && !reviewers.has(login)) reviewers.set(login, undefined);
  }
  const comments: PullComment[] = (pr.comments ?? []).map((c, i) => ({ id: c.id ?? `c${i}`, author: c.author?.login ?? "ghost", body: c.body ?? "", at: time(c.createdAt) ?? 0 }));
  // A review with nothing to say (an approval with no note) is already in the reviewers.
  for (const [i, r] of (pr.reviews ?? []).entries())
    if (r.body?.trim()) comments.push({ id: r.id ?? `r${i}`, author: r.author?.login ?? "ghost", body: r.body, at: time(r.submittedAt) ?? 0, ...(r.state ? { verdict: r.state } : {}) });
  comments.sort((a, b) => a.at - b.at);
  const commits: PullCommit[] = (pr.commits ?? []).map((c) => ({
    sha: c.oid,
    title: c.messageHeadline ?? c.oid.slice(0, 7),
    author: c.authors?.[0]?.login || c.authors?.[0]?.name || "unknown",
    at: time(c.committedDate) ?? 0,
  }));
  const methods: PullMergeMethod[] = [];
  if (repo.squashMergeAllowed) methods.push("squash");
  if (repo.mergeCommitAllowed) methods.push("merge");
  if (repo.rebaseMergeAllowed) methods.push("rebase");
  const mergedAt = time(pr.mergedAt);
  const closedAt = time(pr.closedAt);
  return {
    ...toSummary(pr),
    repo: repo.nameWithOwner,
    body: pr.body ?? "",
    headSha: pr.headRefOid,
    changedFiles: pr.changedFiles ?? 0,
    mergeable: pr.mergeable ?? "UNKNOWN",
    mergeState: pr.mergeStateStatus ?? "UNKNOWN",
    ...(pr.reviewDecision ? { reviewDecision: pr.reviewDecision } : {}),
    ...(mergedAt ? { mergedAt } : {}),
    ...(closedAt ? { closedAt } : {}),
    checkList: (pr.statusCheckRollup ?? []).map(checkOf),
    reviewers: [...reviewers].map(([login, state]) => (state ? { login, state } : { login })),
    labels: pr.labels ?? [],
    comments,
    commits,
    methods,
    canWrite: ["WRITE", "MAINTAIN", "ADMIN"].includes(repo.viewerPermission ?? ""),
  };
}

/** `https://github.com/o/r` → `github.com/o/r`, which `--repo` takes for any GitHub host. */
export const repoFlag = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/+$/, "");

/** `gh`, or why it can't be used. */
function bin(): string {
  const path = gh();
  if (!path) throw new Error("Pull requests need the GitHub CLI (gh) on this machine");
  return path;
}

function parse<T>(out: string): T {
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new Error("gh answered with something that isn't JSON");
  }
}

const validNumber = (n: unknown): number => {
  const v = typeof n === "string" ? Number(n) : n;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Error("Expected a pull request number");
  return v;
};

const validSha = (sha: unknown): string => {
  if (typeof sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error("Expected a commit");
  return sha;
};

// What the repository allows barely changes, and every read needs it.
const REPO_TTL = 60_000;
const repos = new Map<string, { at: number; repo: GhRepo }>();

async function repoOf(cwd: string): Promise<GhRepo> {
  const known = repos.get(cwd);
  if (known && Date.now() - known.at < REPO_TTL) return known.repo;
  const r = await run([bin(), "repo", "view", "--json", "nameWithOwner,url,squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,viewerPermission"], cwd, READ_TIMEOUT);
  if (r.code !== 0) fail(r, "gh couldn't find this repository on GitHub");
  const repo = parse<GhRepo>(r.out);
  repos.set(cwd, { at: Date.now(), repo });
  return repo;
}

// Reads are shared for a few seconds by everything looking at the same repository: every worktree
// of a project asks about the same pull requests, and the panel asks again whenever it's shown.
const READ_TTL = 15_000;
const reads = new Map<string, { at: number; value: Promise<unknown> }>();

/** `load`'s answer under `key`, reused for READ_TTL unless `fresh`; one ask at a time, and failures aren't kept. */
function shared<T>(key: string, fresh: boolean, load: () => Promise<T>): Promise<T> {
  const known = reads.get(key);
  if (known && !fresh && Date.now() - known.at < READ_TTL) return known.value as Promise<T>;
  const value = load();
  const entry = { at: Date.now(), value };
  reads.set(key, entry);
  value.catch(() => reads.get(key) === entry && reads.delete(key));
  return value;
}

/** Forget what was read about a repository, after acting on it. */
const forget = (common: string) => {
  for (const key of reads.keys()) if (key.startsWith(`${common}|`)) reads.delete(key);
};

/** The repository a folder belongs to (its worktrees share it), and the branch it's on ("" when detached). */
async function whereIs(cwd: string): Promise<{ common: string; branch: string } | undefined> {
  const r = await run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir", "--symbolic-full-name", "HEAD"], cwd, 10_000);
  if (r.code !== 0) return undefined;
  const [common = cwd, head = ""] = r.out.split("\n");
  return { common, branch: head.startsWith("refs/heads/") ? head.slice("refs/heads/".length) : "" };
}

const repoKey = async (cwd: string) => (await whereIs(cwd))?.common ?? cwd;

/** A repository's pull requests in one state, newest first, and which of them this folder's branch opened. */
export async function list(cwd: string, state: unknown, fresh = false): Promise<PullList> {
  const where = await whereIs(cwd);
  if (!where) return { gh: !!gh(), repo: false, pulls: [] };
  const path = gh();
  if (!path) return { gh: false, repo: true, pulls: [] };
  const wanted: PullListState = state === "merged" || state === "closed" ? state : "open";
  const prs = await shared(`${where.common}|list|${wanted}`, fresh, async () => {
    const r = await run([path, "pr", "list", "--state", wanted, "--limit", String(LIST_LIMIT), "--json", `${SUMMARY_FIELDS},isCrossRepository`], cwd, READ_TIMEOUT);
    if (r.code !== 0) fail(r, "gh pr list failed");
    return parse<GhSummary[]>(r.out);
  });
  // Someone's fork can have a branch of the same name.
  const current = where.branch ? prs.find((pr) => pr.state === "OPEN" && !pr.isCrossRepository && pr.headRefName === where.branch)?.number : undefined;
  return { gh: true, repo: true, pulls: prs.map(toSummary), ...(current ? { current } : {}) };
}

/** The GitHub repository this folder's pull requests are in, so links to them can open in the tab. */
export async function repository(cwd: string): Promise<{ url: string }> {
  bin();
  return { url: (await repoOf(cwd)).url };
}

export async function view(cwd: string, number: unknown, fresh = false): Promise<PullDetail> {
  const n = validNumber(number);
  return shared(`${await repoKey(cwd)}|view|${n}`, fresh, async () => {
    const [repo, r] = await Promise.all([repoOf(cwd), run([bin(), "pr", "view", String(n), "--json", DETAIL_FIELDS], cwd, READ_TIMEOUT)]);
    if (r.code !== 0) fail(r, `gh couldn't read pull request #${n}`);
    return toDetail(parse<GhDetail>(r.out), repo);
  });
}

/** A pull request's whole diff, or one of its commits'. */
export async function patch(cwd: string, number: unknown, sha?: unknown): Promise<PullPatch> {
  const n = validNumber(number);
  let r;
  if (sha) {
    const repo = await repoOf(cwd);
    const host = new URL(repo.url).host;
    r = await run([bin(), "api", "--hostname", host, "-H", "Accept: application/vnd.github.diff", `repos/${repo.nameWithOwner}/commits/${validSha(sha)}`], cwd, READ_TIMEOUT);
  } else r = await run([bin(), "pr", "diff", String(n), "--color", "never"], cwd, READ_TIMEOUT);
  if (r.code !== 0) fail(r, `gh couldn't read the diff of #${n}`);
  const truncated = r.out.length > MAX_VIEW_DIFF;
  return { patch: truncated ? r.out.slice(0, MAX_VIEW_DIFF) : r.out, ...(truncated ? { truncated } : {}) };
}

/** Run `gh pr <verb> <number> --repo … <args>`. */
async function act(cwd: string, verb: string, number: unknown, args: string[] = []) {
  const n = validNumber(number);
  const repo = await repoOf(cwd);
  const r = await run([bin(), "pr", verb, String(n), "--repo", repoFlag(repo.url), ...args], cwd, ACTION_TIMEOUT);
  forget(await repoKey(cwd));
  if (r.code !== 0) fail(r, `gh pr ${verb} failed`);
}

/**
 * Merge the pull request, as long as its head is still the commit the user was looking at (GitHub
 * refuses otherwise), then look at the threads' pull requests again before answering, so the thread
 * it merged is already closed when the browser next loads its threads.
 */
export async function merge(cwd: string, number: unknown, method: unknown, headSha: unknown, deleteBranch: unknown) {
  if (method !== "squash" && method !== "merge" && method !== "rebase") throw new Error("Expected a merge method");
  await act(cwd, "merge", number, [`--${method}`, "--match-head-commit", validSha(headSha), ...(deleteBranch === true ? ["--delete-branch"] : [])]);
  await sweep(undefined, true);
  return { ok: true };
}

export async function edit(cwd: string, number: unknown, title: unknown, body: unknown) {
  if (typeof title !== "string" || !title.trim() || title.length > MAX_TITLE) throw new Error("A pull request needs a title");
  if (typeof body !== "string" || Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("That description is too long");
  await act(cwd, "edit", number, ["--title", title.trim(), "--body", body]);
  return { ok: true };
}

export async function comment(cwd: string, number: unknown, body: unknown) {
  if (typeof body !== "string" || !body.trim() || Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("A comment needs some text");
  await act(cwd, "comment", number, ["--body", body]);
  return { ok: true };
}

/** Close, reopen or mark a draft ready. */
export async function setState(cwd: string, number: unknown, action: unknown) {
  if (action !== "close" && action !== "reopen" && action !== "ready") throw new Error("Expected close, reopen or ready");
  await act(cwd, action, number);
  void sweep(undefined, true);
  return { ok: true };
}
