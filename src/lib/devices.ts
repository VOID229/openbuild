// Client side of paired devices: where to send an API request, and which server ids are reachable.
// The server's own id is handled by runtime.ts; this adds the devices paired through
// `openbuild pair --client`, whose APIs are proxied at /api/devices/<id>/….
import type { Device, Project } from "../../shared/types";
import type { Chat, NewWorkspace } from "./types";

let devices: Device[] = [];
const remoteServers = new Set<string>();

export function setDeviceList(next: Device[]): void {
  devices = next;
  remoteServers.clear();
  for (const device of next) if (!device.local && device.serverId) remoteServers.add(device.serverId);
}

export const deviceList = (): Device[] => devices;
export const findDevice = (id: string | undefined): Device | undefined => (id ? devices.find((d) => d.id === id) : undefined);
export const deviceName = (id: string | undefined): string | undefined => findDevice(id)?.name;
/** A remote device's server id, for replies that mark where they run. */
export const deviceServerId = (id: string | undefined): string | undefined => findDevice(id)?.serverId;
export const isRemoteServer = (via: string): boolean => remoteServers.has(via);

/** The local API path, or the same path proxied to a paired device. */
export const apiUrl = (deviceId: string | undefined, path: string): string =>
  deviceId ? `/api/devices/${encodeURIComponent(deviceId)}${path}` : path;

/** Remote project ids are namespaced (`<deviceId>::<id>`) so two devices can't collide. */
export const qualifyProject = (project: Project, device?: Device): Project =>
  device ? { ...project, id: `${device.id}::${project.id}`, deviceId: device.id, deviceName: device.name } : project;

/** Split a project id from a picker/settings back into the device and its native id. */
export function splitProjectId(id: string): { deviceId?: string; id: string } {
  const at = id.indexOf("::");
  return at > 0 ? { deviceId: id.slice(0, at), id: id.slice(at + 2) } : { id };
}

/** The device new threads run on (none = this server). */
export const workspaceDevice = (pref: NewWorkspace): string | undefined => (pref.projectId ? splitProjectId(pref.projectId).deviceId : pref.deviceId);

/** `pref` with its current choice remembered for its device. */
const remembered = (pref: NewWorkspace): NewWorkspace => ({ ...pref, lastProjects: { ...pref.lastProjects, [workspaceDevice(pref) ?? ""]: pref.projectId ?? null } });

/** Choose a project, or the current device's scratch folder (no `projectId`). */
export const chooseProject = (pref: NewWorkspace, projectId?: string): NewWorkspace =>
  remembered({ ...pref, projectId, deviceId: projectId ? splitProjectId(projectId).deviceId : workspaceDevice(pref), branch: undefined });

/**
 * Move to another device, on what was last used there: the choice remembered for it, else the
 * project of its latest thread (or its scratch folder, if that's where the thread ran), else its
 * first project, else its scratch folder.
 */
export function chooseDevice(pref: NewWorkspace, deviceId: string | undefined, projects: Project[], chats: Chat[]): NewWorkspace {
  const usable = projects.filter((p) => (p.deviceId ?? "") === (deviceId ?? "") && !p.missing);
  const known = (id: string) => usable.some((p) => p.id === id);
  let projectId: string | null | undefined = pref.lastProjects?.[deviceId ?? ""];
  if (projectId && !known(projectId)) projectId = undefined;
  if (projectId === undefined) {
    const threads = chats.filter((c) => c.workspace && (c.workspace.deviceId ?? "") === (deviceId ?? "")).sort((a, b) => b.updatedAt - a.updatedAt);
    for (const { workspace } of threads) {
      const id = workspace!.projectId && (deviceId ? `${deviceId}::${workspace!.projectId}` : workspace!.projectId);
      if (!id || known(id)) {
        projectId = id || null;
        break;
      }
    }
  }
  return { ...remembered(pref), deviceId, projectId: (projectId === undefined ? usable[0]?.id : projectId) ?? undefined, branch: undefined };
}
