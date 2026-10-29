// A terminal tab's screen, shared by the bottom drawer (TerminalPanel.tsx) and the side panel
// (SidePanel.tsx): one tab per shell, each running on the device that holds the project, in the
// folder the thread works in (src/lib/terminal.ts, server/terminals.ts), drawing what its PTY sends
// with xterm.js. Cmd/Ctrl+J shows and hides it.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { editingSequence } from "../../shared/terminal";
import { newTerminalTab, restartTerminalTab, TerminalConnection, terminalStoreFor, type TerminalFolder, type TerminalPlace, type TerminalTab } from "../lib/terminal";

const FONT = '"JetBrains Mono Variable", "JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace';
/** Long enough to tell two shells in the same folder apart, short enough for the tab strip. */
const TAB_TITLE = 28;

/** A shell with a folder in its title is that folder; a title like "vim foo.txt" is worth showing as is. */
export const tabLabel = (tab: TerminalTab, folder: TerminalFolder) => {
  const title = tab.title?.replace(/^.*?:\s*/, "").trim();
  return (title || folder.label).slice(0, TAB_TITLE);
};

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

export function TerminalView({ tab, folder, xterm, place = "bottom" }: { tab: TerminalTab; folder: TerminalFolder; xterm: RefObject<XTerm | undefined>; place?: TerminalPlace }) {
  const store = terminalStoreFor(place);
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
        // Not laid out yet (a hidden panel); the observer below tries again.
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
          if (!e.error) store.getState().closeTab(tab.id);
          else term.write(`\r\n\x1b[38;5;244m[${e.error}]\x1b[0m\r\n`);
        }
      },
      onRetrying: setRetrying,
    });
    term.onData((data) => connection.input(data));
    term.onResize(({ cols, rows }) => connection.resize({ cols, rows }));
    term.onTitleChange((title) => store.getState().setTabTitle(tab.id, title));
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
          <button type="button" className="btn btn-sm" onClick={() => restartTerminalTab(place)}>
            Start a new shell
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Option+T opens a tab and Option+W closes it, from the terminal's own input only — so the browser's
 * tabs stay its business when the composer or a menu has focus. It's Option rather than ⌘T/⌘W
 * because browsers keep those two for themselves however a page asks; ⌥T and ⌥W are the terminal's,
 * here as in other terminal apps that live in a page. Option+1–8 goes to that tab and Option+9 to the
 * last one, the way browsers number theirs.
 */
export function useTabKeys(open: boolean, place: TerminalPlace = "bottom") {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
      // With Option held a Mac reports "†"/"∑" as the key; the code is the letter itself.
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (e.code !== "KeyT" && e.code !== "KeyW" && !digit) return;
      const el = document.activeElement;
      if (!el?.closest?.(place === "side" ? ".side-panel .xterm" : ".terminal-panel .xterm")) return;
      e.preventDefault();
      e.stopPropagation();
      if (digit) {
        const { tabs, activateTab } = terminalStoreFor(place).getState();
        const tab = digit === "9" ? tabs.at(-1) : tabs[Number(digit) - 1];
        if (tab) activateTab(tab.id);
      } else if (e.code === "KeyT") newTerminalTab(place);
      else {
        const { active, closeTab } = terminalStoreFor(place).getState();
        if (active) closeTab(active);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, place]);
}
