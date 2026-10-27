// The file tree at the right edge: the open thread's folder (or the project the composer is set to),
// a folder at a time as you open them. Files that changed since the last commit are tinted, what
// .gitignore matches is dimmed (or hidden, with the eye), and typing in the search finds any file by
// name. Clicking a file opens it in the side panel (SidePanel.tsx).
import { ChevronRight, Eye, EyeOff, File, FileCode, FileImage, FileJson, FileTerminal, FileText, Folder, FolderOpen, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TreeEntry, WorkspaceEntry } from "../../shared/types";
import { loadEntries, matchEntries } from "../lib/fileMentions";
import { folderKey, usePanel } from "../lib/panel";
import type { TerminalFolder } from "../lib/terminal";
import { cx } from "../lib/ui";
import { FileError, listDir } from "../lib/workspaceFiles";
import { IconButton } from "./primitives";

/** An icon for a file, by its name. */
export function FileIcon({ name, size = 15 }: { name: string; size?: number }) {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  let Icon = File;
  let kind = "";
  if (/^(png|jpe?g|gif|webp|avif|ico|bmp|svg)$/.test(ext)) [Icon, kind] = [FileImage, "image"];
  else if (/^(json|jsonc|json5|ya?ml|toml|lock)$/.test(ext)) [Icon, kind] = [FileJson, "data"];
  else if (/^(md|mdx|markdown|txt|rst)$/.test(ext)) [Icon, kind] = [FileText, "text"];
  else if (/^(sh|bash|zsh|fish)$/.test(ext) || lower === "justfile" || lower === "makefile" || lower === "dockerfile") [Icon, kind] = [FileTerminal, "shell"];
  else if (/^(ts|tsx|js|jsx|mjs|cjs|mts|py|rs|go|swift|c|h|cc|cpp|hpp|m|mm|java|kt|rb|lua|cs|scala|php|css|scss|less|html?|vue|svelte|sql)$/.test(ext)) [Icon, kind] = [FileCode, ext];
  return <Icon size={size} className="ft-icon" data-kind={kind || undefined} />;
}

const STATUS_LABEL: Record<string, string> = { M: "Changed", A: "Added", "?": "New", D: "Deleted", R: "Renamed", U: "Conflict" };

type Listing = { entries: TreeEntry[]; error?: undefined } | { entries?: undefined; error: string };

// Which folders were open, per folder this browser has browsed: back to the same tree on returning.
const openDirs = new Map<string, Set<string>>();

/** A whole index, as the folders of a tree (the fallback for a device too old to list one folder at a time). */
function treeFrom(entries: WorkspaceEntry[]): Record<string, TreeEntry[]> {
  const byDir = new Map<string, TreeEntry[]>();
  for (const entry of entries) {
    const at = entry.path.lastIndexOf("/");
    const dir = at < 0 ? "" : entry.path.slice(0, at);
    const name = at < 0 ? entry.path : entry.path.slice(at + 1);
    const list = byDir.get(dir);
    if (list) list.push({ name, dir: entry.dir });
    else byDir.set(dir, [{ name, dir: entry.dir }]);
  }
  for (const list of byDir.values()) list.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  return Object.fromEntries(byDir);
}

/**
 * Every listed folder of the tree, refreshed while it's showing, so new and changed files appear.
 * A paired device on an older OpenBuild can't list a folder at a time: its whole index is used
 * instead (without the ignored and changed marks, which come from the per-folder listing).
 */
function useListings(folder: TerminalFolder, expanded: Set<string>, visible: boolean) {
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [fallback, setFallback] = useState(false);
  const key = folderKey(folder);
  useEffect(() => {
    setListings({});
    setFallback(false);
  }, [key]);
  // From the whole index: every folder at once, as far as it was indexed.
  const loadIndex = useCallback(
    (refresh = false) =>
      loadEntries(folder.cwd, refresh, folder.deviceId).then(
        (entries) => setListings(Object.fromEntries(Object.entries(treeFrom(entries)).map(([dir, list]) => [dir, { entries: list }]))),
        (err: Error) => setListings({ "": { error: err.message } }),
      ),
    [key],
  );
  const load = useCallback(
    (dir: string, refresh = false) =>
      fallback
        ? loadIndex(refresh)
        : listDir(folder, dir).then(
            (entries) => setListings((l) => ({ ...l, [dir]: { entries } })),
            (err: FileError) => {
              if (err.code !== "stale") return setListings((l) => ({ ...l, [dir]: { error: err.message } }));
              setFallback(true);
              return loadIndex();
            },
          ),
    [fallback, key, loadIndex],
  );
  const dirs = useMemo(() => ["", ...expanded], [expanded]);
  // A folder opened for the first time loads straight away.
  useEffect(() => {
    if (!visible) return;
    for (const dir of dirs) if (!listings[dir]) void load(dir);
  }, [dirs, visible, load]);
  useEffect(() => {
    if (!visible) return;
    const refresh = () => document.visibilityState === "visible" && dirs.forEach((d) => void load(d, true));
    const timer = setInterval(refresh, 6000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [dirs, visible, load]);
  return { listings, reload: () => dirs.forEach((d) => void load(d, true)) };
}

function TreeRows({ dir, depth, listings, expanded, toggle, hide, active, open }: {
  dir: string;
  depth: number;
  listings: Record<string, Listing>;
  expanded: Set<string>;
  toggle: (dir: string) => void;
  hide: boolean;
  active?: string;
  open: (path: string) => void;
}) {
  const listing = listings[dir];
  if (!listing) return depth ? <div className="ft-note" style={{ paddingLeft: 12 + depth * 14 }}>Loading…</div> : null;
  if (listing.error !== undefined) return <div className="ft-note ft-error" style={{ paddingLeft: 12 + depth * 14 }}>{listing.error}</div>;
  const shown = hide ? listing.entries.filter((e) => !e.ignored && !e.name.startsWith(".")) : listing.entries;
  if (!shown.length && depth) return <div className="ft-note" style={{ paddingLeft: 12 + depth * 14 }}>Empty</div>;
  return (
    <>
      {shown.map((e) => {
        const path = dir ? `${dir}/${e.name}` : e.name;
        const isOpen = e.dir && expanded.has(path);
        return (
          <div key={path} role="none">
            <button
              type="button"
              role="treeitem"
              aria-expanded={e.dir ? isOpen : undefined}
              aria-selected={!e.dir && path === active}
              className={cx("ft-row", e.ignored && "ft-ignored", e.git && `ft-git-${e.git === "?" ? "new" : e.git}`, !e.dir && path === active && "ft-active")}
              style={{ paddingLeft: 8 + depth * 14 }}
              title={e.git ? `${path} · ${STATUS_LABEL[e.git] ?? "Changed"}` : path}
              onClick={() => (e.dir ? toggle(path) : open(path))}
            >
              <span className="ft-chevron">{e.dir && <ChevronRight size={13} className={cx(isOpen && "ft-chevron-open")} />}</span>
              {e.dir ? isOpen ? <FolderOpen size={15} className="ft-icon" /> : <Folder size={15} className="ft-icon" /> : <FileIcon name={e.name} />}
              <span className="ft-name">{e.name}</span>
              {e.git && !e.dir && <span className="ft-status">{e.git === "?" ? "U" : e.git}</span>}
              {e.git && e.dir && <span className="ft-dot" aria-hidden />}
            </button>
            {isOpen && <TreeRows dir={path} depth={depth + 1} listings={listings} expanded={expanded} toggle={toggle} hide={hide} active={active} open={open} />}
          </div>
        );
      })}
    </>
  );
}

function SearchResults({ folder, query, open, reveal }: { folder: TerminalFolder; query: string; open: (path: string) => void; reveal: (dir: string) => void }) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    loadEntries(folder.cwd, false, folder.deviceId).then(
      (e) => live && setEntries(e),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [folderKey(folder)]);
  const results = useMemo(() => (entries ? matchEntries(entries, query, 200) : []), [entries, query]);
  if (error) return <p className="ft-note ft-error">{error}</p>;
  if (!entries) return <p className="ft-note">Searching…</p>;
  if (!results.length) return <p className="ft-note">No file matches “{query.trim()}”.</p>;
  return (
    <>
      {results.map((e) => {
        const slash = e.path.lastIndexOf("/");
        const name = e.path.slice(slash + 1);
        return (
          <button key={e.path} type="button" className="ft-row ft-result" title={e.path} onClick={() => (e.dir ? reveal(e.path) : open(e.path))}>
            {e.dir ? <Folder size={15} className="ft-icon" /> : <FileIcon name={name} />}
            <span className="ft-name">{name}</span>
            {slash > 0 && <span className="ft-where">{e.path.slice(0, slash)}</span>}
          </button>
        );
      })}
    </>
  );
}

/** Drag a panel's left edge to make it wider or narrower (the pointer is captured, so fast drags hold). */
export function useEdgeDrag(width: number, setWidth: (w: number) => void, className: string) {
  return (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = width;
    const move = (ev: PointerEvent) => setWidth(start + (startX - ev.clientX));
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      document.body.classList.remove(className);
    };
    document.body.classList.add(className);
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };
}

export function FileTree({ folder }: { folder: TerminalFolder }) {
  const open = usePanel((s) => s.tree);
  const width = usePanel((s) => s.treeWidth);
  const setWidth = usePanel((s) => s.setTreeWidth);
  const hide = usePanel((s) => s.hideIgnored);
  const setHide = usePanel((s) => s.setHideIgnored);
  const openFile = usePanel((s) => s.openFile);
  const active = usePanel((s) => (s.view === "file" ? s.activeFile : undefined));
  const key = folderKey(folder);
  const [expanded, setExpanded] = useState<Set<string>>(() => openDirs.get(key) ?? new Set());
  useEffect(() => setExpanded(openDirs.get(key) ?? new Set()), [key]);
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [key]);
  const { listings, reload } = useListings(folder, expanded, open);
  const search = useRef<HTMLInputElement>(null);
  const drag = useEdgeDrag(width, setWidth, "panel-dragging");

  const update = (next: Set<string>) => {
    openDirs.set(key, next);
    setExpanded(next);
  };
  const toggle = (dir: string) => {
    const next = new Set(expanded);
    // Closing a folder closes the folders inside it too.
    if (next.has(dir)) {
      for (const d of next) if (d === dir || d.startsWith(`${dir}/`)) next.delete(d);
    } else next.add(dir);
    update(next);
  };
  // A folder picked from the search: open it and every folder on the way there.
  const reveal = (dir: string) => {
    const next = new Set(expanded);
    const parts = dir.split("/");
    for (let i = 1; i <= parts.length; i++) next.add(parts.slice(0, i).join("/"));
    update(next);
    setQuery("");
  };

  return (
    <aside className={cx("file-tree", open && "file-tree-open")} style={{ width: open ? width : 0 }} aria-label="Files" inert={!open}>
      <div className="side-grip" onPointerDown={drag} onDoubleClick={() => setWidth(260)} role="separator" aria-orientation="vertical" aria-label="Resize the file tree" />
      <div className="file-tree-inner">
        <div className="side-head" />
        <div className="ft-tools">
          <label className="ft-search">
            <Search size={14} />
            <input
              ref={search}
              value={query}
              placeholder="Search files"
              aria-label="Search files"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
            />
            {query && (
              <button type="button" className="ft-clear" aria-label="Clear the search" onClick={() => setQuery("")}>
                <X size={13} />
              </button>
            )}
          </label>
          <IconButton label={hide ? "Show hidden and ignored files" : "Hide hidden and ignored files"} className={cx("ft-tool", !hide && "ft-tool-on")} onClick={() => setHide(!hide)}>
            {hide ? <EyeOff size={15} /> : <Eye size={15} />}
          </IconButton>
          <IconButton label="Refresh" className="ft-tool" onClick={reload}>
            <RefreshCw size={14} />
          </IconButton>
        </div>
        <div className="ft-list" role="tree" aria-label={folder.label}>
          {query.trim() ? (
            <SearchResults folder={folder} query={query} open={openFile} reveal={reveal} />
          ) : (
            <TreeRows dir="" depth={0} listings={listings} expanded={expanded} toggle={toggle} hide={hide} active={active} open={openFile} />
          )}
        </div>
      </div>
    </aside>
  );
}
