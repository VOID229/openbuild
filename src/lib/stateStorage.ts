// Where the persisted UI state (settings, sidebar layout) lives. Hosted site: this browser's
// localStorage. Local app: on the local OpenChat server, in
// the same on-disk database as chats. localStorage keeps a copy only so index.html can apply the
// theme before first paint, and as a fallback when the server can't be reached at startup.
//
// Nothing is written to the server until the saved state has been read from it. zustand's persist
// writes on every change, including changes made before hydration finishes, and those would
// otherwise replace your saved settings with the defaults.
import type { StateStorage } from "zustand/middleware";
import { config } from "./runtime";

let ready = false;
let pending: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 1000;

const local = {
  get: (name: string) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  set: (name: string, value: string) => {
    try {
      localStorage.setItem(name, value);
    } catch {}
  },
};

/** The saved state: a string, null when nothing was ever saved, undefined when the server is unreachable. */
async function fetchState(): Promise<string | null | undefined> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch("/api/state");
      if (res.ok) return ((await res.json()) as { state: string | null }).state;
    } catch {}
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  return undefined;
}

async function push() {
  timer = undefined;
  const value = pending;
  if (value === undefined) return;
  try {
    const res = await fetch("/api/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: value }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (pending === value) pending = undefined;
    retryDelay = 1000;
  } catch (err) {
    console.warn("Couldn't save settings; retrying", err);
    timer ??= setTimeout(push, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  }
}

function queue(value: string, delay = 250) {
  pending = value;
  if (timer) clearTimeout(timer);
  timer = setTimeout(push, delay);
}

if (typeof window !== "undefined") {
  // Don't lose a change made just before the tab closes.
  window.addEventListener("pagehide", () => {
    if (pending === undefined) return;
    void fetch("/api/state", { method: "PUT", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify({ state: pending }) }).catch(() => {});
  });
}

export const serverStorage: StateStorage = {
  getItem: async (name) => {
    // The hosted site has no server storage: settings live in this browser (and sync when signed in).
    if ((await config).mode === "hosted") return local.get(name);
    const saved = await fetchState();
    const cached = local.get(name);
    ready = true;
    if (typeof saved === "string") {
      local.set(name, saved);
      return saved;
    }
    // First run with server storage: what this browser had becomes the saved state.
    if (saved === null && cached) queue(cached, 0);
    return cached;
  },
  setItem: (name, value) => {
    local.set(name, value);
    if (ready) queue(value);
  },
  removeItem: () => {},
};
