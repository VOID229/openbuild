// What a bot may do on its own: spawn minions, and merge pull requests. Two switches, in its details
// under Advanced and in Settings → Bots, in place of the access to the user's threads bots used to be
// given here: Build is the user's own now, and a bot hands its work to minions.
//
// Spawn minions is on for every bot until the user turns it off (shared/bots.ts mayCreateMinions).
// Merge PRs is off until they turn it on (mayMergePrs), as merging always was: it's kept where that
// grant always was, on the bot's thread access, so a bot that could merge before still can.
//
// Also Settings → Bots → Harnesses: which harnesses the bots' `openbuild` tool offers, and each one's
// default permission mode.
import { useEffect, useState } from "react";
import { DEFAULT_THREAD_ACCESS, mayMergePrs, PERMISSION_HARNESSES, type BotThreadAccess, type PermissionHarness } from "../../../shared/bots";
import type { PermissionMode, ThreadRuntime } from "../../../shared/types";
import { useBots } from "../../lib/bots/store";
import type { Bot } from "../../lib/bots/types";
import { permissionModes } from "../../lib/pi";
import { cachedRuntimeStatuses, loadRuntimeStatuses, subscribeRuntimeStatuses } from "../../lib/runtimeStatus";
import { runtimeName, RUNTIMES } from "../../lib/runtimes";
import { cx } from "../../lib/ui";
import { OptionSelect } from "../ModelSelect";
import { Toggle } from "../primitives";

/** Bots can't use Durable threads yet. */
const HARNESSES = RUNTIMES.map((r) => r.runtime).filter((r) => r !== "durable");
const hasModes = (runtime: ThreadRuntime): runtime is PermissionHarness => PERMISSION_HARNESSES.includes(runtime as PermissionHarness);

/** A bot without a grant has no access to the user's threads (the server fails closed too): turning Merge PRs on doesn't give it any. */
const NO_ACCESS: BotThreadAccess = { ...DEFAULT_THREAD_ACCESS, enabled: false };

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

export const SPAWN_MINIONS_DESC = "Hand a task to a minion: a temporary worker bot of its own that does the one task on its computers and reports back. You can read each minion's chat.";
export const MERGE_PRS_DESC = "Merge pull requests, its own and its minions', with gh pr merge. Off, it opens them and you merge.";

/** Spawn minions and Merge PRs. A retired bot's stay as they were, to see, until it's rehired. */
export function BotSwitches({ bot, compact }: { bot: Bot; compact?: boolean }) {
  const st = useBots.getState();
  const access = bot.threads ?? NO_ACCESS;
  return (
    <>
      <Row compact={compact} label="Spawn minions" desc={SPAWN_MINIONS_DESC}>
        <Toggle checked={bot.spawnMinions !== false} disabled={!!bot.retiredAt} onChange={(spawnMinions) => st.updateBot(bot.id, { spawnMinions })} label="Spawn minions" />
      </Row>
      <Row compact={compact} label="Merge PRs" desc={MERGE_PRS_DESC}>
        <Toggle checked={mayMergePrs(bot)} disabled={!!bot.retiredAt} onChange={(merge) => st.updateBot(bot.id, { threads: { ...access, merge } })} label="Merge PRs" />
      </Row>
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
    <Row label={runtimeName(runtime)} desc={missing ? "Not installed here. Set it up in Settings → Harnesses." : hasModes(runtime) ? "The permission mode for a bot's thread when the bot doesn't choose one." : "OpenBuild can't set permissions here: it follows this harness's own configuration, so a bot using it gets whatever that allows."}>
      {hasModes(runtime) && !missing && <OptionSelect label={`${runtimeName(runtime)} permission`} value={mode ?? ""} options={options} onChange={setMode} />}
      <Toggle checked={!blocked} disabled={missing} onChange={(on) => useBots.getState().setHarnesses({ ...harnesses, blocked: on ? harnesses.blocked?.filter((r) => r !== runtime) : [...(harnesses.blocked ?? []), runtime] })} label={`Let bots use ${runtimeName(runtime)}`} />
    </Row>
  );
}

/** Which harnesses this server has installed: bots run here, so what counts is what its detection found. */
function useHarnessStatuses() {
  const [statuses, setStatuses] = useState(() => cachedRuntimeStatuses());
  useEffect(() => {
    void loadRuntimeStatuses().then(setStatuses, () => {});
    return subscribeRuntimeStatuses((next, device) => { if (!device) setStatuses(next); });
  }, []);
  return (r: ThreadRuntime) => !!statuses && !statuses[r]?.installed;
}

/** The harnesses bots may start OpenBuild threads on, by name: what Settings → Bots says Harnesses is set to. */
export function useAllowedHarnesses() {
  const blocked = useBots((s) => s.harnesses.blocked);
  const missing = useHarnessStatuses();
  return HARNESSES.filter((r) => !missing(r) && !blocked?.includes(r)).map(runtimeName);
}

/** Settings → Bots → Harnesses: which harnesses bots may start OpenBuild threads on. */
export function BotHarnesses() {
  const missing = useHarnessStatuses();
  return (
    <>
      {HARNESSES.map((runtime) => (
        <HarnessRow key={runtime} runtime={runtime} missing={missing(runtime)} />
      ))}
    </>
  );
}
