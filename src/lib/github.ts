// OpenBuild's GitHub credential as the app sees it: which one is in use, the device sign-in under
// way, and where the GitHub App is installed. The server keeps every token; this only ever holds the
// user code GitHub shows the user.
import { create } from "zustand";
import type { DeviceStatus, GithubInstallation, GithubView } from "../../shared/github";

async function request<T>(path: string, method: "GET" | "POST" | "DELETE" = "GET"): Promise<T> {
  const res = await fetch(path, { method });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

interface GithubState {
  view?: GithubView;
  installations?: GithubInstallation[];
  installationsError?: string;
  device?: { flowId: string; status: DeviceStatus };
  load: () => Promise<void>;
  loadInstallations: () => Promise<void>;
  /** Start a device sign-in. Resolves with its first status. */
  startDevice: () => Promise<void>;
  /** Look at the sign-in under way. Resolves with its status, or undefined if there's none. */
  pollDevice: () => Promise<DeviceStatus | undefined>;
  cancelDevice: () => Promise<void>;
  disconnect: () => Promise<void>;
  usePat: () => Promise<void>;
  revoke: () => Promise<void>;
}

export const useGithub = create<GithubState>((set, get) => ({
  load: async () => set({ view: await request<GithubView>("/api/github") }),
  loadInstallations: async () => {
    try {
      const { installations } = await request<{ installations: GithubInstallation[] }>("/api/github/installations");
      set({ installations, installationsError: undefined });
    } catch (err) {
      set({ installationsError: (err as Error).message });
    }
  },
  startDevice: async () => {
    const started = await request<{ flowId: string; status: DeviceStatus }>("/api/github/device", "POST");
    set({ device: started });
  },
  pollDevice: async () => {
    const device = get().device;
    if (!device) return undefined;
    const status = await request<DeviceStatus>(`/api/github/device/${device.flowId}`);
    if (get().device?.flowId === device.flowId) set({ device: { ...device, status } });
    if (status.status === "connected") await Promise.all([get().load(), get().loadInstallations()]);
    return status;
  },
  cancelDevice: async () => {
    const device = get().device;
    set({ device: undefined });
    if (device?.status.status === "pending") await request(`/api/github/device/${device.flowId}`, "DELETE").catch(() => {});
  },
  disconnect: async () => {
    set({ view: await request<GithubView>("/api/github/disconnect", "POST"), installations: undefined, device: undefined });
  },
  usePat: async () => {
    set({ view: await request<GithubView>("/api/github/use-pat", "POST"), installations: undefined });
  },
  revoke: async () => {
    try {
      await request("/api/github/revoke", "POST");
    } finally {
      set({ installations: undefined, device: undefined });
      await get().load();
    }
  },
}));
