// Whose OpenBots this tab shows: this device's, or a paired device's that let this one use its
// workspace. The choice is this tab's (src/lib/bots/workspace.ts). Moving waits for the current
// workspace's changes to arrive there, and what didn't get confirmed stays listed with the
// workspace it was sent to, never sent anywhere else.
import { Check, ChevronDown, CircleAlert, Laptop, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cancelSwitch, switchWorkspace, useBots, type Unconfirmed } from "../../lib/bots/store";
import { useWorkspace, useWorkspaceName, workspaceName } from "../../lib/bots/workspace";
import { useStore } from "../../lib/store";
import { arrowNav, cx } from "../../lib/ui";
import { Popover, Spinner } from "../primitives";
import { useModal } from "./BotDialogs";

const STATUS: Record<string, string> = { offline: "Offline", revoked: "Pairing revoked", stopped: "Stopped" };

/** The workspace switcher at the top of the OpenBots sidebar. */
export function WorkspacePicker() {
  const workspace = useBots((s) => s.workspace);
  const localId = useWorkspace((s) => s.localId);
  const localName = useWorkspace((s) => s.localName);
  const hosts = useStore((s) => s.devices).filter((d) => !d.local);
  const name = useWorkspaceName(workspace);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open && !useStore.getState().devicesLoaded) void useStore.getState().loadDevices().catch(() => {});
  }, [open]);
  // With nothing paired there's nothing to switch to.
  if (!localId || (!hosts.length && workspace === localId)) return null;
  const choose = (id: string) => {
    setOpen(false);
    void switchWorkspace(id);
  };
  const item = (id: string, label: string, note?: string) => (
    <button key={id} type="button" role="menuitemradio" aria-checked={id === workspace} className="menu-item bots-workspace-item" onClick={() => choose(id)}>
      <span className="bots-workspace-check">{id === workspace && <Check size={14} />}</span>
      <span className="bots-workspace-label">
        {label}
        {note && <span className="bots-workspace-note">{note}</span>}
      </span>
    </button>
  );
  return (
    <>
      <button ref={anchor} type="button" className={cx("bots-workspace", workspace !== localId && "bots-workspace-remote")} aria-haspopup="menu" aria-expanded={open} aria-label={`Workspace: ${name}`} onClick={() => setOpen(!open)}>
        <Laptop size={14} />
        <span className="bots-workspace-name">{name}</span>
        <ChevronDown size={14} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu bots-workspace-menu" role="menu" label="Workspaces" fixed="down">
        <div onKeyDown={(e) => arrowNav(e)}>
          {item(localId, localName || "This device", "This device")}
          {hosts.map((d) => item(d.id, d.name, d.status && d.status !== "online" ? STATUS[d.status] : undefined))}
          {workspace && workspace !== localId && !hosts.some((d) => d.id === workspace) && item(workspace, name, "Not paired anymore")}
        </div>
      </Popover>
    </>
  );
}

/** While a switch waits for the current workspace's changes. Cancelling stays; the changes keep going. */
export function WorkspaceSwitchDialog() {
  const switching = useWorkspace((s) => s.switching);
  const from = useBots((s) => s.workspace);
  if (!switching) return null;
  return <SwitchWaiting waiting={switching.waiting} from={from} to={switching.to} />;
}

function SwitchWaiting({ waiting, from, to }: { waiting: number; from?: string; to: string }) {
  const modal = useModal(cancelSwitch);
  const fromName = useWorkspaceName(from);
  const toName = useWorkspaceName(to);
  return (
    <dialog {...modal} className="bots-dialog bots-switch-dialog" aria-label={`Switching to ${toName}`}>
      <div className="bots-switch-body" role="status">
        <Spinner size={16} />
        <span>
          Waiting for {waiting} {waiting === 1 ? "change" : "changes"} to {fromName}…
        </span>
      </div>
      <p className="bots-switch-hint">{toName} opens once {fromName} has them. Cancel to stay; what's on its way still arrives.</p>
      <div className="bots-dialog-foot">
        <button type="button" className="btn bots-btn" onClick={cancelSwitch}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}

function UnconfirmedRow({ entry, host }: { entry: Unconfirmed; host: string }) {
  const state = entry.missing ? `Not on ${host}` : entry.unknown ? `${host} couldn't tell` : "Checking…";
  return (
    <li className="bots-unconfirmed-row">
      <span className="bots-unconfirmed-text">
        <span className="bots-unconfirmed-label">{entry.label}</span>
        <span className="bots-unconfirmed-state">
          {state} · {entry.error}
        </span>
      </span>
      {entry.missing && (
        <button type="button" className="btn btn-sm" onClick={() => useBots.getState().retryUnconfirmed(entry.id)}>
          <RotateCw size={13} /> Retry
        </button>
      )}
      <button type="button" className="btn btn-sm" aria-label={`Dismiss ${entry.label}`} onClick={() => useBots.getState().dismissUnconfirmed(entry.id)}>
        <X size={13} />
      </button>
    </li>
  );
}

/** Changes this workspace didn't confirm. They're its own: retried only here, against its own snapshot. */
export function NotConfirmed() {
  const list = useBots((s) => s.unconfirmed);
  const workspace = useBots((s) => s.workspace);
  const host = useWorkspaceName(workspace);
  const own = list.filter((e) => e.workspace === workspace);
  if (!own.length) return null;
  return (
    <section className="bots-unconfirmed" aria-label={`Not confirmed on ${host}`}>
      <h3>Not confirmed on {host}</h3>
      <ul>
        {own.map((e) => (
          <UnconfirmedRow key={e.id} entry={e} host={host} />
        ))}
      </ul>
    </section>
  );
}

/** Why the workspace can't be used right now. A workspace that's gone isn't swapped for what's there now. */
export function WorkspaceProblem() {
  const problem = useWorkspace((s) => s.problem);
  const workspace = useBots((s) => s.workspace);
  const localId = useWorkspace((s) => s.localId);
  const localName = useWorkspace((s) => s.localName);
  if (!problem || problem.workspace !== workspace) return null;
  if (problem.kind === "gone")
    return (
      <div className="bots-hello bots-gone" role="alert">
        <CircleAlert size={28} />
        <h2>This workspace is no longer here</h2>
        <p>This tab was using a workspace this address doesn't serve anymore. Nothing from another workspace is shown in its place, and nothing was sent there.</p>
        {localId && localId !== workspace && (
          <button type="button" className="btn bots-btn bots-btn-primary" onClick={() => void switchWorkspace(localId)}>
            Open {localName || "this device"}'s workspace
          </button>
        )}
      </div>
    );
  return null;
}

/** A short line for a workspace that's there but can't be reached or used right now. */
export function workspaceTrouble(problem: ReturnType<typeof useWorkspace.getState>["problem"], workspace?: string): string | undefined {
  if (!problem || problem.workspace !== workspace || problem.kind === "gone") return undefined;
  return problem.message || `${workspaceName(workspace)} can't be used right now.`;
}
