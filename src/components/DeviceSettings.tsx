// Settings → Devices: the devices this OpenBuild is paired with and where their servers stand, and
// pairing another (PairDevice.tsx). Each device, this one included, opens a page of its own:
// restarting or unpairing it, whether this server's bots may use it and how they're isolated there
// (the device's owner allows them on that device, under Using this device; the isolation is chosen
// here). Also the devices that use this one, each with a page to revoke its access or allow its bots.
import { Check, ChevronRight, CircleAlert, Link2, Play, RefreshCw, RotateCw, Unlink, UserRoundCheck, UserRoundX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ComputerTarget, Isolation } from "../../shared/bots";
import type { Device, PairedClient } from "../../shared/types";
import { deviceRowId, loadTargets, setIsolation, targetNote, targetStatus, targetSummary, useDeviceFocus } from "../lib/bots/targets";
import { listPairedClients, removeDevice, restartDevice, revokePairedClient, setDeviceExternal } from "../lib/pi";
import { useStore } from "../lib/store";
import { ago, cx } from "../lib/ui";
import { openSettingsPage } from "../lib/pages";
import { SettingsGroup, SubPage } from "./SettingsUI";
import { BotAccess } from "./BotAccess";
import { OptionSelect } from "./ModelSelect";
import { PairDevice } from "./PairDevice";
import { IconButton, SettingsHeading, Spinner } from "./primitives";

const STATUS: Record<NonNullable<Device["status"]>, { label: string; dot?: string }> = {
  online: { label: "Online" },
  stopped: { label: "Server stopped", dot: "pi-status-dot-warn" },
  offline: { label: "Unreachable", dot: "pi-status-dot-off" },
  revoked: { label: "Pairing revoked", dot: "pi-status-dot-bad" },
};

const host = (url: string | undefined) => (url ? url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "no address");

const ISOLATION: Record<Isolation, string> = { container: "Container", host: "Host (unisolated)" };

/**
 * What this server's bots may do on one machine, and how they're kept apart there. Whether a paired
 * device allows them is up to that device (it's checked there on every request), so here it's only
 * shown, with where to change it. The isolation is this server's choice, the host unless the user
 * picks a container; host on a paired device also needs that device's Unisolated, and one without it
 * offers only a container.
 */
function BotsOnDevice({ target, here, onChanged }: { target: ComputerTarget; here: string; onChanged: (isolation: Isolation) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const local = target.device === "local";
  const hostAllowed = local || !!target.grants?.unisolated;
  const kind = target.isolation ?? (hostAllowed ? "host" : "container");
  const note = targetNote(target, here);
  const noEngine = local && kind === "container" && target.engines?.length === 0;
  // Until a device answers and allows bots, its grants aren't known: there's nothing to choose yet, unless host is to be undone.
  const choosable = local || target.status === "ready" || kind === "host";
  const options = (["host", "container"] as const).filter((k) => k === "container" || hostAllowed || kind === "host").map((k) => ({ value: k, label: ISOLATION[k] }));
  const change = async (next: Isolation) => {
    if (next === kind) return;
    if (next === "host" && !confirm(`Run bots unisolated on ${target.name}? They could read and change anything ${local ? "the user running OpenBuild here" : `the user running OpenBuild on ${target.name}`} can.`)) return;
    setBusy(true);
    setError(undefined);
    try {
      onChanged(await setIsolation(target.device, next));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const summary = targetSummary(target);
  return (
    <div className="bot-access bot-on-device" role="group" aria-label={`This server's bots on ${target.name}`}>
      <span className="bot-access-title">
        {local ? "This server's bots" : `${here}'s bots`} · {local ? "always allowed" : targetStatus(target)}
        {summary && ` · ${summary}`}
      </span>
      {note && (
        <span className={cx("setting-desc bot-target-note", note.tone === "bad" && "bot-target-note-bad")}>
          <CircleAlert size={13} aria-hidden /> {note.text}
        </span>
      )}
      {noEngine && (
        <span className="setting-desc bot-target-note">
          <CircleAlert size={13} aria-hidden /> There's no container engine here. Install Podman or Docker, or choose Host.
        </span>
      )}
      {choosable && (
        <div className="bot-access-row">
          <div className="pi-row-text">
            <span className="pi-row-name">Isolation</span>
            <span className="pi-row-desc">
              {hostAllowed
                ? "Host is the default: bots run as the user running OpenBuild. A container isolates them."
                : `Container only: ${target.name} hasn't allowed Unisolated for this server's bots.`}
            </span>
          </div>
          {busy && <Spinner size={14} />}
          <OptionSelect label={`Isolation on ${target.name}`} value={kind} options={options} disabled={busy || options.length < 2} onChange={(v) => void change(v)} />
        </div>
      )}
      {error && (
        <span className="pi-error device-error" role="alert">
          <CircleAlert size={13} /> {error}
        </span>
      )}
    </div>
  );
}

/** The device a link (from a bot's machine list, say) asked for: scrolled to and marked once its row is there. */
function useFocusedRow(device: string, ready: boolean) {
  const focus = useDeviceFocus((s) => s.device);
  const ref = useRef<HTMLLIElement>(null);
  const focused = focus === device;
  useEffect(() => {
    if (!focused || !ready) return;
    ref.current?.scrollIntoView({ block: "center" });
    ref.current?.focus({ preventScroll: true });
  }, [focused, ready]);
  return { ref, focused };
}

function PairedDeviceRow({ device, target, here, onChanged, onTarget }: { device: Device; target?: ComputerTarget; here: string; onChanged: () => Promise<void>; onTarget: (isolation: Isolation) => void }) {
  const row = useFocusedRow(device.id, !!target);
  const [busy, setBusy] = useState<"restart" | "unpair" | "external">();
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

  const toggleExternal = async () => {
    setBusy("external");
    setError(undefined);
    try {
      await setDeviceExternal(device.id, !device.external);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <li ref={row.ref} id={deviceRowId(device.id)} tabIndex={-1} className={cx("pi-row pi-row-stack device-row", row.focused && "device-row-focused")}>
      <div className="pi-row-line">
        <span className={cx("pi-status-dot", dot)} aria-hidden />
        <div className="pi-row-text">
          <span className="pi-row-name">
            {device.name}
            <span className="device-status">{busy === "restart" ? (starting ? "Starting…" : "Restarting…") : label}</span>
            {device.external && <span className="device-status">· External</span>}
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
          <IconButton
            label={device.external ? `Mark ${device.name} as yours` : `Mark ${device.name} as external`}
            tooltip={device.external ? "Mark as yours" : "Mark as external: not yours, so no usage or update prompts"}
            tooltipSide="top"
            className="key-icon-btn"
            aria-pressed={!!device.external}
            disabled={!!busy}
            onClick={toggleExternal}
          >
            {busy === "external" ? <Spinner size={14} /> : device.external ? <UserRoundCheck size={14} /> : <UserRoundX size={14} />}
          </IconButton>
          <IconButton label={`Unpair ${device.name}`} tooltip="Unpair" tooltipSide="top" className="key-icon-btn key-remove" disabled={!!busy} onClick={unpair}>
            {busy === "unpair" ? <Spinner size={14} /> : <Unlink size={14} />}
          </IconButton>
        </span>
      </div>
      {target && <BotsOnDevice target={target} here={here} onChanged={onTarget} />}
    </li>
  );
}

/** This device, with how its own bots are isolated here. */
function LocalDeviceRow({ name, target, onTarget }: { name: string; target?: ComputerTarget; onTarget: (isolation: Isolation) => void }) {
  const row = useFocusedRow("local", !!target);
  return (
    <li ref={row.ref} id={deviceRowId("local")} tabIndex={-1} className={cx("pi-row pi-row-stack device-row", row.focused && "device-row-focused")}>
      <div className="pi-row-line">
        <span className="pi-status-dot" aria-hidden />
        <div className="pi-row-text">
          <span className="pi-row-name">
            {name}
            <span className="device-status">This device</span>
          </span>
        </div>
      </div>
      {target && <BotsOnDevice target={target} here={target.name} onChanged={onTarget} />}
    </li>
  );
}

/** A device on Settings → Devices' list: where it stands, and what this server's bots may do there; its page has the rest. */
function DeviceLink({ id, name, note, desc, dot, target }: { id: string; name: string; note?: string; desc?: string; dot?: string; target?: ComputerTarget }) {
  const summary = target && [target.device === "local" ? "Bots always allowed" : targetStatus(target), targetSummary(target)].filter(Boolean).join(" · ");
  return (
    <li id={deviceRowId(id)} className="pi-row device-row">
      <button type="button" className="device-link" onClick={() => openSettingsPage(`device/${encodeURIComponent(id)}`)}>
        <span className={cx("pi-status-dot", dot)} aria-hidden />
        <span className="pi-row-text">
          <span className="pi-row-name">
            {name}
            {note && <span className="device-status">{note}</span>}
          </span>
          {(desc || summary) && <span className="pi-row-desc">{[desc, summary].filter(Boolean).join(" · ")}</span>}
        </span>
        <ChevronRight size={16} className="nav-row-chevron" aria-hidden />
      </button>
    </li>
  );
}

function ClientRow({ client, onChanged }: { client: PairedClient; onChanged: () => void }) {
  const revoke = () => {
    if (!confirm(`Revoke ${client.name}? It can't use this device until it pairs again.`)) return;
    void revokePairedClient(client.id).then(onChanged, (err: Error) => alert(err.message));
  };
  return (
    <li className="pi-row pi-row-stack">
      <div className="pi-row-line">
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
      </div>
      <BotAccess client={client} />
    </li>
  );
}

export function DevicesSection() {
  const devices = useStore((s) => s.devices);
  const loadDevices = useStore((s) => s.loadDevices);
  const loadProjects = useStore((s) => s.loadProjects);
  const [clients, setClients] = useState<PairedClient[]>();
  const [targets, setTargets] = useState<ComputerTarget[]>();
  // "checking" only for a manual click; the on-open probe runs silently in the background.
  const [check, setCheck] = useState<"idle" | "checking" | "done">("idle");
  const doneTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pairing, setPairing] = useState(false);
  const [paired, setPaired] = useState<string>();
  const pairButton = useRef<HTMLButtonElement>(null);
  const local = devices.find((d) => d.local);
  const remote = devices.filter((d) => !d.local);

  const loadClients = useCallback(() => void listPairedClients().then(setClients, () => setClients([])), []);
  const probe = useCallback(
    () => Promise.all([loadDevices().catch(() => {}), listPairedClients().then(setClients, () => setClients([])), loadTargets().then(setTargets, () => setTargets([]))]),
    [loadDevices],
  );
  const targetOf = (device: string) => targets?.find((t) => t.device === device);
  const here = targetOf("local")?.name ?? local?.name ?? "this server";
  const isolated = (device: string) => (isolation: Isolation) => setTargets((list) => list?.map((t) => (t.device === device ? { ...t, isolation } : t)));
  const page = useStore((s) => s.settingsPage);
  // A link asked for one device: once it's been shown, the next visit opens at the top again.
  useEffect(() => () => useDeviceFocus.setState({ device: undefined }), []);
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

  const closePairing = () => {
    setPairing(false);
    // A search stopped just as it succeeded still pairs, so look again.
    void changed();
    requestAnimationFrame(() => pairButton.current?.focus());
  };
  const onPaired = async (device: Device) => {
    setPaired(device.name);
    closePairing();
  };

  // A device's page (settings/devices/device/<id>, "local" for this one) or a client's (settings/devices/client/<id>).
  const [kind, rawId] = page?.split("/") ?? [];
  const id = rawId && decodeURIComponent(rawId);
  if (kind === "device" && id) {
    const device = id === "local" ? local : remote.find((d) => d.id === id);
    if (!device) return <SubPage title={id} trail={["Devices"]}><p className="pi-empty">{devices.length ? "This device isn't paired anymore." : ""}</p></SubPage>;
    return (
      <SubPage title={device.name} trail={["Devices"]}>
        <ul className="pi-list">
          {device.local ? (
            <LocalDeviceRow name={device.name} target={targetOf("local")} onTarget={isolated("local")} />
          ) : (
            <PairedDeviceRow device={device} target={targetOf(device.id)} here={here} onChanged={changed} onTarget={isolated(device.id)} />
          )}
        </ul>
      </SubPage>
    );
  }
  if (kind === "client" && id) {
    const client = clients?.find((c) => c.id === id);
    return (
      <SubPage title={client?.name ?? "Device"} trail={["Devices", "Using this device"]}>
        {client ? (
          <ul className="pi-list">
            <ClientRow client={client} onChanged={loadClients} />
          </ul>
        ) : (
          clients && <p className="pi-empty">This device doesn't use this one anymore.</p>
        )}
      </SubPage>
    );
  }

  const status = (d: Device) => STATUS[d.status ?? (d.online === false ? "offline" : "online")];
  return (
    <>
      <SettingsHeading>Devices</SettingsHeading>
      {local && (
        <ul className="pi-list">
          <DeviceLink id="local" name={local.name} note="This device" target={targetOf("local")} />
        </ul>
      )}
      <SettingsGroup
        title="Paired devices"
        action={
          <span className="device-check">
            {!pairing && (
              <button
                ref={pairButton}
                type="button"
                className="btn btn-sm pair-open"
                onClick={() => {
                  setPaired(undefined);
                  setPairing(true);
                }}
              >
                <Link2 size={14} aria-hidden /> Pair device
              </button>
            )}
            <span className={cx("device-check-note", check !== "idle" && "is-shown")} aria-live="polite">
              {check === "checking" ? "Checking…" : check === "done" ? "Up to date" : ""}
            </span>
            <IconButton label="Check again" tooltipSide="left" className="key-icon-btn" disabled={check === "checking"} onClick={() => void refresh()}>
              {check === "checking" ? <Spinner size={14} /> : check === "done" ? <Check size={14} className="device-check-ok" /> : <RefreshCw size={14} />}
            </IconButton>
          </span>
        }
      >
        {pairing && <PairDevice onPaired={onPaired} onClose={closePairing} />}
        {paired && (
          <p className="pair-done" role="status">
            <Check size={14} className="device-check-ok" aria-hidden /> Paired with {paired}.
          </p>
        )}
        <ul className="pi-list">
          {remote.map((d) => (
            <DeviceLink
              key={d.id}
              id={d.id}
              name={d.name}
              note={[status(d).label, d.external && "External"].filter(Boolean).join(" · ")}
              dot={status(d).dot}
              desc={[d.mode === "tailscale" ? "Tailscale" : "LAN", host(d.urls[0])].join(" · ")}
              target={targetOf(d.id)}
            />
          ))}
          {!remote.length && (
            <li className="pi-empty">
              None yet. Run <code>openbuild pair --host</code> on the other device, then choose Pair device here (or run{" "}
              <code>openbuild pair --client</code>).
            </li>
          )}
        </ul>
      </SettingsGroup>
      {!!clients?.length && (
        <SettingsGroup title="Using this device">
          <ul className="pi-list">
            {clients.map((c) => (
              <li key={c.id} className="pi-row device-row">
                <button type="button" className="device-link" onClick={() => openSettingsPage(`client/${encodeURIComponent(c.id)}`)}>
                  <span className="pi-row-text">
                    <span className="pi-row-name">{c.name}</span>
                    <span className="pi-row-desc">{[`paired ${ago(c.createdAt)}`, c.lastSeenAt && `active ${ago(c.lastSeenAt)}`].filter(Boolean).join(" · ")}</span>
                  </span>
                  <ChevronRight size={16} className="nav-row-chevron" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </SettingsGroup>
      )}
    </>
  );
}
