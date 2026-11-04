// Settings → Bots: what a bot may do in OpenBuild (server/bots/threads.ts), and how bots use each
// harness there. All off until the user says otherwise.
import { useEffect, useState } from "react";
import { PERMISSION_HARNESSES, type BotThreadAccess, type PermissionHarness } from "../../../shared/bots";
import type { PermissionMode, ThreadRuntime } from "../../../shared/types";
import { useBots } from "../../lib/bots/store";
import type { Bot } from "../../lib/bots/types";
import { permissionModes } from "../../lib/pi";
import { runtimeName, RUNTIMES } from "../../lib/runtimes";
import { useStore } from "../../lib/store";
import { OptionSelect } from "../ModelSelect";
import { Toggle } from "../primitives";

const NO_ACCESS: BotThreadAccess = { enabled: false, projects: [] };
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

export function BotThreads({ bot }: { bot: Bot }) {
  const projects = useStore((s) => s.projects).filter((p) => !p.deviceId);
  const access = bot.threads ?? NO_ACCESS;
  const save = (patch: Partial<BotThreadAccess>) => useBots.getState().updateBot(bot.id, { threads: { ...access, ...patch } });
  return (
    <>
      <Row label="Use OpenBuild" desc="Start and follow threads, send them messages, and answer the questions they ask. Threads run on this server as you, with your subscriptions and keys.">
        <Toggle checked={access.enabled} onChange={(enabled) => save({ enabled })} label="Use OpenBuild" />
      </Row>
      {access.enabled && (
        <>
          {projects.map((project) => (
            <Row key={project.id} label={project.name} desc="Can work in this project.">
              <Toggle checked={access.projects.includes(project.id)} onChange={(on) => save({ projects: on ? [...access.projects, project.id] : access.projects.filter((id) => id !== project.id) })} label={`Work in ${project.name}`} />
            </Row>
          ))}
          {!projects.length && <p className="setting-desc">Add a project to OpenBuild first. Bots only work in projects you pick here.</p>}
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
  return (
    <>
      {HARNESSES.map((runtime) => (
        <HarnessRow key={runtime} runtime={runtime} />
      ))}
    </>
  );
}
