// The thread's side of the window: a file tree, and a panel beside the thread holding open files,
// terminals, the diff and browser pages as tabs (src/components/SidePanel.tsx). Both follow the open thread's folder, on the
// device it runs on, as the terminal does (terminal.ts): each folder keeps its own open files, in
// this browser, so coming back to a thread brings its files back.
//
// What's open and how wide it is belongs to this browser tab, not to settings; widths and which
// parts are showing are remembered across reloads.
import { create } from "zustand";
import type { TerminalFolder } from "./terminal";

/** What the panel is showing: a file, a terminal, the diff, a browser tab, or (no tabs) the list of what it can open. */
export type PanelView = "file" | "terminal" | "diff" | "browser" | "launcher";

/** A browser tab in the panel: a page in a frame, with its own address. */
export interface BrowserTab {
  id: string;
  /** Where it is; empty until an address is entered. */
  url: string;
  /** What the address bar says, until it's opened. */
  title?: string;
}

interface Layout {
  panel: boolean;
  tree: boolean;
  /** The panel takes the whole window, the thread hidden behind it. */
  expanded: boolean;
  width: number;
  treeWidth: number;
  /** The tree leaves out dotfiles and what .gitignore matches. */
  hideIgnored: boolean;
}

interface PanelState extends Layout {
  view: PanelView;
  /** The folder the open files belong to. */
  folder?: TerminalFolder;
  /** Open files, as paths relative to the folder. */
  files: string[];
  activeFile?: string;
  /** The diff viewer's tab is open. */
  diff: boolean;
  browsers: BrowserTab[];
  activeBrowser?: string;
  /** Files with edits not saved yet. */
  dirty: Record<string, boolean>;
  setPanel(open: boolean): void;
  setTree(open: boolean): void;
  setExpanded(expanded: boolean): void;
  setView(view: PanelView): void;
  setWidth(width: number): void;
  setTreeWidth(width: number): void;
  setHideIgnored(hide: boolean): void;
  /** Show this folder's open files (the panel's tabs follow the thread). */
  showFolder(folder: TerminalFolder): void;
  openFile(path: string): void;
  closeFile(path: string): void;
  setDirty(path: string, dirty: boolean): void;
  openDiff(): void;
  closeDiff(): void;
  /** A new browser tab, at this address or blank. */
  openBrowser(url?: string): void;
  activateBrowser(id: string): void;
  closeBrowser(id: string): void;
  navigateBrowser(id: string, url: string): void;
}

const LAYOUT_KEY = "openbuild:panel";
export const MIN_WIDTH = 320;
export const MIN_TREE = 180;

function loadLayout(): Layout {
  const fallback: Layout = { panel: false, tree: false, expanded: false, width: 560, treeWidth: 260, hideIgnored: false };
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Partial<Layout> | null;
    if (!saved) return fallback;
    return {
      panel: saved.panel === true,
      tree: saved.tree === true,
      expanded: false,
      width: typeof saved.width === "number" ? Math.max(MIN_WIDTH, saved.width) : fallback.width,
      treeWidth: typeof saved.treeWidth === "number" ? Math.max(MIN_TREE, saved.treeWidth) : fallback.treeWidth,
      hideIgnored: saved.hideIgnored === true,
    };
  } catch {
    return fallback;
  }
}

function saveLayout(s: Layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ panel: s.panel, tree: s.tree, width: s.width, treeWidth: s.treeWidth, hideIgnored: s.hideIgnored }));
  } catch {}
}

export const folderKey = (folder: Pick<TerminalFolder, "deviceId" | "cwd">) => `${folder.deviceId ?? "local"}:${folder.cwd ?? ""}`;
const filesKey = (folder: TerminalFolder) => `openbuild:files:${folderKey(folder)}`;
export const sameFolder = (a: TerminalFolder | undefined, b: TerminalFolder) => !!a && folderKey(a) === folderKey(b);

/** What a folder has open in the panel, besides its terminals (kept in terminal.ts). */
interface Saved {
  files: string[];
  active?: string;
  diff: boolean;
  browsers: BrowserTab[];
  activeBrowser?: string;
}

function loadFiles(folder: TerminalFolder): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(filesKey(folder)) ?? "null") as Record<string, unknown> | null;
    const files = Array.isArray(saved?.files) ? saved.files.filter((f): f is string => typeof f === "string") : [];
    const browsers = Array.isArray(saved?.browsers)
      ? saved.browsers.filter((b): b is BrowserTab => !!b && typeof b.id === "string" && typeof b.url === "string").map((b) => ({ id: b.id, url: b.url }))
      : [];
    return {
      files,
      active: typeof saved?.active === "string" && files.includes(saved.active) ? saved.active : files[0],
      diff: saved?.diff === true,
      browsers,
      activeBrowser: browsers.some((b) => b.id === saved?.activeBrowser) ? (saved!.activeBrowser as string) : browsers[0]?.id,
    };
  } catch {
    return { files: [], diff: false, browsers: [] };
  }
}

function save(s: Pick<PanelState, "folder" | "files" | "activeFile" | "diff" | "browsers" | "activeBrowser">) {
  if (!s.folder) return;
  try {
    if (s.files.length || s.diff || s.browsers.length)
      localStorage.setItem(filesKey(s.folder), JSON.stringify({ files: s.files, active: s.activeFile, diff: s.diff, browsers: s.browsers.map(({ id, url }) => ({ id, url })), activeBrowser: s.activeBrowser }));
    else localStorage.removeItem(filesKey(s.folder));
  } catch {}
}

const newId = () => Math.random().toString(36).slice(2, 10);

export const usePanel = create<PanelState>((set, get) => {
  const layout = (patch: Partial<Layout>) => {
    set(patch);
    saveLayout(get());
  };
  return {
    ...loadLayout(),
    view: "launcher",
    files: [],
    diff: false,
    browsers: [],
    dirty: {},

    setPanel: (panel) => layout(panel ? { panel } : { panel, expanded: false }),
    setTree: (tree) => layout({ tree }),
    setExpanded: (expanded) => set({ expanded }),
    setView: (view) => set({ view }),
    setWidth: (width) => layout({ width: Math.max(MIN_WIDTH, Math.round(width)) }),
    setTreeWidth: (treeWidth) => layout({ treeWidth: Math.max(MIN_TREE, Math.round(treeWidth)) }),
    setHideIgnored: (hideIgnored) => layout({ hideIgnored }),

    showFolder: (folder) => {
      if (sameFolder(get().folder, folder)) return;
      const saved = loadFiles(folder);
      // The view stays what it was; the panel falls back to another tab when this folder has none of it.
      set({ folder, files: saved.files, activeFile: saved.active, diff: saved.diff, browsers: saved.browsers, activeBrowser: saved.activeBrowser, dirty: {} });
    },

    openFile: (path) => {
      const files = get().files;
      const next = files.includes(path) ? files : [...files, path];
      set({ files: next, activeFile: path, view: "file" });
      save(get());
      layout({ panel: true });
    },

    closeFile: (path) => {
      const { files, activeFile, dirty } = get();
      const at = files.indexOf(path);
      if (at < 0) return;
      const rest = files.filter((f) => f !== path);
      const next = activeFile === path ? (rest[at - 1] ?? rest[0]) : activeFile;
      const { [path]: _, ...still } = dirty;
      set({ files: rest, activeFile: next, dirty: still });
      save(get());
    },

    openDiff: () => {
      set({ diff: true, view: "diff" });
      save(get());
      layout({ panel: true });
    },

    closeDiff: () => {
      set({ diff: false });
      save(get());
    },

    openBrowser: (url = "") => {
      const tab: BrowserTab = { id: newId(), url };
      set({ browsers: [...get().browsers, tab], activeBrowser: tab.id, view: "browser" });
      save(get());
      layout({ panel: true });
    },

    activateBrowser: (id) => {
      set({ activeBrowser: id, view: "browser" });
      save(get());
    },

    closeBrowser: (id) => {
      const { browsers, activeBrowser } = get();
      const at = browsers.findIndex((b) => b.id === id);
      if (at < 0) return;
      const rest = browsers.filter((b) => b.id !== id);
      set({ browsers: rest, activeBrowser: activeBrowser === id ? (rest[at - 1] ?? rest[0])?.id : activeBrowser });
      save(get());
    },

    navigateBrowser: (id, url) => {
      set({ browsers: get().browsers.map((b) => (b.id === id ? { ...b, url } : b)) });
      save(get());
    },

    setDirty: (path, dirty) => set((s) => (!!s.dirty[path] === dirty ? {} : { dirty: { ...s.dirty, [path]: dirty } })),
  };
});
