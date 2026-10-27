// The thread's side of the window: a file tree, and a panel beside the thread holding open files and
// terminals as tabs (src/components/SidePanel.tsx). Both follow the open thread's folder, on the
// device it runs on, as the terminal does (terminal.ts): each folder keeps its own open files, in
// this browser, so coming back to a thread brings its files back.
//
// What's open and how wide it is belongs to this browser tab, not to settings; widths and which
// parts are showing are remembered across reloads.
import { create } from "zustand";
import type { TerminalFolder } from "./terminal";

/** What the panel is showing: a file, the terminal's active tab, or (no tabs) the list of what it can open. */
export type PanelView = "file" | "terminal" | "launcher";

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

function loadFiles(folder: TerminalFolder): { files: string[]; active?: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(filesKey(folder)) ?? "null") as { files?: unknown; active?: unknown } | null;
    const files = Array.isArray(saved?.files) ? saved.files.filter((f): f is string => typeof f === "string") : [];
    return { files, active: typeof saved?.active === "string" && files.includes(saved.active) ? saved.active : files[0] };
  } catch {
    return { files: [] };
  }
}

function saveFiles(folder: TerminalFolder | undefined, files: string[], active?: string) {
  if (!folder) return;
  try {
    if (files.length) localStorage.setItem(filesKey(folder), JSON.stringify({ files, active }));
    else localStorage.removeItem(filesKey(folder));
  } catch {}
}

export const usePanel = create<PanelState>((set, get) => {
  const layout = (patch: Partial<Layout>) => {
    set(patch);
    saveLayout(get());
  };
  return {
    ...loadLayout(),
    view: "launcher",
    files: [],
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
      const view = get().view;
      // A file view with no files here falls back to whatever else the panel can show.
      set({ folder, files: saved.files, activeFile: saved.active, dirty: {}, view: view === "file" && !saved.files.length ? "launcher" : view });
    },

    openFile: (path) => {
      const { folder, files } = get();
      const next = files.includes(path) ? files : [...files, path];
      saveFiles(folder, next, path);
      set({ files: next, activeFile: path, view: "file" });
      layout({ panel: true });
    },

    closeFile: (path) => {
      const { folder, files, activeFile, view, dirty } = get();
      const at = files.indexOf(path);
      if (at < 0) return;
      const rest = files.filter((f) => f !== path);
      const next = activeFile === path ? (rest[at - 1] ?? rest[0]) : activeFile;
      saveFiles(folder, rest, next);
      const { [path]: _, ...still } = dirty;
      set({ files: rest, activeFile: next, dirty: still, view: view === "file" && !next ? "launcher" : view });
    },

    setDirty: (path, dirty) => set((s) => (!!s.dirty[path] === dirty ? {} : { dirty: { ...s.dirty, [path]: dirty } })),
  };
});
