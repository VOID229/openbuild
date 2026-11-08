// Settings → Runtimes: every thread runtime on a device (installed, version, updates, sign-in,
// errors), and a switch that hides a runtime from the new-thread picker on that device.
import { CircleAlert, Plus, RefreshCw, RotateCw } from "lucide-react";
import { AddRuntime } from "./AddRuntime";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeStatus, ThreadRuntime } from "../../shared/types";
import { deviceName, findDevice } from "../lib/devices";
import { updateRuntime } from "../lib/pi";
import { cachedRuntimeStatuses, loadRuntimeStatuses, subscribeRuntimeStatuses } from "../lib/runtimeStatus";
import { RUNTIMES, runtimeEnabled, setRuntimeEnabled } from "../lib/runtimes";
import { useStore } from "../lib/store";
import { cx } from "../lib/ui";
import { DeviceRow, deviceRefusal, useJob, usePiDevice } from "./PiSettings";
import { SettingsHeading as Heading, Spinner, Toggle } from "./primitives";
import { RuntimeIcon } from "./Workspace";

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");

/** Why a runtime's last update failed: the job's output, or the refusal that kept it from starting. */
export interface UpdateFailure {
  message: string;
  lines: string[];
}

export function StatusBadges({ status, name, updating, failure, failureShown, updateDisabled, quiet, onUpdate, onToggleFailure }: {
  status?: RuntimeStatus;
  name: string;
  updating: boolean;
  failure?: UpdateFailure;
  failureShown?: boolean;
  updateDisabled: boolean;
  /** An external device: updating stays possible, but nothing asks for it. */
  quiet?: boolean;
  onUpdate: () => void;
  onToggleFailure?: () => void;
}) {
  if (!status) return null;
  if (!status.installed) return <span className="badge">not installed</span>;
  return (
    <>
      {status.version && <span className="badge">v{status.version}</span>}
      {failure && !updating ? (
        <button
          type="button"
          className="badge badge-bad rt-update-failed"
          aria-expanded={!!failureShown}
          aria-label={`${name} update failed: ${failureShown ? "hide" : "show"} the error`}
          onClick={onToggleFailure}
        >
          <CircleAlert size={10} aria-hidden="true" /> update failed
        </button>
      ) : status.updateAvailable || updating ? (
        <button
          type="button"
          className={quiet ? "badge rt-update" : "badge badge-accent rt-update"}
          disabled={updateDisabled}
          data-updating={updating || undefined}
          aria-label={updating ? `Updating ${name}` : `Update ${name}`}
          aria-description={`${status.latest} available`}
          aria-busy={updating}
          onClick={onUpdate}
        >
          <span className="rt-update-version" aria-hidden="true">{status.latest} available</span>
          <span className="rt-update-action" aria-hidden="true">
            {updating && <Spinner size={10} />}
            {updating ? "Updating…" : "Update"}
          </span>
        </button>
      ) : status.checkError ? (
        <span className="badge" title={status.checkError}>couldn't check for updates</span>
      ) : (
        status.latest && <span className="badge">up to date</span>
      )}
      {status.signedIn === false && <span className="badge badge-bad">not signed in</span>}
      {status.error && <span className="badge badge-bad">error</span>}
    </>
  );
}

function RuntimeRow({ runtime, label, desc, status, enabled, lastOn, onToggle, updating, failure, updateDisabled, quiet, onUpdate }: {
  runtime: ThreadRuntime;
  label: string;
  desc: string;
  status?: RuntimeStatus;
  enabled: boolean;
  lastOn: boolean;
  onToggle: (on: boolean) => void;
  updating: boolean;
  failure?: UpdateFailure;
  updateDisabled: boolean;
  quiet?: boolean;
  onUpdate: () => void;
}) {
  const name = runtime === "pi" ? "Pi" : label;
  const [failureShown, setFailureShown] = useState(false);
  const log = useRef<HTMLPreElement>(null);
  useEffect(() => { if (!failure) setFailureShown(false); }, [failure]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [failureShown]);
  return (
    <li className={cx("rt-row", !enabled && "pi-row-off")}>
      <div className="pi-row">
        <span className="rt-icon" aria-hidden>
          <RuntimeIcon runtime={runtime} size={16} />
        </span>
        <span className="pi-row-text">
          <span className="pi-row-name">
            {name}
            <span className="rt-badges">
              <StatusBadges
                status={status}
                name={name}
                updating={updating}
                failure={failure}
                failureShown={failureShown}
                updateDisabled={updateDisabled}
                quiet={quiet}
                onUpdate={onUpdate}
                onToggleFailure={() => setFailureShown((v) => !v)}
              />
            </span>
          </span>
          <span className="pi-row-desc">{status?.bin ? `${desc} · ${tilde(status.bin)}` : desc}</span>
        </span>
        <Toggle
          checked={enabled}
          disabled={enabled && lastOn}
          label={`${enabled ? "Hide" : "Show"} ${name} in the runtime picker`}
          onChange={onToggle}
        />
      </div>
      {status?.error && (
        <p className="pi-error rt-detail" role="alert">
          <CircleAlert size={14} /> <span className="rt-error">{status.error}</span>
        </p>
      )}
      {failure && failureShown && !updating && (
        <div className="rt-detail rt-failure">
          <div className="rt-failure-head">
            <span className="rt-error">{failure.message}</span>
            <button type="button" className="btn btn-sm" disabled={updateDisabled} onClick={onUpdate}>
              <RotateCw size={12} /> Retry
            </button>
          </div>
          {failure.lines.length > 0 && <pre ref={log} className="pi-job-log">{failure.lines.join("\n")}</pre>}
        </div>
      )}
    </li>
  );
}

export function RuntimesSection() {
  const [deviceId, setDeviceId] = usePiDevice();
  return (
    <>
      <Heading>Runtimes</Heading>
      <DeviceRow deviceId={deviceId} onChange={setDeviceId} title="Runtimes on" label="Device whose runtimes to manage" />
      <RuntimeList key={deviceId ?? ""} deviceId={deviceId} />
    </>
  );
}

function RuntimeList({ deviceId }: { deviceId?: string }) {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const key = deviceId ?? "";
  const [statuses, setStatuses] = useState(() => cachedRuntimeStatuses(deviceId));
  const [updating, setUpdating] = useState<ThreadRuntime>();
  const [failures, setFailures] = useState<Partial<Record<ThreadRuntime, UpdateFailure>>>({});
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [adding, setAdding] = useState(false);
  const closeAdding = useCallback(() => setAdding(false), []);
  const where = deviceName(deviceId);

  const load = useCallback(
    async (fresh = false) => {
      if (fresh) setChecking(true);
      try {
        const r = await loadRuntimeStatuses(fresh, deviceId);
        setStatuses(r);
        setError(undefined);
      } catch (err) {
        setError(deviceRefusal(err as Error, where));
      } finally {
        setChecking(false);
      }
    },
    [deviceId, key, where],
  );

  useEffect(() => {
    setStatuses(cachedRuntimeStatuses(deviceId));
    setError(undefined);
    void load();
  }, [key, load]);

  useEffect(() => subscribeRuntimeStatuses((next, device) => { if (device === deviceId) setStatuses(next); }), [deviceId]);

  // The update shows only on its runtime's pill: spinning while it runs, then the refreshed
  // status ("up to date"), or "update failed" with the job's output behind it.
  const job = useJob(() => {}, deviceId);
  const fail = (runtime: ThreadRuntime, failure?: UpdateFailure) =>
    setFailures(({ [runtime]: _, ...rest }) => (failure ? { ...rest, [runtime]: failure } : rest));
  const startUpdate = async (runtime: ThreadRuntime) => {
    setUpdating(runtime);
    fail(runtime);
    try {
      const { job: id } = await updateRuntime(runtime, deviceId);
      const r = await job.follow(id);
      if (r?.code !== 0) {
        fail(runtime, {
          message: r ? `The update exited with code ${r.code ?? "?"}.` : "Lost track of the update before it finished.",
          lines: r?.lines ?? [],
        });
      }
      // Keep the pill spinning until the fresh status replaces it, so it never flashes back to "available".
      await loadRuntimeStatuses(true, deviceId).then(setStatuses, (err: Error) => setError(deviceRefusal(err, where)));
    } catch (err) {
      fail(runtime, { message: deviceRefusal(err as Error, where), lines: [] });
    } finally {
      setUpdating(undefined);
    }
  };

  const enabledCount = RUNTIMES.filter((r) => runtimeEnabled(settings, r.runtime, deviceId, statuses)).length;
  const toggle = (runtime: ThreadRuntime, on: boolean) => {
    const patch = setRuntimeEnabled(settings, runtime, on, deviceId, statuses);
    // Turning off the runtime new threads use on this device moves them to the first one left on.
    const current = settings.threadRuntime ?? "pi";
    const device = useStore.getState().settings.workspace;
    const sameDevice = (device.projectId ? useStore.getState().projects.find((p) => p.id === device.projectId)?.deviceId : device.deviceId) === deviceId;
    const fallback = RUNTIMES.find((r) => !patch.disabledRuntimes?.[key]?.includes(r.runtime))?.runtime;
    updateSettings(!on && sameDevice && current === runtime && fallback ? { ...patch, threadRuntime: fallback } : patch);
  };

  return (
    <>
      <div className="pi-subhead">
        <p className="setting-desc">Turned-off runtimes are hidden from the runtime picker for new threads on {where ?? "this device"}. Existing threads keep their runtime.</p>
        <div className="row-actions">
          <button type="button" className="btn btn-sm" disabled={checking || !!updating || job.running} onClick={() => void load(true)}>
            {checking ? <Spinner size={12} /> : <RefreshCw size={14} />} Check for updates
          </button>
        </div>
      </div>
      <AddRuntime open={adding} deviceId={deviceId} where={where ?? "this device"} onClose={closeAdding} />
      {error && (
        <p className="pi-error" role="alert">
          <CircleAlert size={14} /> {error}
        </p>
      )}
      <ul className="pi-list">
        {RUNTIMES.map((r) => {
          const enabled = runtimeEnabled(settings, r.runtime, deviceId, statuses);
          return (
            <RuntimeRow
              key={r.runtime}
              {...r}
              status={statuses?.[r.runtime]}
              enabled={enabled}
              lastOn={enabledCount <= 1}
              onToggle={(on) => toggle(r.runtime, on)}
              updating={updating === r.runtime}
              failure={failures[r.runtime]}
              updateDisabled={checking || !!updating || job.running}
              quiet={findDevice(deviceId)?.external}
              onUpdate={() => void startUpdate(r.runtime)}
            />
          );
        })}
      </ul>
      <div className="rt-add">
        <button type="button" className="btn btn-sm" onClick={() => setAdding(true)}><Plus size={14} /> Add runtime</button>
      </div>
    </>
  );
}
