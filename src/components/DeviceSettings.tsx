// Settings → Devices: the devices this OpenBuild is paired with, where their servers stand, and
// unpairing or restarting them. Also the devices that use this one, so their access can be revoked.
import { Check, CircleAlert, Play, RefreshCw, RotateCw, Unlink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Device, PairedClient } from "../../shared/types";
import { listPairedClients, removeDevice, restartDevice, revokePairedClient } from "../lib/pi";
import { useStore } from "../lib/store";
import { ago, cx } from "../lib/ui";
import { IconButton, SettingsHeading, Spinner } from "./primitives";

const STATUS: Record<NonNullable<Device["status"]>, { label: string; dot?: string }> = {
  online: { label: "Online" },
  stopped: { label: "Server stopped", dot: "pi-status-dot-warn" },
  offline: { label: "Unreachable", dot: "pi-status-dot-off" },
  revoked: { label: "Pairing revoked", dot: "pi-status-dot-bad" },
};

const host = (url: string | undefined) => (url ? url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "no address");

function PairedDeviceRow({ device, onChanged }: { device: Device; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<"restart" | "unpair">();
  const [error, setError] = useState<string>();
  const status = device.status ?? (device.online === false ? "offline" : "online");
  const { label, dot } = STATUS[status];
  const reachable = status === "online" || status === "stopped";
  const seen = !reachable && ago(device.lastSeenAt);
  const starting = status === "stopped";

  const restart = async () => {
    if (!starting && !confirm(`Restart ${device.name}'s server? Replies running there stop.`)) return;
    setBusy("restart");
    setError(undefined);
    try {
      await restartDevice(device.id);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const unpair = async () => {
    if (!confirm(`Unpair ${device.name}? Its projects disappear from here. You can pair it again with a new code.`)) return;
    setBusy("unpair");
    setError(undefined);
    try {
      await removeDevice(device.id);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
      setBusy(undefined);
    }
  };

  return (
    <li className="pi-row device-row">
      <span className={cx("pi-status-dot", dot)} aria-hidden />
      <div className="pi-row-text">
        <span className="pi-row-name">
          {device.name}
          <span className="device-status">{busy === "restart" ? (starting ? "Starting…" : "Restarting…") : label}</span>
        </span>
        <span className="pi-row-desc" title={device.urls.join("\n")}>
          {[device.machine && device.machine !== device.name && device.machine, device.mode === "tailscale" ? "Tailscale" : "LAN", host(device.urls[0]), seen && `seen ${seen}`]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {error && (
          <span className="pi-error device-error" role="alert">
            <CircleAlert size={13} /> {error}
          </span>
        )}
      </div>
      <span className="pi-row-actions">
        {reachable && device.restartable !== false && (
          <IconButton label={starting ? "Start server" : "Restart server"} tooltipSide="top" className="key-icon-btn" disabled={!!busy} onClick={restart}>
            {busy === "restart" ? <Spinner size={14} /> : starting ? <Play size={14} /> : <RotateCw size={14} />}
          </IconButton>
        )}
        <IconButton label={`Unpair ${device.name}`} tooltip="Unpair" tooltipSide="top" className="key-icon-btn key-remove" disabled={!!busy} onClick={unpair}>
          {busy === "unpair" ? <Spinner size={14} /> : <Unlink size={14} />}
        </IconButton>
      </span>
    </li>
  );
}

function ClientRow({ client, onChanged }: { client: PairedClient; onChanged: () => void }) {
  const revoke = () => {
    if (!confirm(`Revoke ${client.name}? It can't use this device until it pairs again.`)) return;
    void revokePairedClient(client.id).then(onChanged, (err: Error) => alert(err.message));
  };
  return (
    <li className="pi-row">
      <div className="pi-row-text">
        <span className="pi-row-name">{client.name}</span>
        <span className="pi-row-desc">
          {[`paired ${ago(client.createdAt)}`, client.lastSeenAt && `active ${ago(client.lastSeenAt)}`].filter(Boolean).join(" · ")}
        </span>
      </div>
      <span className="pi-row-actions">
        <IconButton label={`Revoke ${client.name}`} tooltip="Revoke access" tooltipSide="top" className="key-icon-btn key-remove" onClick={revoke}>
          <Unlink size={14} />
        </IconButton>
      </span>
    </li>
  );
}

export function DevicesSection() {
  const devices = useStore((s) => s.devices);
  const loadDevices = useStore((s) => s.loadDevices);
  const loadProjects = useStore((s) => s.loadProjects);
  const [clients, setClients] = useState<PairedClient[]>();
  // "checking" only for a manual click; the on-open probe runs silently in the background.
  const [check, setCheck] = useState<"idle" | "checking" | "done">("idle");
  const doneTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const local = devices.find((d) => d.local);
  const remote = devices.filter((d) => !d.local);

  const loadClients = useCallback(() => void listPairedClients().then(setClients, () => setClients([])), []);
  const probe = useCallback(
    () => Promise.all([loadDevices().catch(() => {}), listPairedClients().then(setClients, () => setClients([]))]),
    [loadDevices],
  );
  const refresh = async () => {
    clearTimeout(doneTimer.current);
    setCheck("checking");
    await probe();
    setCheck("done");
    doneTimer.current = setTimeout(() => setCheck("idle"), 2200);
  };
  // Statuses are probed fresh each time the page opens, quietly.
  useEffect(() => void probe(), [probe]);
  useEffect(() => () => clearTimeout(doneTimer.current), []);

  const changed = async () => {
    await loadDevices().catch(() => {});
    void loadProjects();
  };

  return (
    <>
      <SettingsHeading>Devices</SettingsHeading>
      {local && (
        <ul className="pi-list">
          <li className="pi-row">
            <span className="pi-status-dot" aria-hidden />
            <div className="pi-row-text">
              <span className="pi-row-name">
                {local.name}
                <span className="device-status">This device</span>
              </span>
            </div>
          </li>
        </ul>
      )}
      <section className="pi-block">
        <div className="pi-subhead">
          <h3>Paired devices</h3>
          <span className="device-check">
            <span className={cx("device-check-note", check !== "idle" && "is-shown")} aria-live="polite">
              {check === "checking" ? "Checking…" : check === "done" ? "Up to date" : ""}
            </span>
            <IconButton label="Check again" tooltipSide="left" className="key-icon-btn" disabled={check === "checking"} onClick={() => void refresh()}>
              {check === "checking" ? <Spinner size={14} /> : check === "done" ? <Check size={14} className="device-check-ok" /> : <RefreshCw size={14} />}
            </IconButton>
          </span>
        </div>
        <ul className="pi-list">
          {remote.map((d) => (
            <PairedDeviceRow key={d.id} device={d} onChanged={changed} />
          ))}
          {!remote.length && (
            <li className="pi-empty">
              None yet. Run <code>openbuild pair --host</code> on the other device, then <code>openbuild pair --client</code> here.
            </li>
          )}
        </ul>
      </section>
      {!!clients?.length && (
        <section className="pi-block">
          <div className="pi-subhead">
            <h3>Using this device</h3>
          </div>
          <ul className="pi-list">
            {clients.map((c) => (
              <ClientRow key={c.id} client={c} onChanged={loadClients} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
