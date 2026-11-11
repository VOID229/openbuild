import { isRemoteServer } from "./devices";
import { EXTERNAL_VIA } from "../../shared/replies";
import { fetchWithTimeout } from "./abort";
import { asRelease, type AppRelease } from "../../shared/version";

// Where this copy of the app runs, read once at startup from /api/config:
//   - "local":  served by your own OpenChat server, which keeps chats and settings on disk and API
//               keys in the OS keychain.
//   - "hosted": the public website. There's no server-side storage: chats, settings and API keys
//               stay in this browser (and sync, end-to-end encrypted, when you sign in), and the
//               relay only forwards each request.
export interface AppConfig {
  mode: "local" | "hosted";
  /** The sync service to sign in to, if any. */
  convexUrl: string | null;
  /** Local: names the server, so the app only picks up replies running on it (see shared/replies.ts). */
  serverId?: string;
  /** The computer the server (and Pi) runs on, e.g. "Gal's MacBook Pro". */
  machine?: string;
  /** Local: the release the server is running (shared/release.ts). */
  release?: AppRelease;
}

let resolved: AppConfig | undefined;

export const config: Promise<AppConfig> = (async () => {
  try {
    const res = await fetchWithTimeout("/api/config", {}, 3000);
    const c = (await res.json()) as Partial<AppConfig>;
    return { mode: c.mode === "hosted" ? "hosted" : "local", convexUrl: c.convexUrl || null, serverId: c.serverId, machine: c.machine, release: asRelease(c.release) } as AppConfig;
  } catch {
    return { mode: "local", convexUrl: null } as AppConfig;
  }
})().then((c) => (resolved = c));

/** Whether this is the hosted website. Only valid once `config` has resolved (it has by the time the app renders). */
export const isHosted = () => resolved?.mode === "hosted";

/** Where replies started here run (see shared/replies.ts). */
export const replyHost = () => (resolved?.mode === "hosted" ? "hosted" : resolved?.serverId);

/** Whether this app can pick up a reply that runs at `via`: the website's, or this same local server's. */
export const canResume = (via: string | undefined, deviceId?: string) =>
  !!resolved && (resolved.mode === "hosted" ? via === "hosted" && !!resolved.convexUrl : !!resolved.serverId && (via === resolved.serverId || isRemoteServer(via ?? "") || (!!deviceId && !!via && via !== EXTERNAL_VIA && via !== "hosted")));
// A saved deviceId already names the proxy route. Device discovery may still be loading when
// chats load; settling the reply as stopped then would make the later resume pass miss it forever.

/** The computer threads run on (once `config` has resolved). */
export const machineName = () => resolved?.machine;

/** The release the server is running (once `config` has resolved); undefined when it didn't say. */
export const appRelease = () => resolved?.release;
