// The panel beside the thread: open files and terminals as tabs, side by side with the conversation.
// It follows the open thread's folder on the device the thread runs on (lib/panel.ts for files,
// lib/terminal.ts for shells). With nothing open it offers what it can open.
import { Plus, RotateCcw, SquareTerminal, X } from "lucide-react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { deviceName } from "../lib/devices";
import { usePanel } from "../lib/panel";
import { useStore } from "../lib/store";
import { machineName } from "../lib/runtime";
import { newTerminalTab, restartTerminalTab, showTerminal, useTerminal, type TerminalFolder } from "../lib/terminal";
import { cx } from "../lib/ui";
import { dropBuffer, FileView } from "./FileView";
import { FileIcon, useEdgeDrag } from "./FileTree";
import { IconButton, Popover } from "./primitives";
import { tabLabel, TerminalView, useTabKeys } from "./TerminalView";

function NewTabMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton ref={anchor} label="Open a new tab" tooltip="New tab" className="side-action side-new" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Plus size={15} />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} className="menu side-menu" role="menu" label="New tab" fixed="down">
        <button
          type="button"
          role="menuitem"
          className="menu-item"
          onClick={() => {
            setOpen(false);
            newTerminalTab();
          }}
        >
          <SquareTerminal size={15} />
          <span className="menu-item-label">Terminal</span>
          <span className="menu-hint">⌥T</span>
        </button>
      </Popover>
    </>
  );
}

/** With no tabs: what the panel can open. */
function Launcher({ files, terminal }: { files: boolean; terminal: boolean }) {
  return (
    <div className="side-launcher">
      {terminal && (
        <button type="button" className="side-launch" onClick={() => showTerminal()}>
          <SquareTerminal size={16} />
          Terminal
          <span className="side-launch-key">⌘J</span>
        </button>
      )}
      {files && <p className="side-launch-hint">Open files from the file tree.</p>}
    </div>
  );
}

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
  const { openFile, closeFile, setView } = usePanel.getState();
  // The terminal is in the drawer at the bottom unless Settings → General → Terminal says beside it.
  const sideTerminal = useStore((s) => (s.settings.terminal ?? "bottom") === "side");
  const tabs = useTerminal((s) => s.tabs);
  const activeShell = useTerminal((s) => s.active);
  const termFolder = useTerminal((s) => s.folder);
  const { activateTab, closeTab } = useTerminal.getState();
  const xterm = useRef<XTerm | undefined>(undefined);
  const drag = useEdgeDrag(width, setWidth, "panel-dragging");
  const showing = sideTerminal && view === "terminal" && tabs.length ? "terminal" : view === "file" && activeFile ? "file" : "launcher";
  // Back to the terminal you were in, so typing works straight away.
  useEffect(() => {
    if (open && showing === "terminal") xterm.current?.focus();
  }, [open, showing]);
  useTabKeys(sideTerminal && open && showing === "terminal");
  const shell = tabs.find((t) => t.id === activeShell) ?? tabs[0];
  const where = folder.deviceId ? (deviceName(folder.deviceId) ?? "paired device") : (machineName() ?? "this device");
  // The tabs leave room for the toolbar above them when nothing (the file tree) sits under it instead.
  const reserve = Math.max(0, toolsWidth - (tree && folder.cwd ? treeWidth : 0));
  const close = (path: string) => {
    if (dirty[path] && !confirm(`${path.split("/").pop()} has unsaved edits. Close it anyway?`)) return;
    dropBuffer(folder, path);
    closeFile(path);
  };

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
          <div className="side-tabs" role="tablist" aria-label="Open files and terminals">
            {files.map((path) => {
              const name = path.split("/").pop()!;
              const active = showing === "file" && path === activeFile;
              return (
                <div key={`f:${path}`} className={cx("side-tab", active && "side-tab-active")} role="presentation">
                  <button type="button" role="tab" aria-selected={active} className="side-tab-name" title={path} onClick={() => openFile(path)}>
                    <FileIcon name={name} size={13} />
                    {name}
                  </button>
                  <button type="button" className={cx("side-tab-close", dirty[path] && "side-tab-dirty")} aria-label={`Close ${name}`} data-tooltip={dirty[path] ? "Unsaved · Close" : "Close"} data-tooltip-side="bottom" onClick={() => close(path)}>
                    <X size={11.5} />
                  </button>
                </div>
              );
            })}
            {sideTerminal &&
              termFolder &&
              tabs.map((t) => {
                const active = showing === "terminal" && t.id === shell?.id;
                return (
                  <div key={`t:${t.id}`} className={cx("side-tab", active && "side-tab-active")} role="presentation">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className="side-tab-name"
                      title={t.title ?? termFolder.label}
                      onClick={() => {
                        activateTab(t.id);
                        setView("terminal");
                      }}
                    >
                      <SquareTerminal size={13} className="ft-icon" />
                      {tabLabel(t, termFolder)}
                    </button>
                    <button type="button" className="side-tab-close" aria-label={`Close ${tabLabel(t, termFolder)}`} data-tooltip="Close (⌥W)" data-tooltip-side="bottom" onClick={() => closeTab(t.id)}>
                      <X size={11.5} />
                    </button>
                  </div>
                );
              })}
            {sideTerminal && <NewTabMenu />}
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
                <IconButton label="Restart the shell" tooltip="New shell in this tab" className="side-action" onClick={() => restartTerminalTab()}>
                  <RotateCcw size={13} />
                </IconButton>
              </div>
              <TerminalView key={shell.id} tab={shell} folder={termFolder} xterm={xterm} />
            </div>
          )}
          {showing === "launcher" && <Launcher files={!!folder.cwd} terminal={sideTerminal} />}
        </div>
      </div>
    </aside>
  );
}
