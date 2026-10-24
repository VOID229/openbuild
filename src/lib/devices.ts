// Client side of paired devices: where to send an API request, and which server ids are reachable.
// The server's own id is handled by runtime.ts; this adds the devices paired through
// `openbuild pair --client`, whose APIs are proxied at /api/devices/<id>/….
import type { Device, Project } from "../../shared/types";

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
