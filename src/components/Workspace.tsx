// Where a thread works. On the new-thread screen the heading picks the project ("What should we
// build in <project>?"), and above the composer you choose the project's checkout or a new
// worktree, and the branch. In a thread, under the composer: where it works, and how full its
// context is.
import { Check, ChevronDown, FolderGit2, FolderMinus, GitBranch, GitFork, Laptop, LockKeyhole, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GitInfo, ThreadRuntime, Workspace } from "../../shared/types";
import { projectGit, removeProject, workspaceGit } from "../lib/pi";
import { machineName } from "../lib/runtime";
import { useStore } from "../lib/store";
import { arrowNav, cx, useFocusOnShow } from "../lib/ui";
import { Popover, Spinner } from "./primitives";

/** Git state of a project (refetched when it changes or `refresh` ticks). */
function useProjectGit(projectId: string | undefined, refresh: number) {
  const [info, setInfo] = useState<GitInfo>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setInfo(undefined);
    if (!projectId) return;
    let live = true;
    setLoading(true);
    projectGit(projectId)
      .then((g) => live && setInfo(g))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [projectId, refresh]);
  return { info, loading };
}

/** The project chosen for new threads, with its git state (re-read when the page comes back). */
function useNewWorkspace() {
  const projects = useStore((s) => s.projects);
  const pref = useStore((s) => s.settings.workspace);
  const project = projects.find((p) => p.id === pref.projectId);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && setTick((t) => t + 1);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  const git = useProjectGit(project?.git ? project.id : undefined, tick);
  return { project, pref, ...git };
}

// ------------------------------------------------------------------ project picker (in the heading)

function ProjectList({ onDone }: { onDone: () => void }) {
  const projects = useStore((s) => s.projects);
  const pref = useStore((s) => s.settings.workspace);
  const updateSettings = useStore((s) => s.updateSettings);
  const openSettings = useStore((s) => s.openSettings);
  const loadProjects = useStore((s) => s.loadProjects);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  useFocusOnShow(search);
  const machine = machineName();
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)), [projects, q]);
  const pick = (projectId?: string) => {
    updateSettings({ workspace: { ...pref, projectId, branch: undefined } });
    onDone();
  };
  return (
    <>
      <label className="pp-search">
        <Search size={15} />
        <input
          ref={search}
          value={query}
          placeholder="Search projects…"
          aria-label="Search projects"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && shown[0]) pick(shown[0].id);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              (e.currentTarget.closest(".pp")?.querySelector(".pp-pick") as HTMLElement | null)?.focus();
            }
          }}
        />
      </label>
      <div className="pp-list" onKeyDown={(e) => arrowNav(e)}>
        {shown.map((p) => (
          <div key={p.id} className="pp-row" aria-selected={p.id === pref.projectId}>
            <button type="button" className="pp-pick" disabled={p.missing} onClick={() => pick(p.id)}>
              <span className="pp-name">{p.name}</span>
              <span className="pp-sub">{p.missing ? "missing from disk" : `@ ${machine ?? p.path.replace(/^\/Users\/[^/]+/, "~")}`}</span>
            </button>
            {p.id === pref.projectId && <Check size={15} className="pp-check" />}
            <button
              type="button"
              className="pp-remove"
              aria-label={`Remove ${p.name}`}
              data-tooltip="Remove from OpenBuild"
              data-tooltip-side="left"
              onClick={() => {
                if (!confirm(`Remove ${p.name} from OpenBuild? The folder and its threads stay as they are.`)) return;
                void removeProject(p.id).then(() => {
                  if (pref.projectId === p.id) updateSettings({ workspace: { ...pref, projectId: undefined, branch: undefined } });
                  return loadProjects();
                });
              }}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {!shown.length && <p className="pp-empty">{q ? `No project matches “${query.trim()}”.` : "No projects yet."}</p>}
      </div>
      <div className="pp-foot">
        <button
          type="button"
          className="pp-action"
          onClick={() => {
            onDone();
            openSettings("projects");
          }}
        >
          <Plus size={15} /> New project…
        </button>
        <button type="button" className={cx("pp-action", !pref.projectId && "pp-action-current")} onClick={() => pick(undefined)}>
          <FolderMinus size={15} /> Don't work in a project
        </button>
      </div>
    </>
  );
}

/** The home heading; the underlined part opens the project picker. */
export function ProjectHeading() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const project = useStore((s) => s.projects.find((p) => p.id === s.settings.workspace.projectId));
  const machine = machineName();
  const trigger = (label: string) => (
    <button ref={anchor} type="button" className={cx("home-pick", open && "home-pick-open")} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
      {label}
    </button>
  );
  return (
    <div className="home-head">
      <h1 className="home-title">{project ? <>What should we build in {trigger(project.name)}?</> : <>What should we {trigger("work on")}?</>}</h1>
      {machine && (
        <p className="home-machine">
          <Laptop size={13} /> {machine}
        </p>
      )}
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="pp" label="Choose a project" fixed="auto">
        <ProjectList onDone={() => setOpen(false)} />
      </Popover>
    </div>
  );
}

// ------------------------------------------------------------------ checkout and branch (above the composer)

function ModeMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const pref = useStore((s) => s.settings.workspace);
  const updateSettings = useStore((s) => s.updateSettings);
  const options = [
    { mode: "local" as const, label: "Local checkout", desc: "Work in the project's own folder", icon: FolderGit2 },
    { mode: "worktree" as const, label: "New worktree", desc: "A separate copy on its own branch", icon: GitFork },
  ];
  const current = options.find((o) => o.mode === pref.mode) ?? options[0]!;
  return (
    <>
      <button ref={anchor} type="button" className={cx("ws-pill", open && "ws-pill-open")} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <current.icon size={14} />
        <span className="ws-pill-text">{current.label}</span>
        <ChevronDown size={13} className="pill-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu ws-menu" role="listbox" label="Where to work" fixed="auto">
        <div onKeyDown={(e) => arrowNav(e)}>
          {options.map((o) => (
            <button
              key={o.mode}
              type="button"
              role="option"
              aria-selected={o.mode === pref.mode}
              className="menu-item ws-option"
              onClick={() => {
                updateSettings({ workspace: { ...pref, mode: o.mode, branch: undefined } });
                setOpen(false);
              }}
            >
              <o.icon size={15} />
              <span className="ws-option-text">
                <span className="menu-item-label">{o.label}</span>
                <span className="ws-option-path">{o.desc}</span>
              </span>
              {o.mode === pref.mode && <Check size={15} className="menu-check" />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function BranchMenu({ info, loading }: { info?: GitInfo; loading: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const pref = useStore((s) => s.settings.workspace);
  const updateSettings = useStore((s) => s.updateSettings);
  const shown = pref.branch && info?.branches.includes(pref.branch) ? pref.branch : info?.branch;
  // Switching the checkout's branch would carry uncommitted changes along (or fail).
  const locked = pref.mode === "local" && !!info?.dirty;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cx("ws-pill", open && "ws-pill-open")}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tooltip={pref.mode === "worktree" ? "Branch the worktree starts from" : "Branch to work on"}
        data-tooltip-side="top"
        onClick={() => setOpen((o) => !o)}
      >
        <GitBranch size={14} />
        <span className="ws-pill-text">{pref.mode === "worktree" ? `from ${shown ?? "…"}` : (shown ?? "…")}</span>
        {loading ? <Spinner size={11} /> : <ChevronDown size={13} className="pill-chevron" />}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu ws-menu" role="listbox" label="Branch" fixed="auto">
        <div className="menu-label menu-label-top">{pref.mode === "worktree" ? "Start the worktree from" : "Work on branch"}</div>
        {locked && <p className="ws-note">{info!.dirty} uncommitted change{info!.dirty === 1 ? "" : "s"} in the checkout, so it stays on {info!.branch}. Use a new worktree to work on another branch.</p>}
        <div className="select-list ws-branches" onKeyDown={(e) => arrowNav(e)}>
          {(info?.branches ?? []).map((b) => (
            <button
              key={b}
              type="button"
              role="option"
              aria-selected={b === shown}
              className="menu-item"
              disabled={locked && b !== info?.branch}
              onClick={() => {
                updateSettings({ workspace: { ...pref, branch: b === info?.branch ? undefined : b } });
                setOpen(false);
              }}
            >
              <GitBranch size={14} />
              <span className="menu-item-label">{b}</span>
              {b === info?.branch && <span className="badge">current</span>}
              {b === shown && <Check size={15} className="menu-check" />}
            </button>
          ))}
          {!loading && !info?.branches.length && <p className="menu-empty">No branches yet.</p>}
        </div>
      </Popover>
    </>
  );
}

const DURABLE_LIMITATIONS = "Durable does not support Pi slash commands, extensions, or steering. Runtime is fixed once a thread starts.";

/** Runtime is chosen before the first send, independently of the project's checkout. */
function RuntimeMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const runtime = useStore((s) => s.settings.threadRuntime ?? "pi");
  const updateSettings = useStore((s) => s.updateSettings);
  const options: { runtime: ThreadRuntime; label: string; desc: string }[] = [
    { runtime: "pi", label: "Pi", desc: "Pi tools, extensions and slash commands" },
    { runtime: "durable", label: "Durable", desc: "Durable execution; no Pi extensions or slash commands" },
  ];
  return (
    <>
      <button ref={anchor} type="button" className={cx("ws-pill", open && "ws-pill-open")} aria-label={`Thread runtime: ${runtime === "durable" ? "Durable" : "Pi"}`} aria-haspopup="listbox" aria-expanded={open} data-tooltip={runtime === "durable" ? DURABLE_LIMITATIONS : "Runtime for this new thread; fixed after the first send"} data-tooltip-side="top" onClick={() => setOpen((o) => !o)}>
        <span className="ws-pill-text">{runtime === "durable" ? "Durable" : "Pi"}</span>
        <ChevronDown size={13} className="pill-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu ws-menu" role="listbox" label="Thread runtime" fixed="auto">
        <div onKeyDown={(e) => arrowNav(e)}>
          {options.map((o) => (
            <button key={o.runtime} type="button" role="option" aria-selected={o.runtime === runtime} className="menu-item ws-option" onClick={() => { updateSettings({ threadRuntime: o.runtime }); setOpen(false); }}>
              <span className="ws-option-text">
                <span className="menu-item-label">{o.label}</span>
                <span className="ws-option-path">{o.desc}</span>
              </span>
              {o.runtime === runtime && <Check size={15} className="menu-check" />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

/** New thread: runtime, checkout or worktree, and branch, right above the composer. */
export function WorkspaceTop() {
  const { project, pref, info, loading } = useNewWorkspace();
  return (
    <div className="ws-top">
      {project?.git && <>
        {pref.mode === "local" && !!info?.dirty && <span className="ws-dirty">{info.dirty} changed</span>}
        <BranchMenu info={info} loading={loading} />
        <ModeMenu />
      </>}
      <RuntimeMenu />
    </div>
  );
}

// ------------------------------------------------------------------ thread (below the composer)

/** How full the context is: a small ring and a percentage. */
function ContextRing({ tokens, window, runtime }: { tokens: number; window: number; runtime: ThreadRuntime }) {
  const pct = Math.min(100, Math.round((tokens / window) * 100));
  const r = 7;
  const c = 2 * Math.PI * r;
  const k = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return (
    <span className={cx("ctx", pct >= 80 && "ctx-high")} data-tooltip={`${k(tokens)} of ${k(window)} tokens in context.${runtime === "pi" ? " Pi compacts it when it's nearly full (or type /compact)." : ""}`} data-tooltip-side="top">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
        <circle cx="9" cy="9" r={r} className="ctx-track" />
        <circle cx="9" cy="9" r={r} className="ctx-fill" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 9 9)" />
      </svg>
      {pct}%
    </span>
  );
}

function ThreadWorkspace({ chatId, workspace, streaming }: { chatId: string; workspace?: Workspace; streaming: boolean }) {
  const [info, setInfo] = useState<GitInfo>();
  const runtime = useStore((s) => s.chats.find((c) => c.id === chatId)?.runtime ?? "pi");
  const usage = useStore((s) => s.chats.find((c) => c.id === chatId)?.messages.findLast((m) => m.role === "assistant" && m.usage?.contextWindow)?.usage);
  // Refresh after each reply (Pi may have committed or switched branches) and on coming back.
  useEffect(() => {
    if (streaming || !workspace?.branch) return;
    let live = true;
    const load = () => workspaceGit(workspace.cwd).then((g) => live && setInfo(g), () => {});
    void load();
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [workspace?.cwd, workspace?.branch, streaming]);
  const branch = info?.branch ?? workspace?.branch;
  return (
    <div className="ws-bottom">
      <span className="ws-chip" data-tooltip={runtime === "durable" ? DURABLE_LIMITATIONS : "This thread uses Pi. Runtime cannot be changed after the first send."} data-tooltip-side="top">
        <LockKeyhole size={13} /> {runtime === "durable" ? "Durable" : "Pi"}
      </span>
      {workspace && (
        <span className="ws-where" title={workspace.cwd}>
          <span className="ws-chip">
            {workspace.worktree ? <GitFork size={13} /> : <FolderGit2 size={13} />}
            <span className="ws-pill-text">{workspace.projectName ? `${workspace.projectName} · ${workspace.worktree ? "worktree" : "local checkout"}` : "Scratch folder"}</span>
          </span>
          {branch && (
            <span className="ws-chip">
              <GitBranch size={13} />
              <span className="ws-pill-text">{branch}</span>
            </span>
          )}
          {!!info?.dirty && <span className="ws-dirty">{info.dirty} changed</span>}
          {!!info?.ahead && <span className="ws-dirty">↑{info.ahead}</span>}
        </span>
      )}
      {usage?.contextTokens && usage.contextWindow ? <ContextRing tokens={usage.contextTokens} window={usage.contextWindow} runtime={runtime} /> : null}
    </div>
  );
}

export function WorkspaceBelow({ chatId, streaming }: { chatId: string; streaming: boolean }) {
  const workspace = useStore((s) => s.chats.find((c) => c.id === chatId)?.workspace);
  return <ThreadWorkspace chatId={chatId} workspace={workspace} streaming={streaming} />;
}
