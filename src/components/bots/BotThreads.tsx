// Settings → Bots: what a bot may do in OpenBuild (server/bots/threads.ts), and how bots use each
// harness there. Off until the user says otherwise.
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { PERMISSION_HARNESSES, type BotProjectScope, type BotThreadAccess, type PermissionHarness } from "../../../shared/bots";
import type { PermissionMode, ThreadRuntime } from "../../../shared/types";
import { useBots } from "../../lib/bots/store";
import type { Bot } from "../../lib/bots/types";
import { permissionModes } from "../../lib/pi";
import { runtimeName, RUNTIMES } from "../../lib/runtimes";
import { useStore } from "../../lib/store";
import { cx } from "../../lib/ui";
import { OptionSelect } from "../ModelSelect";
import { Toggle } from "../primitives";

/** What turning access on starts from. A grant the bot already has keeps what's saved in it. */
const NO_ACCESS: BotThreadAccess = { enabled: false, scope: "all", projects: [], choosePermission: true, approve: true };
const SCOPES: { scope: BotProjectScope; label: string }[] = [
  { scope: "all", label: "All projects" },
  { scope: "choose", label: "Choose projects" },
  { scope: "exclude", label: "Exclude projects" },
];
/** Bots can't use Durable threads yet. */
const HARNESSES = RUNTIMES.map((r) => r.runtime).filter((r) => r !== "durable");
const hasModes = (runtime: ThreadRuntime): runtime is PermissionHarness => PERMISSION_HARNESSES.includes(runtime as PermissionHarness);

function Row({ label, desc, children }: { label: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        <p className="setting-desc">{desc}</p>
      </div>
      {children}
    </div>
  );
}

function names(list: string[]) {
  return list.length > 3 ? `${list.slice(0, 3).join(", ")} and ${list.length - 3} more` : list.join(", ");
}

function BotProjects({ access, save }: { access: BotThreadAccess; save: (patch: Partial<BotThreadAccess>) => void }) {
  const projects = useStore((s) => s.projects).filter((p) => !p.deviceId);
  // Collapsed by default: the row already says which projects the bot has.
  const [open, setOpen] = useState(false);
  const scope = access.scope ?? "choose";
  const key = scope === "exclude" ? "excluded" : "projects";
  const picked = access[key] ?? [];
  const pickedNames = projects.filter((p) => picked.includes(p.id)).map((p) => p.name);
  const summary = scope === "all" || (scope === "exclude" && !pickedNames.length) ? "All projects" : scope === "exclude" ? `All except ${names(pickedNames)}` : pickedNames.length ? names(pickedNames) : "No projects yet";
  return (
    <div className="setting-group bot-projects">
      <button type="button" className="bot-projects-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="setting-text">
          <span className="setting-label">Projects</span>
          <span className="setting-desc">{summary}</span>
        </span>
        <ChevronDown size={15} className="bot-projects-chevron" />
      </button>
      <div className={cx("collapse", open && "collapse-open")} inert={!open}>
        <div className="collapse-inner">
          <div className="bot-projects-body">
            <div className="segmented" role="radiogroup" aria-label="Projects this bot can work in">
              {SCOPES.map((s) => (
                <button key={s.scope} type="button" role="radio" aria-checked={scope === s.scope} className="segment" onClick={() => save({ scope: s.scope })}>
                  {s.label}
                </button>
              ))}
            </div>
            {scope !== "all" && (
              <div className="segmented" role="group" aria-label={scope === "exclude" ? "Projects to exclude" : "Projects to choose"}>
                {projects.map((project) => {
                  const on = picked.includes(project.id);
                  return (
                    <button key={project.id} type="button" role="checkbox" aria-checked={on} className="segment" onClick={() => save({ [key]: on ? picked.filter((id) => id !== project.id) : [...picked, project.id] })}>
                      {project.name}
                    </button>
                  );
                })}
              </div>
            )}
            {!projects.length && <p className="setting-desc">Add a project to OpenBuild first.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

export function BotThreads({ bot }: { bot: Bot }) {
  const access = bot.threads ?? NO_ACCESS;
  const save = (patch: Partial<BotThreadAccess>) => useBots.getState().updateBot(bot.id, { threads: { ...access, ...patch } });
  return (
    <>
      <Row label="Use OpenBuild" desc="Start and follow threads, send them messages, and answer the questions they ask. Threads run on this server as you, with your subscriptions and keys.">
        <Toggle checked={access.enabled} onChange={(enabled) => save({ enabled })} label="Use OpenBuild" />
      </Row>
      {access.enabled && (
        <>
          <BotProjects access={access} save={save} />
          <Row label="Control others' threads" desc="Write to, answer, stop, close and merge threads it didn't start: yours and other bots'. Off, it can still see them but only controls its own.">
            <Toggle checked={!!access.others} onChange={(others) => save({ others })} label="Control others' threads" />
          </Row>
          <Row label="Choose permissions" desc="Pick each thread's permission mode itself, including the unrestricted ones. Off, its threads use the defaults under Harnesses in OpenBuild.">
            <Toggle checked={!!access.choosePermission} onChange={(choosePermission) => save({ choosePermission })} label="Choose permissions" />
          </Row>
          <Row label="Answer permission prompts" desc="Allow or deny what a thread's agent asks to do. Off, those prompts wait for you, and the bot tells you about them.">
            <Toggle checked={!!access.approve} onChange={(approve) => save({ approve })} label="Answer permission prompts" />
          </Row>
          <Row label="Merge pull requests" desc="Merge once every check passes.">
            <Toggle checked={!!access.merge} onChange={(merge) => save({ merge })} label="Merge pull requests" />
          </Row>
        </>
      )}
    </>
  );
}

/** One harness: whether bots may use it, and for those with modes, what their threads get by default. */
function HarnessRow({ runtime }: { runtime: ThreadRuntime }) {
  const harnesses = useBots((s) => s.harnesses);
  const [modes, setModes] = useState<PermissionMode[]>([]);
  useEffect(() => {
    if (!hasModes(runtime)) return;
    let live = true;
    void permissionModes(runtime)
      .then((r) => live && setModes(r.modes))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [runtime]);
  const blocked = harnesses.blocked?.includes(runtime) ?? false;
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
    <Row label={runtimeName(runtime)} desc={hasModes(runtime) ? "The permission mode for threads whose bot can't choose." : "OpenBuild can't set permissions here: it follows this harness's own configuration, so a bot using it gets whatever that allows."}>
      {hasModes(runtime) && <OptionSelect label={`${runtimeName(runtime)} permission`} value={mode ?? ""} options={options} onChange={setMode} />}
      <Toggle checked={!blocked} onChange={(on) => useBots.getState().setHarnesses({ ...harnesses, blocked: on ? harnesses.blocked?.filter((r) => r !== runtime) : [...(harnesses.blocked ?? []), runtime] })} label={`Let bots use ${runtimeName(runtime)}`} />
    </Row>
  );
}

export function BotHarnesses() {
  const blocked = useBots((s) => s.harnesses.blocked);
  // Collapsed by default, like web search: the header already says which harnesses bots can use.
  const [open, setOpen] = useState(false);
  const allowed = HARNESSES.filter((r) => !blocked?.includes(r)).map(runtimeName);
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
            <HarnessRow key={runtime} runtime={runtime} />
          ))}
        </div>
      </div>
    </>
  );
}
