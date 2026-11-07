// Which OpenBots workspace this tab shows: this server's, or a paired host's that let this device
// use it (server/bots/workspace.ts). Every workspace goes by its server's real id, this one's too
// (from /api/config), never "local".
//
// The choice is this tab's own: sessionStorage, and ?workspace=<id> in the address while it's
// another device's. The server keeps no current host. A tab that comes back to an id its origin no
// longer serves, or isn't paired with, says the workspace is no longer here; it never takes on the
// server that answers there now.
import { create } from "zustand";
import { config } from "../runtime";
import { useStore } from "../store";

export const WORKSPACE_PARAM = "workspace";
const SESSION_KEY = "openbuild.workspace";

/** Why the workspace this tab shows can't be used right now. */
export type WorkspaceProblem = "gone" | "offline" | "denied" | "revoked" | "mismatch" | "outdated" | "redirect" | "unknown";

interface WorkspaceState {
  /** This server's id and name, once /api/config has answered. */
  localId?: string;
  localName?: string;
  /** Set while a switch waits for the current workspace's changes to settle. */
  switching?: { to: string; waiting: number };
  problem?: { workspace: string; kind: WorkspaceProblem; message: string };
}

export const useWorkspace = create<WorkspaceState>(() => ({}));

/** This server's id and name, from /api/config. */
export async function localWorkspace(): Promise<{ id?: string; name?: string }> {
  const c = await config;
  if (c.serverId) useWorkspace.setState({ localId: c.serverId, localName: c.machine });
  const { localId, localName } = useWorkspace.getState();
  return { id: localId, name: localName };
}

export const isLocalWorkspace = (id: string | undefined) => !!id && id === useWorkspace.getState().localId;

/**
 * Where a workspace's conversations are reached. This server's own goes through the same bound
 * route a paired device uses, so a tab whose origin starts serving another server is told 409
 * instead of writing there; another device's goes through this server, which holds its pairing.
 */
export function workspacePath(id: string, path: string): string {
  return `/api/workspace/${isLocalWorkspace(id) ? "to" : "via"}/${encodeURIComponent(id)}${path}`;
}

/** What to call a workspace: this device's name, or the paired host's. */
export function workspaceName(id: string | undefined): string {
  const { localId, localName } = useWorkspace.getState();
  if (id && id === localId) return localName || "this device";
  return useStore.getState().devices?.find((d) => d.id === id)?.name || "the other device";
}

export const useWorkspaceName = (id: string | undefined) => {
  useWorkspace((s) => s.localName);
  useStore((s) => s.devices);
  return workspaceName(id);
};

function read(fn: () => string | null | undefined): string | undefined {
  try {
    return fn() || undefined;
  } catch {
    return undefined;
  }
}

/** The workspace this tab chose before: its address first, then its session. Undefined in a new tab. */
export function chosenWorkspace(): string | undefined {
  return read(() => new URL(location.href).searchParams.get(WORKSPACE_PARAM)) ?? read(() => sessionStorage.getItem(SESSION_KEY));
}

/** Remember this tab's workspace, in its session and, for another device's, its address. */
export function rememberWorkspace(id: string) {
  try {
    sessionStorage.setItem(SESSION_KEY, id);
  } catch {}
  try {
    const url = new URL(location.href);
    if (isLocalWorkspace(id)) url.searchParams.delete(WORKSPACE_PARAM);
    else url.searchParams.set(WORKSPACE_PARAM, id);
    if (url.href !== location.href) history.replaceState(history.state, "", url);
  } catch {}
}

/** What a refusal from a workspace route means for the tab. */
export function problemFrom(workspace: string, status: number, body: { error?: string; reason?: string } | undefined): NonNullable<WorkspaceState["problem"]> {
  const name = workspaceName(workspace);
  const reason = body?.reason;
  if (reason === "unpaired" || (status === 409 && isLocalWorkspace(workspace))) return { workspace, kind: "gone", message: "This workspace is no longer here." };
  if (reason === "offline" || status === 502 || status === 503 || status === 504) {
    if (reason === "mismatch" || reason === "outdated" || reason === "redirect") return { workspace, kind: reason, message: body?.error ?? `${name} didn't answer as itself. Nothing ran.` };
    return { workspace, kind: "offline", message: `${name} is unreachable. Nothing here falls back to another workspace; it reconnects when ${name} answers.` };
  }
  if (status === 401 || reason === "revoked") return { workspace, kind: "revoked", message: body?.error ?? `${name} no longer trusts this pairing.` };
  if (status === 403 && reason === "denied") return { workspace, kind: "denied", message: body?.error ?? `${name} hasn't let this device use its OpenBots workspace.` };
  return { workspace, kind: "unknown", message: body?.error ?? `${name} answered HTTP ${status}.` };
}
