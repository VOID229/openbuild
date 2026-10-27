// The thread header's Commit button: one icon button among the panel's switches that opens the menu:
// a message (left blank, the text generation models write it), which changes go in, and commit,
// commit and push, push, or open a pull request. The git itself is server/workspaceGit.ts; which
// changes are this thread's is src/lib/git.ts.
import { ArrowUp, Check, ChevronDown, CloudUpload, ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GitChange } from "../../shared/types";
import { commitPaths, commitScope, gitCommit, gitPullRequest, gitPush, useGitChanges, writeCommitMessage } from "../lib/git";
import { useStore } from "../lib/store";
import type { Chat } from "../lib/types";
import { cx } from "../lib/ui";
import { IconButton, Popover, Spinner } from "./primitives";

type Action = "commit" | "commit-push" | "push" | "pr";

const STATUS: Record<GitChange["status"], string> = { M: "M", A: "A", D: "D", R: "R", "?": "U", U: "!" };
const STATUS_LABEL: Record<GitChange["status"], string> = { M: "Changed", A: "Added", D: "Deleted", R: "Renamed", "?": "New", U: "Conflict" };

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function GitMenu({ chat, streaming }: { chat: Chat; streaming: boolean }) {
  const ws = chat.workspace;
  const [tick, setTick] = useState(0);
  const changes = useGitChanges(ws, streaming, tick);
  const chats = useStore((s) => s.chats);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState("");
  // Whether to commit only this thread's files; unset follows the default for the checkout.
  const [onlyMine, setOnlyMine] = useState<boolean>();
  const [busy, setBusy] = useState<{ action: Action; step: string }>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ text: string; short: string; url?: string }>();
  const [showFiles, setShowFiles] = useState(false);

  const scope = useMemo(() => (changes?.repo ? commitScope(chat, changes, chats) : undefined), [chat, changes, chats]);
  useEffect(() => {
    setOnlyMine(undefined);
    setMessage("");
    setError(undefined);
    setDone(undefined);
  }, [chat.id]);
  // A finished action's note fades after a while, once the menu is closed.
  useEffect(() => {
    if (!done || open) return;
    const t = setTimeout(() => setDone(undefined), 4000);
    return () => clearTimeout(t);
  }, [done, open]);

  if (!ws || !changes?.repo || !scope) return null;

  const mine = (onlyMine ?? scope.separable) && scope.separable;
  const files = mine ? scope.mine : changes.files;
  const conflicted = files.some((f) => f.status === "U");
  const canCommit = files.length > 0 && !conflicted;
  const branch = changes.branch;
  const canPush = !!branch && (!!changes.ahead || (!changes.upstream && !!changes.remote));
  const prBlocked = !changes.gh
    ? "Needs the GitHub CLI (gh) on this machine"
    : !branch
      ? "Not on a branch"
      : !changes.remote
        ? "This repository has no remote"
        : changes.defaultBranch === branch
          ? `You're on ${branch}, the default branch`
          : undefined;
  const primary: Action | undefined = canCommit ? "commit" : canPush ? "push" : undefined;

  const run = async (action: Action) => {
    if (busy) return;
    setError(undefined);
    setDone(undefined);
    const paths = mine ? commitPaths(files) : undefined;
    try {
      let sha: string | undefined;
      if (action === "commit" || action === "commit-push") {
        let text = message.trim();
        if (!text) {
          setBusy({ action, step: "Writing message…" });
          text = await writeCommitMessage(ws, chat, paths);
        }
        setBusy({ action, step: "Committing…" });
        sha = (await gitCommit(ws, text, paths)).sha;
        setMessage("");
        setOnlyMine(undefined);
      }
      if (action === "commit-push" || action === "push") {
        setBusy({ action, step: "Pushing…" });
        const r = await gitPush(ws);
        setDone({ text: sha ? `Committed ${sha} and pushed to ${r.upstream}` : `Pushed to ${r.upstream}`, short: "Pushed" });
      } else if (action === "pr") {
        setBusy({ action, step: "Opening pull request…" });
        const r = await gitPullRequest(ws);
        setDone({ text: r.existing ? "This branch already has a pull request" : "Pull request opened", short: "PR ready", url: r.url });
        setOpen(true);
      } else setDone({ text: `Committed ${sha}`, short: "Committed" });
    } catch (err) {
      setError((err as Error).message);
      // Say what went wrong where there's room to read it.
      setOpen(true);
    } finally {
      setBusy(undefined);
      setTick((t) => t + 1);
    }
  };

  const ahead = changes.ahead ? `↑${changes.ahead}` : "";
  const behind = changes.behind ? `↓${changes.behind}` : "";
  const tooltip = busy
    ? busy.step
    : done && !open
      ? done.text
      : primary === "commit"
        ? `Commit ${mine ? "this thread's" : "all"} ${plural(files.length, "change")}`
        : primary === "push"
          ? `Push ${plural(changes.ahead ?? 0, "commit")} to ${changes.upstream ?? changes.remote}`
          : conflicted
            ? "Resolve the conflicts first"
            : "Nothing to commit";

  return (
    <>
      <IconButton
        ref={anchor}
        label="Commit and push actions"
        tooltip={tooltip}
        className={cx("thread-tool", open && "thread-tool-on")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? <Spinner size={15} /> : done && !open ? <Check size={16} /> : primary === "push" ? <ArrowUp size={16} /> : <GitBranch size={16} />}
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu git-menu" label="Commit" fixed="down" align="end">
        <div className="git-head">
          <span className="git-branch">{branch ?? "Detached HEAD"}</span>
          {(ahead || behind) && (
            <span className="git-sync" data-tooltip={[changes.ahead && `${plural(changes.ahead, "commit")} to push`, changes.behind && `${plural(changes.behind, "commit")} to pull`].filter(Boolean).join(", ")}>
              {ahead} {behind}
            </span>
          )}
        </div>
        <textarea
          ref={input}
          className="git-message"
          value={message}
          rows={Math.min(6, Math.max(2, message.split("\n").length))}
          placeholder="Commit message (leave blank to generate)"
          aria-label="Commit message"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter commits, like the composer sends.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) {
              e.preventDefault();
              void run("commit");
            }
          }}
        />
        {scope.separable && (
          <div className="git-scope" role="radiogroup" aria-label="What to commit">
            <button type="button" role="radio" aria-checked={mine} className="git-scope-option" onClick={() => setOnlyMine(true)}>
              <span className="git-scope-name">This thread</span>
              <span className="git-scope-count">{plural(scope.mine.length, "file")}</span>
            </button>
            <button type="button" role="radio" aria-checked={!mine} className="git-scope-option" onClick={() => setOnlyMine(false)}>
              <span className="git-scope-name">All changes</span>
              <span className="git-scope-count">{plural(changes.files.length, "file")}</span>
            </button>
          </div>
        )}
        {files.length > 0 && (
          <>
            <button type="button" className="git-files-toggle" aria-expanded={showFiles} onClick={() => setShowFiles((s) => !s)}>
              <ChevronDown size={12} className={cx("git-files-chevron", showFiles && "git-files-chevron-open")} />
              {plural(files.length, "file")} to commit
            </button>
            {showFiles && (
              <ul className="git-files">
                {files.map((f) => (
                  <li key={f.path} title={f.from ? `${f.from} → ${f.path}` : f.path}>
                    <span className={cx("git-status", `git-status-${f.status === "?" ? "new" : f.status}`)} data-tooltip={STATUS_LABEL[f.status]} data-tooltip-side="left">
                      {STATUS[f.status]}
                    </span>
                    <span className="git-file">{f.path}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {mine && scope.shared.length > 0 && (
          <p className="git-note">
            {scope.shared.length === 1 ? (
              <>
                <code>{scope.shared[0]!.path}</code> was also edited in “{scope.shared[0]!.threads[0]}”, so its edits from there go in too.
              </>
            ) : (
              <>{plural(scope.shared.length, "file")} here were also edited in other threads, so their edits from there go in too.</>
            )}
          </p>
        )}
        {!scope.mine.length && changes.files.length > 0 && !ws.worktree && <p className="git-note">None of these changes came from this thread's edits.</p>}
        {conflicted && <p className="git-note git-note-bad">Resolve the conflicted files before committing.</p>}
        <div className="menu-sep" />
        <button type="button" className="menu-item" disabled={!canCommit || !!busy} onClick={() => void run("commit")}>
          <GitCommitHorizontal size={15} />
          <span className="menu-item-label">Commit</span>
          {busy?.action === "commit" && <Spinner size={12} />}
        </button>
        <button type="button" className="menu-item" disabled={!canCommit || !branch || (!changes.upstream && !changes.remote) || !!busy} onClick={() => void run("commit-push")}>
          <CloudUpload size={15} />
          <span className="menu-item-label">Commit and push</span>
          {busy?.action === "commit-push" && <Spinner size={12} />}
        </button>
        <button type="button" className="menu-item" disabled={!canPush || !!busy} onClick={() => void run("push")}>
          <ArrowUp size={15} />
          <span className="menu-item-label">Push</span>
          {busy?.action === "push" && <Spinner size={12} />}
        </button>
        <button type="button" className="menu-item" disabled={!!prBlocked || !!busy} data-tooltip={prBlocked} data-tooltip-side="left" onClick={() => void run("pr")}>
          <GitPullRequest size={15} />
          <span className="menu-item-label">Create PR</span>
          {busy?.action === "pr" && <Spinner size={12} />}
        </button>
        {busy && <p className="git-note">{busy.step}</p>}
        {error && <p className="git-note git-note-bad" role="alert">{error}</p>}
        {done && (
          <p className="git-note git-note-ok" role="status">
            {done.text}
            {done.url && (
              <>
                {" · "}
                <a href={done.url} target="_blank" rel="noreferrer">
                  View <ExternalLink size={11} />
                </a>
              </>
            )}
          </p>
        )}
      </Popover>
    </>
  );
}
