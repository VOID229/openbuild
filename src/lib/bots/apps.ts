// OpenBots' connected apps as the app sees them. The catalog ships in shared/apps.ts; this holds what
// the server says about the user's connections, refreshed when the bots stream says they changed.
import { create } from "zustand";
import { appById, appReturnOrigin, type AppsSnapshot, type AppView, type CatalogApp, type OAuthClientId } from "../../../shared/apps";

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
  /** Finish a sign-in with the address it ended on, for one that can't find its way back here. */
  finish: (id: string, url: string) => Promise<void>;
  check: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  forgetClient: (id: OAuthClientId) => Promise<void>;
}

/** The sign-in can't come back to the address OpenBuild is open at, so the user brings it back by hand. */
export const pastesSignIn = (app: CatalogApp) => appReturnOrigin(app, window.location.origin) !== window.location.origin;

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
    const app = appById(id);
    const kind = app?.connection.kind;
    // A pasted sign-in gets a whole tab, where the address is easy to copy.
    const popup = kind === "oauth" || kind === "client" ? (pastesSignIn(app!) ? window.open("", "_blank") : window.open("", "openbots-app-sign-in", "popup,width=560,height=720")) : null;
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
  finish: async (id, url) => {
    try {
      await request(`/api/bots/apps/${id}/finish`, "POST", { url });
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
