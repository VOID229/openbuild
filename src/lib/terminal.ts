// A terminal in the browser: the app side of server/terminals.ts. Cmd/Ctrl+J opens one in the folder
// the open thread works in, on the device that thread runs on — this one, or a paired one through
// /api/devices/<id>/… — and the shell there is a real one on a PTY, not a command runner.
//
// Shells are tabs, in a drawer at the bottom of the thread (⌘J) and, separately, in the side panel
// next to open files: two sets of shells, which can both be open at once. The tabs belong to the folder, not to the tab
// you're looking at: they're kept per folder in this browser, so hiding the drawer or panel,
// reloading, or opening the app on another device brings back the same shells instead of starting
// new ones. A tab whose shell exits (typing `exit`) closes, and the drawer or panel closes with the
// last tab.
import { create } from "zustand";
import { readEvents } from "../../shared/replies";
import type { TerminalEvent } from "../../shared/terminal";
import { apiUrl } from "./devices";
import { uid } from "./id";
import { usePanel } from "./panel";
import { useStore } from "./store";

/** Where the tabs run: a folder on this server, or on a paired one. */
export interface TerminalFolder {
  /** A paired device it runs on. Absent: this server. */
  deviceId?: string;
  /** The folder the shells start in. Absent: that device's home folder. */
  cwd?: string;
  /** What the panel calls it: a project and branch, or "Home folder". */
  label: string;
}

export interface TerminalTab {
  /** The shell's session id on the server (see server/terminals.ts). */
  id: string;
  /** What the shell calls itself — its terminal title — once it has said. */
  title?: string;
}

export interface TerminalState {
  /** The drawer at the bottom is showing (the side panel's own terminals ignore it). */
  open: boolean;
  /** The folder the tabs are in. */
  folder?: TerminalFolder;
  tabs: TerminalTab[];
  active?: string;
  /** This folder's tabs, as they were last time; `start` opens one when there are none. */
  showFolder(folder: TerminalFolder, start?: boolean): void;
  addTab(): void;
  activateTab(id: string): void;
  /** Close a tab, ending its shell (and anything it started). */
  closeTab(id: string): void;
  setTabTitle(id: string, title: string): void;
  hide(): void;
  /** The drawer's height, in pixels, while the user drags its top edge. */
  height: number;
  setHeight(height: number): void;
}

/** Which set of shells: the drawer under the thread (⌘J), or the side panel's own tabs. */
export type TerminalPlace = "bottom" | "side";

/** Open at about half the window, so a phone's screen isn't mostly terminal. */
export const defaultHeight = () =>
  typeof window === "undefined" ? 340 : Math.max(140, Math.min(360, Math.round(window.innerHeight * 0.42)));
const MIN_HEIGHT = 120;

const sameFolder = (a: TerminalFolder | undefined, b: TerminalFolder) => !!a && (a.deviceId ?? "") === (b.deviceId ?? "") && (a.cwd ?? "") === (b.cwd ?? "");

// Tabs are remembered per folder, in this browser: a panel reopened tomorrow attaches to the shells
// that were left running. The drawer and the side panel each keep their own.
const folderKey = (place: TerminalPlace, folder: TerminalFolder) =>
  `openbuild:${place === "side" ? "side-terminal" : "terminal"}:${folder.deviceId ?? "local"}:${folder.cwd ?? ""}`;

function loadTabs(place: TerminalPlace, folder: TerminalFolder): { tabs: TerminalTab[]; active?: string } {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(folderKey(place, folder));
  } catch {}
  if (!raw) return { tabs: [] };
  try {
    const saved = JSON.parse(raw) as { tabs?: unknown; active?: unknown };
    const tabs = Array.isArray(saved.tabs)
      ? saved.tabs.filter((t): t is TerminalTab => !!t && typeof (t as TerminalTab).id === "string").map((t) => ({ id: t.id, ...(typeof t.title === "string" ? { title: t.title } : {}) }))
      : [];
    return { tabs, active: typeof saved.active === "string" ? saved.active : undefined };
  } catch {
    // A single id, from before there were tabs.
    return { tabs: [{ id: raw }] };
  }
}

function saveTabs(place: TerminalPlace, folder: TerminalFolder | undefined, tabs: TerminalTab[], active?: string): void {
  if (!folder) return;
  try {
    localStorage.setItem(folderKey(place, folder), JSON.stringify({ tabs, active }));
  } catch {}
}

/** Show the shells where they live: the drawer opens, or the side panel shows its terminal tab. */
function reveal(place: TerminalPlace) {
  if (place === "bottom") return useTerminal.setState({ open: true });
  const panel = usePanel.getState();
  panel.setView("terminal");
  if (!panel.panel) panel.setPanel(true);
}

// Its own store, not settings: which shells are showing is a thing about this tab, not a preference.
function terminalStore(place: TerminalPlace) {
  return create<TerminalState>((set, get) => ({
    open: false,
    tabs: [],
    height: defaultHeight(),

    showFolder: (folder, start = false) =>
      set((s) => {
        if (sameFolder(s.folder, folder) && (s.tabs.length || !start)) return {};
        const saved = loadTabs(place, folder);
        const tabs = saved.tabs.length || !start ? saved.tabs : [{ id: uid() }];
        const active = tabs.some((t) => t.id === saved.active) ? saved.active! : tabs[0]?.id;
        saveTabs(place, folder, tabs, active);
        return { folder, tabs, active };
      }),

    addTab: () => {
      const { folder, tabs } = get();
      const tab: TerminalTab = { id: uid() };
      const next = [...tabs, tab];
      saveTabs(place, folder, next, tab.id);
      set({ tabs: next, active: tab.id });
      reveal(place);
    },

    activateTab: (id) => {
      const { folder, tabs } = get();
      if (!tabs.some((t) => t.id === id)) return;
      saveTabs(place, folder, tabs, id);
      set({ active: id });
    },

    closeTab: (id) => {
      const { folder, tabs, active } = get();
      const at = tabs.findIndex((t) => t.id === id);
      if (at < 0) return;
      const rest = tabs.filter((t) => t.id !== id);
      // The tab to its left takes over (or the one after it, if it was the first), like a browser's tabs.
      const next = active === id ? (rest[at - 1] ?? rest[0])?.id : active;
      saveTabs(place, folder, rest, next);
      // The drawer closes with its last shell; the side panel moves on to its next tab by itself.
      set(rest.length || place === "side" ? { tabs: rest, active: next } : { tabs: rest, active: next, open: false });
      if (folder) void endSession({ id, ...folder });
    },

    hide: () => set({ open: false }),
    setHeight: (height) => set({ height: Math.max(MIN_HEIGHT, Math.round(height)) }),

    setTabTitle: (id, title) =>
      set((s) => {
        const tabs = s.tabs.map((t) => (t.id === id ? { ...t, title } : t));
        saveTabs(place, s.folder, tabs, s.active);
        return { tabs };
      }),
  }));
}

/** The drawer under the thread: ⌘J. */
export const useTerminal = terminalStore("bottom");
/** The side panel's terminals: separate shells, open alongside the drawer's. */
export const useSideTerminal = terminalStore("side");
export type TerminalStore = typeof useTerminal;
export const terminalStoreFor = (place: TerminalPlace): TerminalStore => (place === "side" ? useSideTerminal : useTerminal);

/**
 * The folder the open thread's terminal would use: its own folder, on its own device. Without a
 * thread, the project the composer is pointed at; without that, the home folder on that device.
 */
export function terminalFolder(): TerminalFolder {
  const st = useStore.getState();
  const ws = st.chats.find((c) => c.id === st.activeChatId)?.workspace;
  const project = st.projects.find((p) => p.id === st.settings.workspace.projectId);
  const label = ws
    ? ws.projectName
      ? `${ws.projectName}${ws.worktree && ws.branch ? ` · ${ws.branch}` : ""}`
      : "Scratch folder"
    : (project?.name ?? "Home folder");
  return { deviceId: ws?.deviceId ?? project?.deviceId ?? st.settings.workspace.deviceId, cwd: ws?.cwd ?? project?.path, label };
}

/** Show the drawer's terminal for the open thread (in its folder and on its device), starting a shell if it has none. */
export function showTerminal(): void {
  useTerminal.getState().showFolder(terminalFolder(), true);
  reveal("bottom");
}

/** Show the side panel's terminal for the open thread, starting a shell there if it has none. */
export function showSideTerminal(): void {
  useSideTerminal.getState().showFolder(terminalFolder(), true);
  reveal("side");
}

/** ⌘J: show the drawer's terminal, or hide it when it's open. The side panel's terminals are separate. */
export function toggleTerminal(): void {
  const { open, hide } = useTerminal.getState();
  if (open) hide();
  else showTerminal();
}

/**
 * Follow the thread: opening another thread shows that folder's shells and files, not the last
 * one's. A drawer that's showing starts a shell in a folder that has none.
 */
export function refreshTerminal(): void {
  const folder = terminalFolder();
  usePanel.getState().showFolder(folder);
  useTerminal.getState().showFolder(folder, useTerminal.getState().open);
  useSideTerminal.getState().showFolder(folder);
}

/** Open a new tab in the drawer, or in the side panel. */
export function newTerminalTab(place: TerminalPlace = "bottom"): void {
  terminalStoreFor(place).getState().addTab();
}

/** Start the active tab's shell over: a new shell, in the same folder. */
export function restartTerminalTab(place: TerminalPlace = "bottom"): void {
  const store = terminalStoreFor(place);
  const { folder, tabs, active } = store.getState();
  const tab = tabs.find((t) => t.id === active);
  if (!folder || !tab) return;
  void endSession({ id: tab.id, ...folder });
  const fresh: TerminalTab = { id: uid() };
  const next = tabs.map((t) => (t.id === tab.id ? fresh : t));
  saveTabs(place, folder, next, fresh.id);
  store.setState({ tabs: next, active: fresh.id });
}

// ---------------------------------------------------------------------------- the connection

export interface TerminalHooks {
  /** Output, as the browser's terminal should draw it. */
  onEvent(event: TerminalEvent): void;
  /** The server can't be reached right now; it's being retried. */
  onRetrying?(retrying: boolean): void;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });

type SessionRef = { id: string } & Pick<TerminalFolder, "deviceId" | "cwd">;

const path = (ref: SessionRef, rest = "") => `/api/terminals/${encodeURIComponent(ref.id)}${rest}`;
const post = (url: string, body: unknown, signal?: AbortSignal) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });

/**
 * One shell, followed from this browser tab. `run` opens it (or attaches to it) and streams its
 * output until the shell exits; typing and resizing go the other way. Stopping doesn't stop the shell.
 */
export class TerminalConnection {
  private readonly ctrl = new AbortController();
  private typed = "";
  private typing?: ReturnType<typeof setTimeout>;
  private resizing?: ReturnType<typeof setTimeout>;
  private size?: { cols: number; rows: number };
  private opened = false;
  private ended = false;

  constructor(
    private readonly session: SessionRef,
    private readonly hooks: TerminalHooks,
  ) {}

  /** Open it on the server (attaching if it's already running) and follow it until it ends. */
  async run(size: { cols: number; rows: number }): Promise<void> {
    this.size = size;
    if (!(await this.open(size))) return;
    await this.follow();
  }

  private async open(size: { cols: number; rows: number }): Promise<boolean> {
    let res: Response;
    try {
      res = await post(apiUrl(this.session.deviceId, "/api/terminals"), { id: this.session.id, cwd: this.session.cwd, ...size }, this.ctrl.signal);
    } catch (err) {
      if (this.ctrl.signal.aborted) return false;
      throw new Error(`Couldn't reach ${this.session.deviceId ? "that device" : "the server"}: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Couldn't open a terminal (HTTP ${res.status})`);
    this.opened = true;
    return true;
  }

  private async follow(): Promise<void> {
    const url = apiUrl(this.session.deviceId, path(this.session));
    let delay = 500;
    while (!this.ctrl.signal.aborted && !this.ended) {
      let res: Response | undefined;
      try {
        res = await fetch(url, { signal: this.ctrl.signal });
      } catch {
        // Unreachable; retried below.
      }
      if (res?.status === 404) throw new Error("This terminal isn't running anymore (the server restarted?). Restart the tab to start a new one.");
      if (res?.ok && res.body) {
        this.hooks.onRetrying?.(false);
        try {
          for await (const e of readEvents(res.body) as AsyncGenerator<TerminalEvent>) {
            if (e.t === "end") return;
            delay = 500;
            if (e.t === "exit") this.ended = true;
            this.hooks.onEvent(e);
          }
        } catch {
          // Cut off: follow it again below, from the output so far.
        }
      }
      if (this.ctrl.signal.aborted || this.ended) return;
      this.hooks.onRetrying?.(true);
      await wait(delay, this.ctrl.signal);
      delay = Math.min(delay * 2, 5000);
    }
  }

  /** Typed keys, pasted text, control sequences — coalesced so a burst is one request. */
  input(data: string): void {
    if (this.ended) return;
    this.typed += data;
    this.typing ??= setTimeout(() => this.sendTyped(), 8);
  }

  private sendTyped() {
    clearTimeout(this.typing);
    this.typing = undefined;
    const data = this.typed;
    this.typed = "";
    // A big paste goes in pieces, well under what the server accepts at once.
    for (let at = 0; at < data.length; at += 50_000) {
      void post(apiUrl(this.session.deviceId, path(this.session, "/input")), { data: data.slice(at, at + 50_000) }).catch(() => {});
    }
  }

  /** Tell the shell how big the screen is, so wrapping and full-screen programs match. */
  resize(size: { cols: number; rows: number }): void {
    if (this.ended) return;
    this.size = size;
    clearTimeout(this.resizing);
    this.resizing = setTimeout(() => {
      if (!this.opened || this.ended || !this.size) return;
      void post(apiUrl(this.session.deviceId, path(this.session, "/resize")), this.size).catch(() => {});
    }, 150);
  }

  /** Stop following it. The shell keeps running, so opening the tab again brings the session back. */
  stop(): void {
    this.ctrl.abort();
    clearTimeout(this.typing);
    clearTimeout(this.resizing);
  }
}

/** End a shell (and anything it started) on the server. */
export async function endSession(session: SessionRef): Promise<void> {
  await fetch(apiUrl(session.deviceId, path(session)), { method: "DELETE" }).catch(() => {});
}
