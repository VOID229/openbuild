// OpenBots' connected apps as the app sees them. The catalog ships in shared/apps.ts; this holds what
// the server says about the user's connections, refreshed when the bots stream says they changed.
import { create } from "zustand";
import { appById, type AppsSnapshot, type AppView, type OAuthClientId } from "../../../shared/apps";

async function request<T>(path: string, method: "GET" | "POST" | "DELETE" = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

export interface ConnectInput {
  fields?: Record<string, string>;
  client?: { id: string; secret: string };
}

interface AppsState {
  loaded: boolean;
  apps: Record<string, AppView>;
  clients: OAuthClientId[];
  githubKey: boolean;
  load: () => Promise<void>;
  /** Connect an app, sending the user through its sign-in if it has one. Resolves when the popup is on its way, or with the app's state. */
  connect: (id: string, input?: ConnectInput) => Promise<void>;
  check: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  forgetClient: (id: OAuthClientId) => Promise<void>;
}

export const useApps = create<AppsState>((set, get) => ({
  loaded: false,
  apps: {},
  clients: [],
  githubKey: false,
  load: async () => {
    const snap = await request<AppsSnapshot>("/api/bots/apps");
    set({ loaded: true, apps: Object.fromEntries(snap.apps.map((a) => [a.id, a])), clients: snap.clients, githubKey: snap.githubKey });
  },
  connect: async (id, input = {}) => {
    // Opened before anything is awaited, or browsers call it a popup nobody asked for.
    const kind = appById(id)?.connection.kind;
    const popup = kind === "oauth" || kind === "client" ? window.open("", "openbots-app-sign-in", "popup,width=560,height=720") : null;
    try {
      const { authorize } = await request<{ authorize?: string }>(`/api/bots/apps/${id}/connect`, "POST", input);
      if (!authorize) popup?.close();
      else if (popup) popup.location.href = authorize;
      else window.location.href = authorize;
    } catch (err) {
      popup?.close();
      throw err;
    } finally {
      await get().load().catch(() => {});
    }
  },
  check: async (id) => {
    await request(`/api/bots/apps/${id}/check`, "POST");
    await get().load();
  },
  disconnect: async (id) => {
    await request(`/api/bots/apps/${id}`, "DELETE");
    await get().load();
  },
  forgetClient: async (id) => {
    await request(`/api/bots/apps/clients/${id}`, "DELETE");
    await get().load();
  },
}));

export const isConnected = (app?: AppView) => app?.status === "connected";
