// The side panel's pull requests tab: the repository's pull requests, and one of them with its
// description, checks, conversation, commits and code, without going to GitHub. A line along the
// bottom always says where the pull request stands, beside what to do about it (usually Merge).
// server/pullRequestView.ts does the asking, through `gh`; lib/pulls.ts says what it all means.
import { ArrowLeft, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleAlert, CircleCheck, CircleDashed, CircleMinus, CircleX, Clock, Ellipsis, ExternalLink, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Pencil, RotateCcw, WrapText, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { PullCheck, PullComment, PullCommit, PullDetail, PullList, PullListState, PullMergeMethod, PullPatch, PullSummary } from "../../shared/types";
import { usePanel, folderKey } from "../lib/panel";
import { commentOnPull, DELETE_KEY, editPull, listPulls, mergePull, mergeReadiness, METHOD_KEY, pullPatch, setPullState, usePullRead, viewPull, type Readiness } from "../lib/pulls";
import type { TerminalFolder } from "../lib/terminal";
import { ago, copyText, cx } from "../lib/ui";
import { FileSection, useDiffFiles, useDiffWrap } from "./DiffView";
import { Markdown } from "./Markdown";
import { Avatar, IconButton, Popover, Spinner, Toggle } from "./primitives";
import { pullRequestTone } from "./PullRequestBadge";

const LIST_REFRESH = 30_000;
const PULL_REFRESH = 20_000;

const METHODS: Record<PullMergeMethod, { label: string; hint: string }> = {
  squash: { label: "Squash and merge", hint: "One commit on the base branch" },
  merge: { label: "Merge commit", hint: "Keep every commit, plus a merge commit" },
  rebase: { label: "Rebase and merge", hint: "Replay the commits on the base branch" },
};

const FILTERS: { id: PullListState; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "merged", label: "Merged" },
  { id: "closed", label: "Closed" },
];

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The pull request's icon, coloured by its state as in the sidebar. */
function PullIcon({ pr, size = 15 }: { pr: Pick<PullSummary, "state" | "checks" | "draft">; size?: number }) {
  const Icon = pr.state === "merged" ? GitMerge : pr.state === "closed" ? GitPullRequestClosed : pr.draft ? GitPullRequestDraft : GitPullRequest;
  return (
    <span className={`pr-badge pr-${pullRequestTone(pr)}`}>
      <Icon size={size} className="pr-icon" />
    </span>
  );
}

function Counts({ adds, dels }: { adds: number; dels: number }) {
  return (
    <span className="dv-count">
      <span className="dv-adds">+{adds}</span>
      <span className="dv-dels">-{dels}</span>
    </span>
  );
}

export function PullRequestsView({ folder }: { folder: TerminalFolder }) {
  const active = usePanel((s) => s.activePull);
  if (!folder.cwd) return <div className="pv"><p className="fv-note">No project folder to look in.</p></div>;
  return typeof active === "number" ? <PullView key={`${folderKey(folder)}#${active}`} folder={folder} number={active} /> : <PullListView folder={folder} resolving={active === "current"} />;
}

// ---------------------------------------------------------------- the list

function PullListView({ folder, resolving }: { folder: TerminalFolder; resolving: boolean }) {
  const [filter, setFilter] = useState<PullListState>("open");
  const { setActivePull } = usePanel.getState();
  const { data, error, loading, reload } = usePullRead<PullList>(`${folderKey(folder)}|list|${filter}`, () => listPulls(folder, filter), LIST_REFRESH);

  // Opened from the launcher or its key: straight to this branch's pull request, when it has one.
  useEffect(() => {
    if (resolving && (data || error)) setActivePull(data?.current);
  }, [resolving, data, error, setActivePull]);

  const pulls = data?.pulls ?? [];
  // This branch's own goes first.
  const sorted = data?.current ? [...pulls.filter((p) => p.number === data.current), ...pulls.filter((p) => p.number !== data.current)] : pulls;
  return (
    <div className="pv">
      <div className="fv-bar pv-listbar">
        <div className="pv-filters" role="tablist" aria-label="Which pull requests">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={cx("pv-filter", filter === f.id && "pv-filter-on")} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        {loading && <Spinner />}
        <IconButton label="Refresh" className="fv-tool" onClick={() => void reload()}>
          <RotateCcw size={13} />
        </IconButton>
      </div>
      <div className="pv-scroll">
        {data && !data.repo ? (
          <p className="fv-note">This folder isn't a git repository.</p>
        ) : data && !data.gh ? (
          <p className="fv-note">Pull requests need the GitHub CLI (gh) on this machine.</p>
        ) : error && !data ? (
          <p className="fv-note">{error}</p>
        ) : !data || resolving ? (
          <p className="fv-note">Loading pull requests…</p>
        ) : !sorted.length ? (
          <p className="fv-note">No {filter} pull requests.</p>
        ) : (
          <ul className="pv-list">
            {sorted.map((pr) => (
              <li key={pr.number}>
                <button type="button" className="pv-row" onClick={() => setActivePull(pr.number)}>
                  <PullIcon pr={pr} />
                  <span className="pv-row-main">
                    <span className="pv-row-title">{pr.title}</span>
                    <span className="pv-row-meta">
                      #{pr.number} · {pr.author} · {ago(pr.updatedAt)}
                      {pr.number === data?.current && <span className="pv-tag">This branch</span>}
                    </span>
                  </span>
                  <Counts adds={pr.additions} dels={pr.deletions} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one pull request

type Tab = "overview" | "commits" | "code";

function PullView({ folder, number }: { folder: TerminalFolder; number: number }) {
  const { setActivePull } = usePanel.getState();
  const { data: pr, error, loading, reload } = usePullRead<PullDetail>(`${folderKey(folder)}|pull|${number}`, () => viewPull(folder, number), PULL_REFRESH);
  const [tab, setTab] = useState<Tab>("overview");
  const [commit, setCommit] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();

  /** Do something to the pull request, then read it again. Says whether it worked. */
  const act = async (what: string, action: () => Promise<unknown>) => {
    if (busy) return false;
    setBusy(what);
    setFailure(undefined);
    try {
      await action();
      await reload(true);
      return true;
    } catch (err) {
      setFailure((err as Error).message);
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const back = () => setActivePull(undefined);
  if (!pr)
    return (
      <div className="pv">
        <div className="fv-bar pv-topbar">
          <IconButton label="All pull requests" className="fv-tool" onClick={back}>
            <ArrowLeft size={14} />
          </IconButton>
          <span className="pv-number">#{number}</span>
        </div>
        <div className="pv-scroll">
          <p className="fv-note">{error ?? "Loading the pull request…"}</p>
        </div>
      </div>
    );

  const readiness = mergeReadiness(pr);
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "commits", label: "Commits", count: pr.commits.length },
    { id: "code", label: "Code", count: pr.changedFiles },
  ];
  return (
    <div className="pv">
      <div className="fv-bar pv-topbar">
        <IconButton label="All pull requests" className="fv-tool" onClick={back}>
          <ArrowLeft size={14} />
        </IconButton>
        <span className="pv-number" title={pr.repo}>
          {pr.repo} <b>#{pr.number}</b>
        </span>
        {(loading || busy) && <Spinner />}
        <a className="icon-btn fv-tool" href={pr.url} target="_blank" rel="noreferrer" aria-label="Open on GitHub" data-tooltip="Open on GitHub" data-tooltip-side="bottom">
          <ExternalLink size={13} />
        </a>
        <PullMenu
          pr={pr}
          onEdit={() => {
            setTab("overview");
            setEditing(true);
          }}
          onState={(action) => void act(action, () => setPullState(folder, number, action))}
        />
      </div>

      <header className="pv-head">
        <h2 className="pv-title">{pr.title}</h2>
        <div className="pv-byline">
          <PullIcon pr={pr} size={14} />
          <span className="pv-state">{pr.state === "open" ? (pr.draft ? "Draft" : "Open") : pr.state === "merged" ? "Merged" : "Closed"}</span>
          <span className="pv-sep">·</span>
          <span>{pr.author}</span>
          <span className="pv-sep">·</span>
          <span>updated {ago(pr.updatedAt)}</span>
        </div>
        <div className="pv-branches" title={`${pr.head} into ${pr.base}`}>
          <span className="pv-branch">{pr.base}</span>
          <span className="pv-arrow">←</span>
          <span className="pv-branch pv-branch-head">{pr.head}</span>
        </div>
      </header>

      <div className="pv-tabs" role="tablist" aria-label="Pull request">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={cx("pv-tab", tab === t.id && "pv-tab-on")} onClick={() => setTab(t.id)}>
            {t.label}
            {t.count !== undefined && <span className="pv-tab-count">{t.count}</span>}
          </button>
        ))}
        <span className="pv-tabs-end">
          <Counts adds={pr.additions} dels={pr.deletions} />
        </span>
      </div>

      {tab === "overview" && <Overview folder={folder} pr={pr} editing={editing} setEditing={setEditing} act={act} busy={busy} />}
      {tab === "commits" && (
        <CommitList
          commits={pr.commits}
          onPick={(sha) => {
            setCommit(sha);
            setTab("code");
          }}
        />
      )}
      {tab === "code" && <CodeTab folder={folder} pr={pr} commit={pr.commits.find((c) => c.sha === commit)} clearCommit={() => setCommit(undefined)} />}

      <StatusBar folder={folder} pr={pr} readiness={readiness} busy={busy} failure={failure} clearFailure={() => setFailure(undefined)} act={act} />
    </div>
  );
}

function PullMenu({ pr, onEdit, onState }: { pr: PullDetail; onEdit(): void; onState(action: "close" | "reopen"): void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const choose = (then: () => void) => () => {
    setOpen(false);
    then();
  };
  return (
    <>
      <IconButton ref={anchor} label="More" className="fv-tool" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Ellipsis size={14} />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu side-menu" role="menu" label="Pull request" fixed="down" align="end">
        <button type="button" role="menuitem" className="menu-item" disabled={!pr.canWrite} onClick={choose(onEdit)}>
          <span className="menu-item-label">Edit title and description</span>
        </button>
        <button type="button" role="menuitem" className="menu-item" onClick={choose(() => void copyText(`gh pr checkout ${pr.number}`))}>
          <span className="menu-item-label">Copy checkout command</span>
        </button>
        {pr.state !== "merged" && (
          <>
            <div className="menu-sep" />
            {pr.state === "open" ? (
              <button type="button" role="menuitem" className="menu-item menu-item-danger" disabled={!pr.canWrite} onClick={choose(() => onState("close"))}>
                <span className="menu-item-label">Close pull request</span>
              </button>
            ) : (
              <button type="button" role="menuitem" className="menu-item" disabled={!pr.canWrite} onClick={choose(() => onState("reopen"))}>
                <span className="menu-item-label">Reopen pull request</span>
              </button>
            )}
          </>
        )}
      </Popover>
    </>
  );
}

type Act = (what: string, action: () => Promise<unknown>) => Promise<boolean>;

// ---------------------------------------------------------------- overview

function Overview({ folder, pr, editing, setEditing, act, busy }: { folder: TerminalFolder; pr: PullDetail; editing: boolean; setEditing(on: boolean): void; act: Act; busy?: string }) {
  return (
    <div className="pv-scroll">
      <div className="pv-page">
        {editing ? (
          <EditForm folder={folder} pr={pr} act={act} busy={busy} onDone={() => setEditing(false)} />
        ) : (
          <section className="pv-section">
            <div className="pv-label">
              Description
              {pr.canWrite && (
                <IconButton label="Edit title and description" tooltip="Edit" className="fv-tool pv-label-tool" onClick={() => setEditing(true)}>
                  <Pencil size={12} />
                </IconButton>
              )}
            </div>
            {pr.body.trim() ? <Markdown content={pr.body} className="pv-md" /> : <p className="pv-none">No description.</p>}
          </section>
        )}
        <Checks checks={pr.checkList} />
        <Facts pr={pr} />
        <Conversation folder={folder} pr={pr} act={act} busy={busy} />
      </div>
    </div>
  );
}

function EditForm({ folder, pr, act, busy, onDone }: { folder: TerminalFolder; pr: PullDetail; act: Act; busy?: string; onDone(): void }) {
  const [title, setTitle] = useState(pr.title);
  const [body, setBody] = useState(pr.body);
  const [preview, setPreview] = useState(false);
  const save = async () => {
    if (await act("edit", () => editPull(folder, pr.number, title, body))) onDone();
  };
  return (
    <section className="pv-section pv-edit">
      <input className="pv-input" aria-label="Title" value={title} maxLength={256} onChange={(e) => setTitle(e.target.value)} />
      <div className="pv-filters">
        <button type="button" className={cx("pv-filter", !preview && "pv-filter-on")} onClick={() => setPreview(false)}>Write</button>
        <button type="button" className={cx("pv-filter", preview && "pv-filter-on")} onClick={() => setPreview(true)}>Preview</button>
      </div>
      {preview ? (
        <div className="pv-preview">{body.trim() ? <Markdown content={body} className="pv-md" /> : <p className="pv-none">Nothing to preview.</p>}</div>
      ) : (
        <textarea className="pv-input pv-textarea" aria-label="Description" rows={10} value={body} autoFocus onChange={(e) => setBody(e.target.value)} onKeyDown={submitOnModEnter(save)} />
      )}
      <div className="pv-form-actions">
        <button type="button" className="btn btn-sm" onClick={onDone}>Cancel</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!!busy || !title.trim()} onClick={() => void save()}>Save</button>
      </div>
    </section>
  );
}

const submitOnModEnter = (submit: () => unknown) => (e: KeyboardEvent) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    void submit();
  }
};

const CHECK_ICON: Record<PullCheck["state"], ReactNode> = {
  passing: <CircleCheck size={14} className="pv-ok" />,
  failing: <CircleX size={14} className="pv-bad" />,
  pending: <Clock size={14} className="pv-wait" />,
  skipped: <CircleMinus size={14} className="pv-quiet" />,
};
const CHECK_ORDER: PullCheck["state"][] = ["failing", "pending", "passing", "skipped"];
const CHECK_WORD: Record<PullCheck["state"], string> = { failing: "failing", pending: "running", passing: "passed", skipped: "skipped" };

function Checks({ checks }: { checks: PullCheck[] }) {
  const [open, setOpen] = useState<boolean>();
  const sorted = useMemo(() => [...checks].sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state)), [checks]);
  if (!checks.length) return null;
  // Something wrong or unfinished stays in view until it's put away.
  const showing = open ?? checks.some((c) => c.state === "failing");
  const summary = CHECK_ORDER.map((s) => [checks.filter((c) => c.state === s).length, s] as const)
    .filter(([n]) => n)
    .map(([n, s]) => `${n} ${CHECK_WORD[s]}`)
    .join(" · ");
  return (
    <section className="pv-section">
      <button type="button" className="pv-label pv-fold" aria-expanded={showing} onClick={() => setOpen(!showing)}>
        {showing ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Checks
        <span className="pv-label-note">{summary}</span>
      </button>
      {showing && (
        <ul className="pv-checks">
          {sorted.map((c, i) => (
            <li key={`${c.name}:${i}`}>
              {c.url ? (
                <a className="pv-check" href={c.url} target="_blank" rel="noreferrer">
                  {CHECK_ICON[c.state]}
                  <span className="pv-check-name">{c.name}</span>
                  <ExternalLink size={11} className="pv-check-link" />
                </a>
              ) : (
                <span className="pv-check">
                  {CHECK_ICON[c.state]}
                  <span className="pv-check-name">{c.name}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function reviewIcon(state?: string) {
  if (state === "APPROVED") return <Check size={12} className="pv-ok" aria-label="Approved" />;
  if (state === "CHANGES_REQUESTED") return <CircleAlert size={12} className="pv-bad" aria-label="Changes requested" />;
  if (state === "COMMENTED") return <CircleDashed size={12} className="pv-quiet" aria-label="Commented" />;
  return <Clock size={12} className="pv-quiet" aria-label="Review requested" />;
}

function Facts({ pr }: { pr: PullDetail }) {
  if (!pr.reviewers.length && !pr.labels.length) return null;
  return (
    <section className="pv-section pv-facts">
      {pr.reviewers.length > 0 && (
        <>
          <span className="pv-fact-key">Reviewers</span>
          <span className="pv-fact-value">
            {pr.reviewers.map((r) => (
              <span key={r.login} className="pv-chip">
                {reviewIcon(r.state)}
                {r.login}
              </span>
            ))}
          </span>
        </>
      )}
      {pr.labels.length > 0 && (
        <>
          <span className="pv-fact-key">Labels</span>
          <span className="pv-fact-value">
            {pr.labels.map((l) => (
              <span key={l.name} className="pv-chip">
                <span className="pv-dot" style={{ background: `#${l.color}` }} />
                {l.name}
              </span>
            ))}
          </span>
        </>
      )}
    </section>
  );
}

const VERDICT: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed", DISMISSED: "review dismissed" };

/** Someone's picture on GitHub (an app's login comes as "app/name"). */
const avatarOf = (login: string, url: string) => {
  try {
    return `${new URL(url).origin}/${login.replace(/^app\//, "")}.png?size=48`;
  } catch {
    return undefined;
  }
};

function Comment({ comment, url }: { comment: PullComment; url: string }) {
  return (
    <article className="pv-comment">
      <Avatar src={avatarOf(comment.author, url)} name={comment.author} size={20} />
      <div className="pv-comment-main">
        <div className="pv-comment-head">
          <b>{comment.author}</b>
          {comment.verdict && VERDICT[comment.verdict] && <span>{VERDICT[comment.verdict]}</span>}
          <span>{ago(comment.at)}</span>
        </div>
        <Markdown content={comment.body} className="pv-md" />
      </div>
    </article>
  );
}

function Conversation({ folder, pr, act, busy }: { folder: TerminalFolder; pr: PullDetail; act: Act; busy?: string }) {
  const [text, setText] = useState("");
  const send = async () => {
    if (!text.trim()) return;
    if (await act("comment", () => commentOnPull(folder, pr.number, text))) setText("");
  };
  return (
    <section className="pv-section">
      <div className="pv-label">Conversation{pr.comments.length > 0 && <span className="pv-label-note">{pr.comments.length}</span>}</div>
      {pr.comments.map((c) => (
        <Comment key={c.id} comment={c} url={pr.url} />
      ))}
      <div className="pv-compose">
        <textarea className="pv-input pv-textarea" aria-label="Write a comment" placeholder="Leave a comment" rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={submitOnModEnter(send)} />
        {text.trim() && (
          <div className="pv-form-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={!!busy} onClick={() => void send()}>Comment</button>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- commits and code

function CommitList({ commits, onPick }: { commits: PullCommit[]; onPick(sha: string): void }) {
  if (!commits.length) return <div className="pv-scroll"><p className="fv-note">No commits.</p></div>;
  return (
    <div className="pv-scroll">
      <ul className="pv-list">
        {commits.map((c) => (
          <li key={c.sha}>
            <button type="button" className="pv-row" title="Show this commit's changes" onClick={() => onPick(c.sha)}>
              <GitCommitHorizontal size={15} className="pv-quiet" />
              <span className="pv-row-main">
                <span className="pv-row-title">{c.title}</span>
                <span className="pv-row-meta">
                  <code>{c.sha.slice(0, 7)}</code> · {c.author} · {ago(c.at)}
                </span>
              </span>
              <ChevronRight size={13} className="pv-quiet" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CodeTab({ folder, pr, commit, clearCommit }: { folder: TerminalFolder; pr: PullDetail; commit?: PullCommit; clearCommit(): void }) {
  // The whole pull request's diff changes when its head does; a commit's never does.
  const key = `${folderKey(folder)}|patch|${pr.number}|${commit ? commit.sha : pr.headSha}`;
  const { data, error, loading, reload } = usePullRead<PullPatch>(key, () => pullPatch(folder, pr.number, commit?.sha), 0);
  const { files, isOpen, toggle, allFolded, toggleAll, reset, adds, dels } = useDiffFiles(data?.patch);
  const [wrap, toggleWrap] = useDiffWrap();
  useEffect(reset, [key, reset]);
  return (
    <>
      <div className="fv-bar pv-codebar">
        {commit ? (
          <span className="pv-commit-chip" title={commit.title}>
            <code>{commit.sha.slice(0, 7)}</code>
            <span className="pv-commit-title">{commit.title}</span>
            <button type="button" aria-label="Show all commits" data-tooltip="All commits" data-tooltip-side="bottom" onClick={clearCommit}>
              <X size={11} />
            </button>
          </span>
        ) : (
          <span className="fv-path">All commits</span>
        )}
        <span className="fv-path pv-code-stat">
          {files.length > 0 && (
            <>
              {plural(files.length, "file")} <span className="dv-adds">+{adds}</span> <span className="dv-dels">-{dels}</span>
            </>
          )}
        </span>
        {loading && <Spinner />}
        <IconButton label={allFolded ? "Expand all files" : "Collapse all files"} className="fv-tool" disabled={!files.length} onClick={toggleAll}>
          {allFolded ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
        </IconButton>
        <IconButton label={wrap ? "Don't wrap lines" : "Wrap lines"} className={cx("fv-tool", wrap && "fv-tool-on")} aria-pressed={wrap} onClick={toggleWrap}>
          <WrapText size={14} />
        </IconButton>
        <IconButton label="Refresh the diff" className="fv-tool" onClick={() => void reload()}>
          <RotateCcw size={13} />
        </IconButton>
      </div>
      <div className={cx("dv-body", wrap && "dv-wrap")}>
        {error && !data ? (
          <p className="fv-note">{error}</p>
        ) : !data ? (
          <p className="fv-note">Loading the diff…</p>
        ) : !files.length ? (
          <p className="fv-note">No changes.</p>
        ) : (
          <>
            {files.map((f) => (
              <FileSection key={f.path} file={f} open={isOpen(f)} onToggle={toggle} />
            ))}
            {data.truncated && <p className="dv-truncated">The diff is too big to show all of it.</p>}
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- where it stands, and what to do

const READINESS_ICON: Record<Readiness["tone"], ReactNode> = {
  ok: <CircleCheck size={14} className="pv-ok" />,
  wait: <Clock size={14} className="pv-wait" />,
  warn: <CircleAlert size={14} className="pv-wait" />,
  bad: <CircleX size={14} className="pv-bad" />,
  merged: <GitMerge size={14} className="pv-merged" />,
  closed: <GitPullRequestClosed size={14} className="pv-bad" />,
  draft: <GitPullRequestDraft size={14} className="pv-quiet" />,
};

function StatusBar({ folder, pr, readiness, busy, failure, clearFailure, act }: { folder: TerminalFolder; pr: PullDetail; readiness: Readiness; busy?: string; failure?: string; clearFailure(): void; act: Act }) {
  const when = pr.state === "merged" ? pr.mergedAt : pr.state === "closed" ? pr.closedAt : undefined;
  return (
    <footer className="pv-foot">
      {failure && (
        <div className="pv-failure" role="alert">
          <span>{failure}</span>
          <button type="button" aria-label="Dismiss" onClick={clearFailure}>
            <X size={12} />
          </button>
        </div>
      )}
      <div className="pv-foot-row">
        <span className="pv-status">
          {READINESS_ICON[readiness.tone]}
          <span>
            {readiness.text}
            {when ? ` ${ago(when)}` : ""}
          </span>
        </span>
        {pr.canWrite && pr.state === "open" && !pr.draft && <MergeButton folder={folder} pr={pr} readiness={readiness} busy={busy} act={act} />}
        {pr.canWrite && pr.state === "open" && pr.draft && (
          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void act("ready", () => setPullState(folder, pr.number, "ready"))}>
            Ready for review
          </button>
        )}
        {pr.canWrite && pr.state === "closed" && (
          <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void act("reopen", () => setPullState(folder, pr.number, "reopen"))}>
            Reopen
          </button>
        )}
      </div>
    </footer>
  );
}

function MergeButton({ folder, pr, readiness, busy, act }: { folder: TerminalFolder; pr: PullDetail; readiness: Readiness; busy?: string; act: Act }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const [remove, setRemove] = useState(() => localStorage.getItem(DELETE_KEY) === "1");
  const last = localStorage.getItem(METHOD_KEY);
  const methods: PullMergeMethod[] = pr.methods.length ? pr.methods : ["merge"];
  const merge = (method: PullMergeMethod) => {
    setOpen(false);
    localStorage.setItem(METHOD_KEY, method);
    void act("merge", () => mergePull(folder, pr.number, method, pr.headSha, remove));
  };
  const merging = busy === "merge";
  return (
    <>
      <button ref={anchor} type="button" className="btn btn-sm btn-primary pv-merge" disabled={!readiness.canMerge || !!busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {merging ? <Spinner size={13} /> : <GitMerge size={14} />}
        {merging ? "Merging…" : "Merge"}
        {!merging && <ChevronDown size={13} />}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu pv-merge-menu" role="menu" label="Merge" fixed="up" align="end">
        <div className="menu-label">
          Merge {pr.head} into {pr.base}
        </div>
        {methods.map((m) => (
          <button key={m} type="button" role="menuitem" className="menu-item pv-merge-item" onClick={() => merge(m)}>
            <span className="menu-item-label">
              {METHODS[m].label}
              <small>{METHODS[m].hint}</small>
            </span>
            {last === m && <Check size={14} className="menu-check" />}
          </button>
        ))}
        <div className="menu-sep" />
        <label className="pv-merge-option">
          <span>Delete the branch on GitHub</span>
          <Toggle
            label="Delete the branch on GitHub"
            checked={remove}
            onChange={(on) => {
              localStorage.setItem(DELETE_KEY, on ? "1" : "0");
              setRemove(on);
            }}
          />
        </label>
      </Popover>
    </>
  );
}
