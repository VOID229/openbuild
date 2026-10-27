// The terminal as a drawer at the bottom of the thread (the default; Settings → General → Terminal
// puts it beside the thread in the side panel instead): one tab per shell, each a real one on the
// device that holds the project, in the folder the thread works in (src/lib/terminal.ts,
// server/terminals.ts). Cmd/Ctrl+J opens and closes it. The screen itself is TerminalView.tsx, which
// the side panel uses too.
import { Plus, RotateCcw, SquareTerminal, X } from "lucide-react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { deviceName } from "../lib/devices";
import { machineName } from "../lib/runtime";
import { useStore } from "../lib/store";
import { defaultHeight, newTerminalTab, refreshTerminal, restartTerminalTab, useTerminal } from "../lib/terminal";
import { cx } from "../lib/ui";
import { IconButton } from "./primitives";
import { tabLabel, TerminalView, useTabKeys } from "./TerminalView";

/**
 * Drag the top edge to make the drawer taller or shorter, double-click it for the default height.
 * The pointer is captured, so the drag holds however fast it moves, and the drawer's own height
 * transition is off for the length of it, so the edge stays under the pointer instead of trailing it.
 */
function useDrag(setHeight: (height: number) => void) {
  return (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setHeight(window.innerHeight - ev.clientY - 8);
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      document.body.classList.remove("terminal-dragging");
    };
    document.body.classList.add("terminal-dragging");
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };
}

export function TerminalPanel() {
  const open = useTerminal((s) => s.open);
  const folder = useTerminal((s) => s.folder);
  const tabs = useTerminal((s) => s.tabs);
  const active = useTerminal((s) => s.active);
  const height = useTerminal((s) => s.height);
  const setHeight = useTerminal((s) => s.setHeight);
  const hide = useTerminal((s) => s.hide);
  const activateTab = useTerminal((s) => s.activateTab);
  const closeTab = useTerminal((s) => s.closeTab);
  const activeChatId = useStore((s) => s.activeChatId);
  const xterm = useRef<XTerm | undefined>(undefined);
  const drag = useDrag(setHeight);
  // Closing only slides the drawer away: the shells, their screens and what's typed in them stay
  // mounted, so ⌘J and back is exactly where you left off (the shells keep running either way).
  const [ready, setReady] = useState(false);
  // The drawer is in the page before it first opens: one frame to be there closed, the next to open,
  // so the first ⌘J slides like every other one instead of appearing at full height.
  useEffect(() => {
    if (!folder || ready) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => (inner = requestAnimationFrame(() => setReady(true))));
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [folder, ready]);
  // Following the open thread: each folder has its own shells behind the same drawer.
  useEffect(() => refreshTerminal(), [activeChatId, open]);
  // Back to the terminal you were in, so typing works straight away.
  useEffect(() => {
    if (open) xterm.current?.focus();
  }, [open]);
  useTabKeys(open);
  if (!folder) return null;
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];
  const where = folder.deviceId ? (deviceName(folder.deviceId) ?? "paired device") : (machineName() ?? "this device");
  return (
    <div className={cx("terminal-drawer", ready && open && "terminal-drawer-open")} style={{ height: ready && open ? height + 8 : 0 }} inert={!open}>
      <section className="terminal-panel" style={{ height }} aria-label="Terminal" aria-hidden={!open}>
        <div className="terminal-grip" onPointerDown={drag} onDoubleClick={() => setHeight(defaultHeight())} role="separator" aria-orientation="horizontal" aria-label="Resize the terminal" />
        <header className="terminal-bar">
          <div className="terminal-tabs" role="tablist" aria-label="Terminals">
            {tabs.map((t) => (
              <div key={t.id} className={cx("terminal-tab", t.id === tab?.id && "terminal-tab-active")} role="presentation">
                <button type="button" role="tab" aria-selected={t.id === tab?.id} className="terminal-tab-name" title={t.title ?? folder.label} onClick={() => activateTab(t.id)}>
                  {tabLabel(t, folder)}
                </button>
                <button type="button" className="terminal-tab-close" aria-label={`Close ${tabLabel(t, folder)}`} data-tooltip="Close (⌥W)" data-tooltip-side="bottom" onClick={() => closeTab(t.id)}>
                  <X size={11.5} />
                </button>
              </div>
            ))}
            <IconButton label="New terminal tab" tooltip="New tab (⌥T)" tooltipSide="bottom" className="terminal-action terminal-new" onClick={newTerminalTab}>
              <Plus size={15} />
            </IconButton>
          </div>
          <span className="terminal-where" title={folder.cwd}>
            <SquareTerminal size={12.5} className="terminal-where-icon" />
            {where}
            {folder.cwd ? ` · ${folder.cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~")}` : ""}
          </span>
          <IconButton label="Restart the shell" tooltip="New shell in this tab" tooltipSide="bottom" className="terminal-action" onClick={() => restartTerminalTab()} disabled={!tab}>
            <RotateCcw size={13.5} />
          </IconButton>
          <IconButton label="Hide the terminal" tooltip="Hide (⌘J), leaving the shells running" tooltipSide="bottom" className="terminal-action" onClick={hide}>
            <X size={14.5} />
          </IconButton>
        </header>
        {tab && <TerminalView key={tab.id} tab={tab} folder={folder} xterm={xterm} />}
      </section>
    </div>
  );
}
