// Which OpenBots workspace this tab shows: always this server's, the one the tab is connected to
// (server/bots/workspace.ts). Every workspace goes by its server's real id, this one's too (from
// /api/config), never "local".
//
// There's no choosing another device's. A tab that still has ?workspace=<id> in its address, or an
// id in its session, from when it could, opens this server's anyway and clears them. What that
// workspace kept in this browser (its cached chats, layout and changes it never confirmed) stays
// under its own id: it isn't moved, merged, deleted or sent here.
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

/** Remember this tab's workspace in its session, and clear a stale one from its address. */
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
