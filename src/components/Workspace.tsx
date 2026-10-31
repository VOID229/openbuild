import { ThreadAccountSelect } from "./RuntimeAccounts";
// Where a thread works. On the new-thread screen the heading picks the project ("What should we
// build in <project>?"), and above the composer you choose the project's checkout or a new
// worktree, and the branch. In a thread, under the composer: where it works, how full its context
// is, and what it has cost.
import { Check, ChevronDown, FolderGit2, FolderMinus, GitBranch, GitFork, Laptop, Plus, Search, SquareTerminal, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GitInfo, ThreadRuntime, Workspace } from "../../shared/types";
import { projectGit, removeProject, workspaceGit } from "../lib/pi";
import { machineName } from "../lib/runtime";
import { chooseDevice, chooseProject, deviceName, splitProjectId, workspaceDevice } from "../lib/devices";
import { threadDevice, useStore } from "../lib/store";
import { RUNTIMES, runtimeName } from "../lib/runtimes";
import { cachedRuntimeStatuses, loadRuntimeStatuses, subscribeRuntimeStatuses } from "../lib/runtimeStatus";
import { contextFill, formatTokens, formatUsd, shortTokens, spendKind, threadSpend, useThreadModels } from "../lib/usage";
import { toggleTerminal } from "../lib/terminal";
import { arrowNav, cx, useFocusOnShow } from "../lib/ui";
import { OpencodeMark, ClaudeMark, CodexMark, DurableMark, FxMark, IconButton, PiMark, Popover, CursorMark, Spinner } from "./primitives";
import { NewProjectDialog, NewProjectSource, type NewProjectStart } from "./NewProject";

/** Git state of a project (refetched when it changes or `refresh` ticks). */
function useProjectGit(projectId: string | undefined, refresh: number) {
  const [info, setInfo] = useState<GitInfo>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setInfo(undefined);
    if (!projectId) return;
    let live = true;
    setLoading(true);
    const ref = splitProjectId(projectId);
    projectGit(ref.id, ref.deviceId)
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

function ProjectList({ onDone, onNew }: { onDone: () => void; onNew: () => void }) {
  const projects = useStore((s) => s.projects);
  const pref = useStore((s) => s.settings.workspace);
  const updateSettings = useStore((s) => s.updateSettings);
  const loadProjects = useStore((s) => s.loadProjects);
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  useFocusOnShow(search);
  const machine = machineName();
  const q = query.trim().toLowerCase();
  const shown = useMemo(() => projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)), [projects, q]);
  const pick = (projectId?: string) => {
    updateSettings({ workspace: chooseProject(pref, projectId) });
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
              <span className="pp-sub">{p.missing ? "missing from disk" : `@ ${p.deviceName ?? machine ?? p.path.replace(/^\/Users\/[^/]+/, "~")}`}</span>
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
                const ref = splitProjectId(p.id);
                void removeProject(ref.id, ref.deviceId).then(() => {
                  if (pref.projectId === p.id) updateSettings({ workspace: chooseProject(pref) });
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
            onNew();
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

/** The device line under the heading picks where new threads run, moving to what was last used there. */
function DeviceMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const devices = useStore((s) => s.devices);
  const devicesLoaded = useStore((s) => s.devicesLoaded);
  const pref = useStore((s) => s.settings.workspace);
  const updateSettings = useStore((s) => s.updateSettings);
  // A device unpaired since it was picked: back to this one.
  useEffect(() => {
    if (pref.deviceId && devicesLoaded && !devices.some((d) => d.id === pref.deviceId && !d.local)) updateSettings({ workspace: { ...pref, deviceId: undefined } });
  }, [pref, devices, devicesLoaded, updateSettings]);
  const deviceId = workspaceDevice(pref);
  const current = devices.find((d) => (deviceId ? d.id === deviceId : d.local));
  const name = current?.name ?? machineName();
  if (!devices.some((d) => !d.local)) return name ? <p className="home-machine"><Laptop size={13} /> {name}</p> : null;
  return (
    <>
      <button ref={anchor} type="button" className={cx("home-machine home-machine-pick", open && "home-machine-open")} aria-haspopup="listbox" aria-expanded={open} data-tooltip="Device new threads run on" onClick={() => setOpen((o) => !o)}>
        <Laptop size={13} /> {name ?? "This device"}
        <ChevronDown size={12} className="pill-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu ws-menu" role="listbox" label="Device" fixed="auto">
        <div onKeyDown={(e) => arrowNav(e)}>
          {devices.map((d) => {
            const selected = d === current;
            return (
              <button
                key={d.id}
                type="button"
                role="option"
                aria-selected={selected}
                className="menu-item ws-option"
                disabled={d.online === false}
                onClick={() => {
                  const { projects, chats } = useStore.getState();
                  if (!selected) updateSettings({ workspace: chooseDevice(pref, d.local ? undefined : d.id, projects, chats) });
                  setOpen(false);
                }}
              >
                <Laptop size={15} />
                <span className="ws-option-text">
                  <span className="menu-item-label">{d.name}</span>
                  <span className="ws-option-path">{d.local ? "This device" : d.online === false ? "Offline" : (d.machine ?? "Paired device")}</span>
                </span>
                {selected && <Check size={15} className="menu-check" />}
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

/** The home heading; the underlined part opens the project picker. */
export function ProjectHeading() {
  const [open, setOpen] = useState(false);
  // The picker's step: its projects, or where a new project comes from.
  const [step, setStep] = useState<"projects" | "new">("projects");
  const [adding, setAdding] = useState<NewProjectStart>();
  useEffect(() => {
    if (open) setStep("projects");
  }, [open]);
  const anchor = useRef<HTMLButtonElement>(null);
  const project = useStore((s) => s.projects.find((p) => p.id === s.settings.workspace.projectId));
  const trigger = (label: string) => (
    <button ref={anchor} type="button" className={cx("home-pick", open && "home-pick-open")} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
      {label}
    </button>
  );
  return (
    <div className="home-head">
      <h1 className="home-title">{project ? <>What should we build in {trigger(project.name)}?</> : <>What should we {trigger("work on")}?</>}</h1>
      <DeviceMenu />
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="pp" label="Choose a project" fixed="auto">
        {step === "projects" ? (
          <ProjectList onDone={() => setOpen(false)} onNew={() => setStep("new")} />
        ) : (
          <NewProjectSource
            onBack={() => setStep("projects")}
            onPick={(start) => {
              setOpen(false);
              setAdding(start);
            }}
          />
        )}
      </Popover>
      <NewProjectDialog start={adding} onClose={() => setAdding(undefined)} />
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

const DURABLE_LIMITATIONS = "Durable does not support Pi slash commands or extensions. Runtime is fixed once a thread starts.";
const FX_LIMITATIONS = "fx (Vercel's coding agent, installed on this device) with its own models, sign-in, skills and MCP servers. No Pi extensions or slash commands. Steering accepts text only. Runtime is fixed once a thread starts.";
const CODEX_LIMITATIONS = "Native Codex with its own models, sign-in, skills and MCP servers, separate from Pi's OpenAI Codex provider. No Pi extensions, slash commands, compaction or shell commands. Runtime is fixed once a thread starts.";
const CURSOR_LIMITATIONS = "Native Cursor with its own models, sign-in, rules and MCP servers. No Pi extensions, slash commands, compaction or shell commands. Steering uses tool hooks (or a follow-up at completion). Runtime is fixed once a thread starts.";
const CLAUDE_LIMITATIONS = "Native Claude Code (the CLI installed on this device, through Anthropic's Agent SDK) with its own models, sign-in, CLAUDE.md, skills, hooks and MCP servers. No Pi extensions, slash commands, compaction or shell commands. Runtime is fixed once a thread starts.";
const OPENCODE_LIMITATIONS = "Native OpenCode with its own providers, models, configuration, permissions and MCP servers. No Pi extensions, slash commands, compaction or shell commands. Runtime is fixed once a thread starts.";
export const RUNTIME_LABEL: Record<ThreadRuntime, string> = { pi: "Default", durable: "Durable", fx: "fx", codex: "Codex", cursor: "Cursor", claude: "Claude Code", opencode: "OpenCode" };
export function RuntimeIcon({ runtime, size }: { runtime: ThreadRuntime; size: number }) {
  return runtime === "opencode" ? <OpencodeMark size={size} /> : runtime === "claude" ? <ClaudeMark size={size} /> : runtime === "durable" ? <DurableMark size={size} /> : runtime === "fx" ? <FxMark size={size} /> : runtime === "cursor" ? <CursorMark size={size} /> : runtime === "codex" ? <CodexMark size={size} /> : <PiMark size={size} />;
}

/**
 * The runtimes a new thread can pick on the device it will run on, and the one picked (falling back
 * to the first usable one when the saved pick is turned off or not installed there).
 */
export function useRuntimeOptions() {
  const selected = useStore((s) => s.settings.threadRuntime ?? "pi");
  // Runtimes turned off in Settings → Runtimes for the device new threads run on aren't offered.
  const device = useStore((s) => threadDevice(s));
  const disabled = useStore((s) => s.settings.disabledRuntimes?.[device ?? ""]);
  const options = useMemo(() => RUNTIMES.filter((o) => !disabled?.includes(o.runtime)), [disabled]);
  // Runtimes not installed on that device are shown grayed out and lead to Settings → Runtimes instead.
  const [statuses, setStatuses] = useState(() => cachedRuntimeStatuses(device));
  useEffect(() => {
    setStatuses(cachedRuntimeStatuses(device));
    void loadRuntimeStatuses(false, device).then(setStatuses, () => {});
    return subscribeRuntimeStatuses((next, id) => { if ((id ?? "") === (device ?? "")) setStatuses(next); });
  }, [device]);
  const missing = (r: ThreadRuntime) => statuses?.[r]?.installed === false;
  const usable = options.filter((o) => !missing(o.runtime));
  const runtime = usable.some((o) => o.runtime === selected) ? selected : (usable[0]?.runtime ?? options[0]?.runtime ?? selected);
  return { options, missing, runtime, selected };
}

/** Runtime is chosen before the first send, independently of the project's checkout. */
function RuntimeMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const updateSettings = useStore((s) => s.updateSettings);
  const openSettings = useStore((s) => s.openSettings);
  const { options, missing, runtime, selected } = useRuntimeOptions();
  useEffect(() => {
    if (runtime !== selected) updateSettings({ threadRuntime: runtime });
  }, [runtime, selected, updateSettings]);
  const tip = runtime === "opencode" ? OPENCODE_LIMITATIONS : runtime === "claude" ? CLAUDE_LIMITATIONS : runtime === "cursor" ? CURSOR_LIMITATIONS : runtime === "durable" ? DURABLE_LIMITATIONS : runtime === "fx" ? FX_LIMITATIONS : runtime === "codex" ? CODEX_LIMITATIONS : "Runtime for this new thread; fixed after the first send";
  return (
    <>
      <button ref={anchor} type="button" className={cx("ws-pill", open && "ws-pill-open")} aria-label={`Thread runtime: ${RUNTIME_LABEL[runtime]}`} aria-haspopup="listbox" aria-expanded={open} data-tooltip={tip} data-tooltip-side="top" onClick={() => setOpen((o) => !o)}>
        <RuntimeIcon runtime={runtime} size={13} />
        {/* The fx mark is its name; the word beside it just repeats the logo. */}
        {runtime !== "fx" && <span className="ws-pill-text">{RUNTIME_LABEL[runtime]}</span>}
        <ChevronDown size={13} className="pill-chevron" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu ws-menu" role="listbox" label="Thread runtime" fixed="auto">
        <div onKeyDown={(e) => arrowNav(e)}>
          {options.map((o) => {
            const absent = missing(o.runtime);
            return (
              <button
                key={o.runtime}
                type="button"
                role="option"
                aria-selected={o.runtime === runtime}
                aria-disabled={absent || undefined}
                className={cx("menu-item ws-option", absent && "ws-option-missing")}
                onClick={() => { if (absent) openSettings("runtimes"); else updateSettings({ threadRuntime: o.runtime }); setOpen(false); }}
              >
                <span className="ws-option-icon" aria-hidden>
                  <RuntimeIcon runtime={o.runtime} size={15} />
                </span>
                <span className="ws-option-text">
                  <span className="menu-item-label">{o.label}</span>
                  <span className="ws-option-path">{absent ? `Not installed · Set up ${runtimeName(o.runtime)}…` : o.desc}</span>
                </span>
                {o.runtime === runtime && <Check size={15} className="menu-check" />}
              </button>
            );
          })}
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
      <ThreadAccountSelect />
    </div>
  );
}

// ------------------------------------------------------------------ thread (below the composer)

const CONTEXT_ROWS = [
  ["system", "System & tools", "The system prompt, skills and tool definitions (estimated from the thread's first request)."],
  ["cacheRead", "Cached", "Read from the provider's prompt cache: billed at a fraction of the input price."],
  ["cacheWrite", "Cache write", "New input written to the prompt cache."],
  ["input", "Input", "New, uncached input: your messages and tool results."],
  ["output", "Output", "The model's last answer, thinking and tool calls."],
] as const;

/** Under the composer, on the right: how full the context is (a ring and a percentage) and what the thread has cost. Click for the breakdown. */
function UsageMeter({ chatId, runtime }: { chatId: string; runtime: ThreadRuntime }) {
  const messages = useStore((s) => s.chats.find((c) => c.id === chatId)?.messages);
  const models = useThreadModels(messages, useStore((s) => s.detection.pi?.models));
  const fill = useMemo(() => messages && contextFill(messages, models), [messages, models]);
  const spend = useMemo(() => messages && threadSpend(messages, models), [messages, models]);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!fill && !spend) return null;
  const pct = fill?.used !== undefined && fill.window ? Math.min(100, Math.round((fill.used / fill.window) * 100)) : undefined;
  const r = 7;
  const c = 2 * Math.PI * r;
  const kind = spend && spendKind(spend);
  const rows = fill?.rows;
  const rowTotal = rows ? CONTEXT_ROWS.reduce((n, [k]) => n + (rows[k] ?? 0), 0) : 0;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="usage"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${pct !== undefined ? `Context ${pct}% full` : "Context"}${spend ? `, ${formatUsd(spend.total)} spent` : ""}. Show details`}
        onClick={() => setOpen((o) => !o)}
      >
        {fill && (
          <span className={cx("ctx", pct !== undefined && pct >= 80 && "ctx-high")}>
            <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
              <circle cx="9" cy="9" r={r} className="ctx-track" />
              <circle cx="9" cy="9" r={r} className="ctx-fill" strokeDasharray={`${((pct ?? 0) / 100) * c} ${c}`} transform="rotate(-90 9 9)" />
            </svg>
            {pct !== undefined ? `${pct}%` : fill.used !== undefined ? shortTokens(fill.used) : "–"}
          </span>
        )}
        {spend && (
          <span className="usage-cost">
            {kind && <span className="usage-kind">({kind})</span>}
            {/* Nothing priced at all: don't claim $0. */}
            {spend.total || !spend.unpriced ? formatUsd(spend.total) : null}
          </span>
        )}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="usage-pop" label="Context and spend" fixed="up" align="end">
        {fill && (
          <section>
            <div className="usage-head">
              <span>Context</span>
              {pct !== undefined && <span>{pct}%</span>}
            </div>
            {rows && rowTotal > 0 && (
              <div className="usage-bar" aria-hidden>
                {CONTEXT_ROWS.map(([k]) => (rows[k] ? <span key={k} className={`usage-seg-${k}`} style={{ width: `${(rows[k]! / (fill.window || rowTotal)) * 100}%` }} /> : null))}
              </div>
            )}
            {rows ? (
              <dl className="usage-rows">
                {CONTEXT_ROWS.map(([k, label, hint]) =>
                  rows[k] || (k !== "system" && k !== "cacheWrite") ? (
                    <div key={k} data-tooltip={hint} data-tooltip-side="left">
                      <dt><i className={`usage-dot usage-seg-${k}`} />{label}</dt>
                      <dd>{k === "system" ? "~" : ""}{formatTokens(rows[k] ?? 0)}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
            ) : (
              <p className="usage-note">{fill.used === undefined ? "Just compacted. The next reply measures the context again." : "No breakdown for this reply."}</p>
            )}
            {fill.used !== undefined && (
              <div className="usage-total">
                <span>Used</span>
                <span>{formatTokens(fill.used)}{fill.window ? <span className="usage-of"> of {formatTokens(fill.window)}</span> : null}</span>
              </div>
            )}
            {runtime === "pi" && <p className="usage-note">Pi compacts the context when it's nearly full (or type /compact).</p>}
          </section>
        )}
        {spend && (
          <section>
            <div className="usage-head">
              <span>Spend in this thread</span>
              <span>{spend.total || !spend.unpriced ? formatUsd(spend.total) : "Unknown"}</span>
            </div>
            <dl className="usage-rows">
              {spend.billed > 0 && (
                <div data-tooltip="Charged per token by the provider." data-tooltip-side="left"><dt>Billed</dt><dd>{formatUsd(spend.billed)}</dd></div>
              )}
              {spend.plan > 0 && (
                <div data-tooltip="Covered by your subscription, so not charged. Shown at API prices." data-tooltip-side="left"><dt>Plan (API value)</dt><dd>{formatUsd(spend.plan)}</dd></div>
              )}
              {(spend.free > 0 || (kind === "free" && !spend.unpriced)) && (
                <div data-tooltip="Local models and free tiers cost nothing per token. Shown at what the same model costs from a provider." data-tooltip-side="left"><dt>Free (estimated)</dt><dd>{formatUsd(spend.free)}</dd></div>
              )}
            </dl>
            <dl className="usage-rows usage-tokens">
              <div><dt>Input</dt><dd>{formatTokens(spend.tokens.input + spend.tokens.cacheWrite)}</dd></div>
              <div><dt>Cached</dt><dd>{formatTokens(spend.tokens.cacheRead)}</dd></div>
              <div><dt>Output</dt><dd>{formatTokens(spend.tokens.output)}</dd></div>
            </dl>
            {spend.estimatedFrom.length > 0 && (
              <p className="usage-note">Estimated at {spend.estimatedFrom.length === 1 ? <code>{spend.estimatedFrom[0]}</code> : `${spend.estimatedFrom.length} other listings'`} prices.</p>
            )}
            {spend.unpriced > 0 && <p className="usage-note">{spend.unpriced === 1 ? "One reply has" : `${spend.unpriced} replies have`} no known price and count as $0.</p>}
          </section>
        )}
      </Popover>
    </>
  );
}

function ThreadWorkspace({ chatId, workspace, streaming }: { chatId: string; workspace?: Workspace; streaming: boolean }) {
  const [info, setInfo] = useState<GitInfo>();
  const runtime = useStore((s) => s.chats.find((c) => c.id === chatId)?.runtime ?? "pi");
  // Refresh after each reply (Pi may have committed or switched branches) and on coming back.
  useEffect(() => {
    if (streaming || !workspace?.branch) return;
    let live = true;
    const load = () => workspaceGit(workspace.cwd, workspace.deviceId).then((g) => live && setInfo(g), () => {});
    void load();
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [workspace?.cwd, workspace?.deviceId, workspace?.branch, streaming]);
  const branch = info?.branch ?? workspace?.branch;
  return (
    <div className="ws-bottom">
      {workspace && (
        <span className="ws-where" title={workspace.cwd}>
          <span className="ws-chip" data-tooltip={workspace.deviceId ? `Runs on ${deviceName(workspace.deviceId) ?? "a paired device"}` : undefined} data-tooltip-side="top">
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
      <UsageMeter chatId={chatId} runtime={runtime} />
      <IconButton label="Open a terminal here" tooltip="Terminal (⌘J)" tooltipSide="top" className="ws-terminal" onClick={toggleTerminal}>
        <SquareTerminal size={14} />
      </IconButton>
    </div>
  );
}

export function WorkspaceBelow({ chatId, streaming }: { chatId: string; streaming: boolean }) {
  const workspace = useStore((s) => s.chats.find((c) => c.id === chatId)?.workspace);
  return <ThreadWorkspace chatId={chatId} workspace={workspace} streaming={streaming} />;
}
