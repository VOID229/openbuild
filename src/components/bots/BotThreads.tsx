// Settings → Bots: what a bot may do in OpenBuild (server/bots/threads.ts), and how bots use each
// harness there. Off until the user says otherwise.
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { PERMISSION_HARNESSES, type BotProjectScope, type BotThreadAccess, type PermissionHarness } from "../../../shared/bots";
import type { PermissionMode, ThreadRuntime } from "../../../shared/types";
import { useBots } from "../../lib/bots/store";
import type { Bot } from "../../lib/bots/types";
import { permissionModes } from "../../lib/pi";
import { cachedRuntimeStatuses, loadRuntimeStatuses, subscribeRuntimeStatuses } from "../../lib/runtimeStatus";
import { runtimeName, RUNTIMES } from "../../lib/runtimes";
import { useStore } from "../../lib/store";
import { arrowNav, cx } from "../../lib/ui";
import { OptionSelect, useSelectKeys } from "../ModelSelect";
import { Popover, Toggle } from "../primitives";

/** What turning access on starts from. A grant the bot already has keeps what's saved in it. */
const NO_ACCESS: BotThreadAccess = { enabled: false, scope: "all", projects: [], choosePermission: true, approve: true };
const SCOPES: { value: BotProjectScope; label: string }[] = [
  { value: "all", label: "All projects" },
  { value: "choose", label: "Choose projects" },
  { value: "exclude", label: "Exclude projects" },
];
/** Bots can't use Durable threads yet. */
const HARNESSES = RUNTIMES.map((r) => r.runtime).filter((r) => r !== "durable");
const hasModes = (runtime: ThreadRuntime): runtime is PermissionHarness => PERMISSION_HARNESSES.includes(runtime as PermissionHarness);

/** Compact, the description moves into a tooltip on the label so the row stays one line (the details panel's Advanced tab). */
function Row({ label, desc, compact, disabled, children }: { label: string; desc: string; compact?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className={cx("setting-row", disabled && "setting-row-disabled")}>
      <div className="setting-text">
        <div className="setting-label" data-tooltip={compact ? desc : undefined} data-tooltip-side={compact ? "left" : undefined}>
          {label}
        </div>
        {!compact && <p className="setting-desc">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function names(list: string[]) {
  return list.length > 3 ? `${list.slice(0, 3).join(", ")} and ${list.length - 3} more` : list.join(", ");
}

/** A dropdown of the user's projects that stays open while they tick several. */
function ProjectPicker({ label, picked, onChange, disabled, className }: { label: string; picked: string[]; onChange: (ids: string[]) => void; disabled?: boolean; className?: string }) {
  const projects = useStore((s) => s.projects).filter((p) => !p.deviceId);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const keys = useSelectKeys(open, setOpen, anchor);
  const pickedNames = projects.filter((p) => picked.includes(p.id)).map((p) => p.name);
  return (
    <span className={cx("select-wrap", className)}>
      <button ref={anchor} type="button" className={cx("select-trigger", "select-trigger-md", open && "select-trigger-open")} aria-haspopup="listbox" aria-expanded={open} aria-label={label} disabled={disabled} {...keys.trigger}>
        <span className="select-value">{pickedNames.length ? names(pickedNames) : "None yet"}</span>
        <ChevronDown size={14} className="select-chevron" />
      </button>
      <Popover open={open && !disabled} onClose={keys.close} anchor={anchor} className="menu select-menu" role="listbox" label={label} fixed="auto">
        <div ref={keys.list} onKeyDown={(e) => arrowNav(e)}>
          {projects.map((project) => {
            const on = picked.includes(project.id);
            return (
              // Ids of projects since removed stay in the list: they're the user's, not this picker's.
              <button key={project.id} type="button" role="option" aria-selected={on} className="menu-item" onClick={() => onChange(on ? picked.filter((id) => id !== project.id) : [...picked, project.id])}>
                <span className="menu-item-label">{project.name}</span>
                {on && <Check size={15} className="menu-check" />}
              </button>
            );
          })}
          {!projects.length && <p className="menu-empty">Add a project to OpenBuild first.</p>}
        </div>
      </Popover>
    </span>
  );
}

/** Which projects the bot can work in. Shown with access off too, greyed out, so what's saved there is still visible. */
function BotProjects({ access, save, compact }: { access: BotThreadAccess; save: (patch: Partial<BotThreadAccess>) => void; compact?: boolean }) {
  // Grants from before scopes existed have none, and mean "choose": never show them as broader.
  const scope = access.scope ?? "choose";
  const key = scope === "exclude" ? "excluded" : "projects";
  const disabled = !access.enabled;
  const grow = compact ? "select-grow" : undefined;
  return (
    <>
      <Row compact={compact} disabled={disabled} label="Projects" desc={disabled ? "Turn on Use OpenBuild to change which projects it can work in." : "Which projects it can start threads in and follow."}>
        <OptionSelect label="Projects this bot can work in" value={scope} options={SCOPES} onChange={(next) => save({ scope: next })} disabled={disabled} className={grow} />
      </Row>
      {scope !== "all" && (
        <Row compact={compact} disabled={disabled} label={scope === "exclude" ? "Excluded" : "Chosen"} desc={scope === "exclude" ? "Projects it can't work in. It can work in every other one." : "The projects it can work in."}>
          <ProjectPicker label={scope === "exclude" ? "Projects to exclude" : "Projects to choose"} picked={access[key] ?? []} onChange={(ids) => save({ [key]: ids })} disabled={disabled} className={grow} />
        </Row>
      )}
    </>
  );
}

export function BotThreads({ bot, compact }: { bot: Bot; compact?: boolean }) {
  const access = bot.threads ?? NO_ACCESS;
  const save = (patch: Partial<BotThreadAccess>) => useBots.getState().updateBot(bot.id, { threads: { ...access, ...patch } });
  return (
    <>
      <BotProjects access={access} save={save} compact={compact} />
      <Row compact={compact} label="Use OpenBuild" desc="Start and follow threads, send them messages, and answer the questions they ask. Threads run on this server as you, with your subscriptions and keys.">
        <Toggle checked={access.enabled} onChange={(enabled) => save({ enabled })} label="Use OpenBuild" />
      </Row>
      {access.enabled && (
        <>
          <Row compact={compact} label="Control others' threads" desc="Write to, answer, stop, close and merge threads it didn't start: yours and other bots'. Off, it can still see them but only controls its own.">
            <Toggle checked={!!access.others} onChange={(others) => save({ others })} label="Control others' threads" />
          </Row>
          <Row compact={compact} label="Choose permissions" desc="Pick each thread's permission mode itself, including the unrestricted ones. Off, its threads use the defaults under Harnesses in OpenBuild.">
            <Toggle checked={!!access.choosePermission} onChange={(choosePermission) => save({ choosePermission })} label="Choose permissions" />
          </Row>
          <Row compact={compact} label="Answer permission prompts" desc="Allow or deny what a thread's agent asks to do. Off, those prompts wait for you, and the bot tells you about them.">
            <Toggle checked={!!access.approve} onChange={(approve) => save({ approve })} label="Answer permission prompts" />
          </Row>
          <Row compact={compact} label="Merge pull requests" desc="Merge once every check passes.">
            <Toggle checked={!!access.merge} onChange={(merge) => save({ merge })} label="Merge pull requests" />
          </Row>
        </>
      )}
    </>
  );
}

/** One harness: whether bots may use it, and for those with modes, what their threads get by default. */
function HarnessRow({ runtime, missing }: { runtime: ThreadRuntime; missing: boolean }) {
  const harnesses = useBots((s) => s.harnesses);
  const [modes, setModes] = useState<PermissionMode[]>([]);
  useEffect(() => {
    if (!hasModes(runtime) || missing) return;
    let live = true;
    void permissionModes(runtime)
      .then((r) => live && setModes(r.modes))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [runtime, missing]);
  // A harness this server doesn't have is off and can't be turned on (server/bots/threads.ts refuses it too).
  const blocked = missing || (harnesses.blocked?.includes(runtime) ?? false);
  const mode = hasModes(runtime) ? harnesses.permissions?.[runtime] : undefined;
  const setMode = (value: string) => {
    if (!hasModes(runtime)) return;
    const { [runtime]: _, ...rest } = harnesses.permissions ?? {};
    useBots.getState().setHarnesses({ ...harnesses, permissions: value ? { ...rest, [runtime]: value } : rest });
  };
  const options = [
    { value: "", label: "Its own default" },
    ...modes.filter((m) => m.allowed !== false).map((m) => ({ value: m.id, label: m.name })),
    // A saved mode the harness has stopped offering, so the list doesn't pretend it's something else.
    ...(mode && !modes.some((m) => m.id === mode) ? [{ value: mode, label: `${mode} (not listed)` }] : []),
  ];
  return (
    <Row label={runtimeName(runtime)} desc={missing ? "Not installed here. Set it up in Settings → Runtimes." : hasModes(runtime) ? "The permission mode for threads whose bot can't choose." : "OpenBuild can't set permissions here: it follows this harness's own configuration, so a bot using it gets whatever that allows."}>
      {hasModes(runtime) && !missing && <OptionSelect label={`${runtimeName(runtime)} permission`} value={mode ?? ""} options={options} onChange={setMode} />}
      <Toggle checked={!blocked} disabled={missing} onChange={(on) => useBots.getState().setHarnesses({ ...harnesses, blocked: on ? harnesses.blocked?.filter((r) => r !== runtime) : [...(harnesses.blocked ?? []), runtime] })} label={`Let bots use ${runtimeName(runtime)}`} />
    </Row>
  );
}

export function BotHarnesses() {
  const blocked = useBots((s) => s.harnesses.blocked);
  // Collapsed by default, like web search: the header already says which harnesses bots can use.
  const [open, setOpen] = useState(false);
  // Bots run on this server, so what counts is what its detection found.
  const [statuses, setStatuses] = useState(() => cachedRuntimeStatuses());
  useEffect(() => {
    void loadRuntimeStatuses().then(setStatuses, () => {});
    return subscribeRuntimeStatuses((next, device) => { if (!device) setStatuses(next); });
  }, []);
  const missing = (r: ThreadRuntime) => !!statuses && !statuses[r]?.installed;
  const allowed = HARNESSES.filter((r) => !missing(r) && !blocked?.includes(r)).map(runtimeName);
  return (
    <>
      <div className="pi-subhead">
        <button type="button" className="pi-subhead-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="pi-subhead-title">Harnesses in OpenBuild</span>
          <span className="pi-subhead-note">{allowed.length ? allowed.join(", ") : "None allowed"}</span>
          <ChevronDown size={15} className="pi-subhead-chevron" />
        </button>
      </div>
      <div className={cx("collapse", open && "collapse-open")} inert={!open}>
        <div className="collapse-inner">
          {HARNESSES.map((runtime) => (
            <HarnessRow key={runtime} runtime={runtime} missing={missing(runtime)} />
          ))}
        </div>
      </div>
    </>
  );
}
