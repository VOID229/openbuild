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
}

let resolved: AppConfig | undefined;

export const config: Promise<AppConfig> = (async () => {
  try {
    const res = await fetch("/api/config");
    const c = (await res.json()) as Partial<AppConfig>;
    return { mode: c.mode === "hosted" ? "hosted" : "local", convexUrl: c.convexUrl || null } as AppConfig;
  } catch {
    return { mode: "local", convexUrl: null } as AppConfig;
  }
})().then((c) => (resolved = c));

/** Whether this is the hosted website. Only valid once `config` has resolved (it has by the time the app renders). */
export const isHosted = () => resolved?.mode === "hosted";
