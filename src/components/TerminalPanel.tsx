// The terminal, as a drawer at the bottom of the thread: one tab per shell, each running on the
// device that holds the project, in the folder the thread works in (src/lib/terminal.ts,
// server/terminals.ts). Cmd/Ctrl+J opens and closes the drawer, drawing what each shell's PTY sends
// with xterm.js.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, RotateCcw, SquareTerminal, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { editingSequence } from "../../shared/terminal";
import { deviceName } from "../lib/devices";
import { machineName } from "../lib/runtime";
import { useStore } from "../lib/store";
import { newTerminalTab, refreshTerminal, restartTerminalTab, TerminalConnection, useTerminal, type TerminalFolder, type TerminalTab } from "../lib/terminal";
import { cx } from "../lib/ui";
import { IconButton } from "./primitives";

const FONT = '"JetBrains Mono Variable", "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace';
/** Long enough to tell two shells in the same folder apart, short enough for the tab strip. */
const TAB_TITLE = 28;

/** The terminal's colours, read from the page so it matches the app's theme. */
function readTheme() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--terminal-bg", "#1a1a1a"),
    foreground: v("--text", "#ececea"),
    cursor: v("--text", "#ececea"),
    cursorAccent: v("--terminal-bg", "#1a1a1a"),
    selectionBackground: v("--active", "rgba(255, 255, 255, 0.16)"),
  };
}

/** Keep the terminal's colours in step with the app's: the theme switches by changing data-theme. */
function useFollowTheme(term: { current: XTerm | undefined }) {
  useEffect(() => {
    const observer = new MutationObserver(() => term.current && (term.current.options.theme = readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [term]);
}

const isMac = () => /mac/i.test(navigator.platform || navigator.userAgent);

function TerminalView({ tab, folder, xterm }: { tab: TerminalTab; folder: TerminalFolder; xterm: RefObject<XTerm | undefined> }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  useFollowTheme(xterm);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new XTerm({
      fontFamily: FONT,
      fontSize: 12.5,
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: readTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    xterm.current = term;
    // What the shell prints has to match what the browser shows, so it wraps where it looks like.
    const refit = () => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet (a hidden drawer); the observer below tries again.
      }
    };
    refit();
    requestAnimationFrame(refit);

    const connection = new TerminalConnection({ id: tab.id, deviceId: folder.deviceId, cwd: folder.cwd }, {
      onEvent: (e) => {
        if (e.t === "snap") {
          // A screen from scratch: what the shell printed while nobody was looking.
          term.reset();
          term.write(e.output);
        } else if (e.t === "out") {
          term.write(e.v);
        } else if (e.t === "exit") {
          // `exit`, or anything that ends the shell, closes its tab. A shell that couldn't start
          // (there's no such program) keeps its tab, so the reason stays on screen.
          if (!e.error) useTerminal.getState().closeTab(tab.id);
          else term.write(`\r\n\x1b[38;5;244m[${e.error}]\x1b[0m\r\n`);
        }
      },
      onRetrying: setRetrying,
    });
    term.onData((data) => connection.input(data));
    term.onResize(({ cols, rows }) => connection.resize({ cols, rows }));
    term.onTitleChange((title) => useTerminal.getState().setTabTitle(tab.id, title));
    // ⌥←/→, ⌘←/→, ⌥⌫, ⌘⌫ and friends do what they do in a terminal window (shared/terminal.ts).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const sequence = editingSequence(isMac(), e);
      if (!sequence) return true;
      connection.input(sequence);
      return false;
    });
    void connection.run({ cols: term.cols, rows: term.rows }).catch((err: Error) => setError(err.message));
    term.focus();

    const observer = new ResizeObserver(refit);
    observer.observe(el);
    return () => {
      observer.disconnect();
      connection.stop();
      term.dispose();
      xterm.current = undefined;
    };
  }, [tab.id, folder.deviceId, folder.cwd]);

  return (
    <div className="terminal-body">
      <div ref={host} className="terminal-screen" />
      {retrying && <p className="terminal-note">Can't reach {folder.deviceId ? "that device" : "the server"} right now. Retrying…</p>}
      {error && (
        <div className="terminal-problem" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn-sm" onClick={() => restartTerminalTab()}>
            Start a new shell
          </button>
        </div>
      )}
    </div>
  );
}

/** Drag the top edge to make the drawer taller or shorter. */
function useDrag(setHeight: (height: number) => void) {
  return (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => setHeight(window.innerHeight - ev.clientY - 8);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("terminal-dragging");
    };
    document.body.classList.add("terminal-dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
}

/** A shell with a folder in its title is that folder; a title like "vim foo.txt" is worth showing as is. */
const tabLabel = (tab: TerminalTab, folder: TerminalFolder) => {
  const title = tab.title?.replace(/^.*?:\s*/, "").trim();
  return (title || folder.label).slice(0, TAB_TITLE);
};

/**
 * Option+T opens a tab and Option+W closes it, from the terminal's own input only — so the browser's
 * tabs stay its business when the composer or a menu has focus. It's Option rather than ⌘T/⌘W
 * because browsers keep those two for themselves however a page asks; ⌥T and ⌥W are the terminal's,
 * here as in other terminal apps that live in a page.
 */
function useTabKeys(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      // With Option held a Mac reports "†"/"∑" as the key; the code is the letter itself.
      if (e.code !== "KeyT" && e.code !== "KeyW") return;
      const el = document.activeElement;
      if (!el?.closest?.(".terminal-panel .xterm")) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "KeyT") newTerminalTab();
      else {
        const { active, closeTab } = useTerminal.getState();
        if (active) closeTab(active);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
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
        <div className="terminal-grip" onPointerDown={drag} role="separator" aria-orientation="horizontal" aria-label="Resize the terminal" />
        <header className="terminal-bar">
          <div className="terminal-tabs" role="tablist" aria-label="Terminals">
            {tabs.map((t) => (
              <div key={t.id} className={cx("terminal-tab", t.id === tab?.id && "terminal-tab-active")} role="presentation">
                <button
                  type="button"
                  role="tab"
                  aria-selected={t.id === tab?.id}
                  className="terminal-tab-name"
                  title={t.title ?? folder.label}
                  onClick={() => activateTab(t.id)}
                >
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
