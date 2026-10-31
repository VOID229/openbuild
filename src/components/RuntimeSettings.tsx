// Settings → Runtimes: every thread runtime on a device (installed, version, updates, sign-in,
// errors), and a switch that hides a runtime from the new-thread picker on that device.
import { CircleAlert, Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RuntimeStatus, ThreadRuntime } from "../../shared/types";
import { deviceName } from "../lib/devices";
import { updateRuntime } from "../lib/pi";
import { cachedRuntimeStatuses, loadRuntimeStatuses, subscribeRuntimeStatuses } from "../lib/runtimeStatus";
import { RUNTIMES, runtimeEnabled, setRuntimeEnabled } from "../lib/runtimes";
import { useStore } from "../lib/store";
import { cx } from "../lib/ui";
import { DeviceRow, deviceRefusal, JobLog, useJob, usePiDevice } from "./PiSettings";
import { IconButton, SettingsHeading as Heading, Spinner, Toggle } from "./primitives";
import { RuntimeIcon } from "./Workspace";

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");

function StatusBadges({ status, name, updating, updateDisabled, onUpdate }: {
  status?: RuntimeStatus;
  name: string;
  updating: boolean;
  updateDisabled: boolean;
  onUpdate: () => void;
}) {
  if (!status) return null;
  if (!status.installed) return <span className="badge">not installed</span>;
  return (
    <>
      {status.version && <span className="badge">v{status.version}</span>}
      {status.installed ? (
        <button
          type="button"
          className={status.updateAvailable ? "badge badge-accent rt-update" : "badge rt-update"}
          disabled={updateDisabled}
          data-updating={updating || undefined}
          aria-label={updating ? `Updating ${name}` : `Update ${name}`}
          aria-description={status.updateAvailable ? `${status.latest} available` : "Run the native updater"}
          aria-busy={updating}
          onClick={onUpdate}
        >
          <span className="rt-update-version" aria-hidden="true">{status.updateAvailable ? `${status.latest} available` : status.latest ? "up to date" : "Check for update"}</span>
          <span className="rt-update-action" aria-hidden="true">
            {updating && <Spinner size={10} />}
            {updating ? "Updating…" : "Update"}
          </span>
        </button>
      ) : (
        status.latest && <span className="badge">up to date</span>
      )}
      {status.signedIn === false && <span className="badge badge-bad">not signed in</span>}
      {status.error && <span className="badge badge-bad">error</span>}
    </>
  );
}

function RuntimeRow({ runtime, label, desc, status, enabled, lastOn, onToggle, where, updating, updateDisabled, onUpdate }: {
  runtime: ThreadRuntime;
  label: string;
  desc: string;
  status?: RuntimeStatus;
  enabled: boolean;
  lastOn: boolean;
  onToggle: (on: boolean) => void;
  where?: string;
  updating: boolean;
  updateDisabled: boolean;
  onUpdate: () => void;
}) {
  const name = runtime === "pi" ? "Pi" : label;
  const missing = status && !status.installed;
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
              <StatusBadges status={status} name={name} updating={updating} updateDisabled={updateDisabled} onUpdate={onUpdate} />
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
      {missing && (
        <div className="rt-detail">
          <span className="pi-meta">Install it in a terminal on {where ?? "this computer"}:</span>
          <code className="rt-cmd">{status.install}</code>
          <IconButton label="Copy install command" tooltipSide="left" className="key-icon-btn" onClick={() => void navigator.clipboard?.writeText(status.install)}>
            <Copy size={13} />
          </IconButton>
        </div>
      )}
      {status?.error && (
        <p className="pi-error rt-detail" role="alert">
          <CircleAlert size={14} /> <span className="rt-error">{status.error}</span>
        </p>
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
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
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

  const job = useJob(() => { void load(true); }, deviceId);
  const startUpdate = async (runtime: ThreadRuntime) => {
    setUpdating(runtime);
    setError(undefined);
    try {
      const { job: id } = await updateRuntime(runtime, deviceId);
      await job.follow(id);
    } catch (err) {
      setError(deviceRefusal(err as Error, where));
    } finally {
      setUpdating(undefined);
    }
  };

  const enabledCount = RUNTIMES.filter((r) => runtimeEnabled(settings, r.runtime, deviceId)).length;
  const toggle = (runtime: ThreadRuntime, on: boolean) => {
    const patch = setRuntimeEnabled(settings, runtime, on, deviceId);
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
        <button type="button" className="btn btn-sm" disabled={checking || !!updating || job.running} onClick={() => void load(true)}>
          {checking ? <Spinner size={12} /> : <RefreshCw size={14} />} Check for updates
        </button>
      </div>
      {error && (
        <p className="pi-error" role="alert">
          <CircleAlert size={14} /> {error}
        </p>
      )}
      <ul className="pi-list">
        {RUNTIMES.map((r) => {
          const enabled = runtimeEnabled(settings, r.runtime, deviceId);
          return (
            <RuntimeRow
              key={r.runtime}
              {...r}
              status={statuses?.[r.runtime]}
              enabled={enabled}
              lastOn={enabledCount <= 1}
              onToggle={(on) => toggle(r.runtime, on)}
              where={where}
              updating={updating === r.runtime}
              updateDisabled={checking || !!updating || job.running}
              onUpdate={() => void startUpdate(r.runtime)}
            />
          );
        })}
      </ul>
      <JobLog job={job} />
    </>
  );
}
