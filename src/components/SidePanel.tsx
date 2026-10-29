// The panel beside the thread: open files, terminals, the diff and browser pages as tabs, side by side
// with the conversation. It follows the open thread's folder on the device the thread runs on
// (lib/panel.ts for files, diff and browser tabs, lib/terminal.ts for shells). With nothing open it
// offers what it can open: a browser, a terminal or the diff.
//
// Its terminals are its own (useSideTerminal), not the drawer's under the thread: ⌘J still opens and
// hides the drawer, and both can be open at once.
import { FileDiff, Globe, Plus, RotateCcw, SquareTerminal, X } from "lucide-react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { deviceName } from "../lib/devices";
import { usePanel, type PanelView } from "../lib/panel";
import { machineName } from "../lib/runtime";
import { restartTerminalTab, showSideTerminal, useSideTerminal, type TerminalFolder } from "../lib/terminal";
import { cx } from "../lib/ui";
import { BrowserView, dropBrowserHistory } from "./BrowserView";
import { DiffView } from "./DiffView";
import { dropBuffer, FileView } from "./FileView";
import { FileIcon, useEdgeDrag } from "./FileTree";
import { IconButton, Popover } from "./primitives";
import { tabLabel, TerminalView, useTabKeys } from "./TerminalView";

interface Surface {
  id: "browser" | "terminal" | "diff";
  label: string;
  icon: ReactNode;
  /** The key that opens it from the launcher. */
  key: string;
  open(): void;
  /** Not in a folder that can have it (the diff needs a project folder). */
  disabled?: boolean;
}

function useSurfaces(folder: TerminalFolder): Surface[] {
  const { openBrowser, openDiff } = usePanel.getState();
  return [
    { id: "browser", label: "Browser", icon: <Globe size={16} />, key: "B", open: () => openBrowser() },
    // A new shell each time: the launcher and the + menu both mean "another one".
    { id: "terminal", label: "Terminal", icon: <SquareTerminal size={16} />, key: "T", open: () => (useSideTerminal.getState().tabs.length ? useSideTerminal.getState().addTab() : showSideTerminal()) },
    { id: "diff", label: "Diff", icon: <FileDiff size={16} />, key: "D", open: openDiff, disabled: !folder.cwd },
  ];
}

function NewTabMenu({ surfaces }: { surfaces: Surface[] }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton ref={anchor} label="Open a new tab" tooltip="New tab" className="side-action side-new" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Plus size={15} />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu side-menu" role="menu" label="New tab" fixed="down">
        {surfaces.map((s) => (
          <button
            key={s.id}
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={s.disabled}
            onClick={() => {
              setOpen(false);
              s.open();
            }}
          >
            {s.icon}
            <span className="menu-item-label">{s.label}</span>
          </button>
        ))}
      </Popover>
    </>
  );
}

/** With no tabs: what the panel can open, each with a key. */
function Launcher({ surfaces, active, files }: { surfaces: Surface[]; active: boolean; files: boolean }) {
  // ⌥B, ⌥T or ⌥D opens it while the launcher is showing, even from the composer; the bare letter
  // works too when nothing that takes typing has focus. A terminal keeps its own ⌥ keys (⌥T is its
  // new tab), so nothing here fires from one.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.repeat || e.isComposing) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.closest(".xterm")) return;
      const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
      if (!e.altKey && typing) return;
      // With Option held a Mac reports "∫"/"†"/"∂" as the key; the code is the letter itself.
      const s = surfaces.find((x) => !x.disabled && e.code === `Key${x.key}`);
      if (!s) return;
      e.preventDefault();
      e.stopPropagation();
      s.open();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, surfaces]);
  return (
    <div className="side-launcher">
      <h2 className="side-launch-title">Open a surface</h2>
      <div className="side-launch-list" role="menu" aria-label="Open a surface">
        {surfaces.map((s) => (
          <button key={s.id} type="button" role="menuitem" className="side-launch" disabled={s.disabled} onClick={s.open}>
            {s.icon}
            {s.label}
            <kbd className="side-launch-key">⌥{s.key}</kbd>
          </button>
        ))}
      </div>
      {files && <p className="side-launch-hint">Open files from the file tree.</p>}
    </div>
  );
}

function Tab({ active, title, icon, label, onSelect, onClose, closeLabel, closeTip, dirty }: {
  active: boolean;
  title?: string;
  icon: ReactNode;
  label: string;
  onSelect(): void;
  onClose(): void;
  closeLabel?: string;
  closeTip?: string;
  dirty?: boolean;
}) {
  return (
    <div className={cx("side-tab", active && "side-tab-active")} role="presentation">
      <button type="button" role="tab" aria-selected={active} className="side-tab-name" title={title ?? label} onClick={onSelect}>
        {icon}
        {label}
      </button>
      <button type="button" className={cx("side-tab-close", dirty && "side-tab-dirty")} aria-label={closeLabel ?? `Close ${label}`} data-tooltip={closeTip ?? "Close"} data-tooltip-side="bottom" onClick={onClose}>
        <X size={11.5} />
      </button>
    </div>
  );
}

const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url;
  }
};

export function SidePanel({ folder, toolsWidth }: { folder: TerminalFolder; toolsWidth: number }) {
  const open = usePanel((s) => s.panel);
  const view = usePanel((s) => s.view);
  const width = usePanel((s) => s.width);
  const setWidth = usePanel((s) => s.setWidth);
  const expanded = usePanel((s) => s.expanded);
  const tree = usePanel((s) => s.tree);
  const treeWidth = usePanel((s) => s.treeWidth);
  const files = usePanel((s) => s.files);
  const activeFile = usePanel((s) => s.activeFile);
  const dirty = usePanel((s) => s.dirty);
  const diff = usePanel((s) => s.diff);
  const browsers = usePanel((s) => s.browsers);
  const activeBrowser = usePanel((s) => s.activeBrowser);
  const { openFile, closeFile, setView, closeDiff, closeBrowser, activateBrowser } = usePanel.getState();
  const tabs = useSideTerminal((s) => s.tabs);
  const activeShell = useSideTerminal((s) => s.active);
  const termFolder = useSideTerminal((s) => s.folder);
  const { activateTab, closeTab } = useSideTerminal.getState();
  const xterm = useRef<XTerm | undefined>(undefined);
  const drag = useEdgeDrag(width, setWidth, "panel-dragging");
  const surfaces = useSurfaces(folder);

  const browser = browsers.find((b) => b.id === activeBrowser) ?? browsers[0];
  const shell = tabs.find((t) => t.id === activeShell) ?? tabs[0];
  // What there is to show for each view; a view with nothing left falls to the next that has something.
  const has: Record<Exclude<PanelView, "launcher">, boolean> = {
    file: !!activeFile,
    terminal: !!shell && !!termFolder,
    diff,
    browser: !!browser,
  };
  const showing: PanelView = view !== "launcher" && has[view] ? view : ((["file", "terminal", "diff", "browser"] as const).find((v) => has[v]) ?? "launcher");

  // Back to the terminal you were in, so typing works straight away.
  useEffect(() => {
    if (open && showing === "terminal") xterm.current?.focus();
  }, [open, showing, shell?.id]);
  useTabKeys(open && showing === "terminal", "side");
  const where = folder.deviceId ? (deviceName(folder.deviceId) ?? "paired device") : (machineName() ?? "this device");
  // The tabs leave room for the toolbar above them when nothing (the file tree) sits under it instead.
  const reserve = Math.max(0, toolsWidth - (tree && folder.cwd ? treeWidth : 0));
  const close = (path: string) => {
    if (dirty[path] && !confirm(`${path.split("/").pop()} has unsaved edits. Close it anyway?`)) return;
    dropBuffer(folder, path);
    closeFile(path);
  };
  const anyTabs = files.length > 0 || tabs.length > 0 || diff || browsers.length > 0;

  return (
    <aside
      className={cx("side-panel", open && "side-panel-open", expanded && "side-panel-expanded")}
      style={{ width: open ? (expanded ? undefined : width) : 0 }}
      aria-label="Side panel"
      inert={!open}
    >
      {!expanded && <div className="side-grip" onPointerDown={drag} onDoubleClick={() => setWidth(560)} role="separator" aria-orientation="vertical" aria-label="Resize the panel" />}
      <div className="side-inner">
        <header className="side-head side-bar" style={{ paddingRight: reserve ? reserve + 8 : undefined }}>
          <div className="side-tabs" role="tablist" aria-label="Side panel tabs">
            {files.map((path) => {
              const name = path.split("/").pop()!;
              return (
                <Tab
                  key={`f:${path}`}
                  active={showing === "file" && path === activeFile}
                  title={path}
                  icon={<FileIcon name={name} size={13} />}
                  label={name}
                  onSelect={() => openFile(path)}
                  onClose={() => close(path)}
                  dirty={dirty[path]}
                  closeTip={dirty[path] ? "Unsaved · Close" : "Close"}
                />
              );
            })}
            {termFolder &&
              tabs.map((t) => (
                <Tab
                  key={`t:${t.id}`}
                  active={showing === "terminal" && t.id === shell?.id}
                  title={t.title ?? termFolder.label}
                  icon={<SquareTerminal size={13} className="ft-icon" />}
                  label={tabLabel(t, termFolder)}
                  onSelect={() => {
                    activateTab(t.id);
                    setView("terminal");
                  }}
                  onClose={() => closeTab(t.id)}
                  closeTip="Close (⌥W)"
                />
              ))}
            {diff && <Tab active={showing === "diff"} icon={<FileDiff size={13} className="ft-icon" />} label="Diff" onSelect={() => setView("diff")} onClose={closeDiff} />}
            {browsers.map((b) => (
              <Tab
                key={`b:${b.id}`}
                active={showing === "browser" && b.id === browser?.id}
                title={b.url || "New tab"}
                icon={<Globe size={13} className="ft-icon" />}
                label={b.url ? hostOf(b.url) : "New tab"}
                onSelect={() => activateBrowser(b.id)}
                onClose={() => {
                  dropBrowserHistory(b.id);
                  closeBrowser(b.id);
                }}
              />
            ))}
            {anyTabs && <NewTabMenu surfaces={surfaces} />}
          </div>
        </header>
        <div className="side-body">
          {showing === "file" && activeFile && <FileView key={activeFile} folder={folder} path={activeFile} />}
          {showing === "terminal" && shell && termFolder && (
            <div className="side-terminal">
              <div className="terminal-sub">
                <span className="terminal-where" title={termFolder.cwd}>
                  {where}
                  {termFolder.cwd ? ` · ${termFolder.cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~")}` : ""}
                </span>
                <IconButton label="Restart the shell" tooltip="New shell in this tab" className="side-action" onClick={() => restartTerminalTab("side")}>
                  <RotateCcw size={13} />
                </IconButton>
              </div>
              <TerminalView key={shell.id} tab={shell} folder={termFolder} xterm={xterm} place="side" />
            </div>
          )}
          {showing === "diff" && <DiffView folder={folder} />}
          {showing === "browser" && browser && <BrowserView key={browser.id} tab={browser} folder={folder} />}
          {showing === "launcher" && <Launcher surfaces={surfaces} active={open} files={!!folder.cwd} />}
        </div>
      </div>
    </aside>
  );
}
