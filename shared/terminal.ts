// A terminal the user opens in a project: a real shell on a pseudo-terminal (PTY) on the machine that
// holds the project, shown in the browser. Server side: server/terminals.ts; browser side:
// src/lib/terminal.ts and src/components/TerminalPanel.tsx.
//
// The shell keeps running when the panel is closed, the page is reloaded, or the app is opened on
// another device: opening the same id again attaches to it. Whoever attaches late gets the output so
// far ("snap") before the new output ("out"), like a command's events (shared/types.ts ShellEvent).

/** NDJSON events for a terminal, from /api/terminals/:id. */
export type TerminalEvent =
  /** The output so far, to draw a screen from scratch. `running` is false once the shell has exited. */
  | { t: "snap"; output: string; running: boolean }
  | { t: "out"; v: string }
  | { t: "exit"; exitCode?: number; error?: string }
  | { t: "end" };

/** Output kept for whoever attaches late: a screenful and a scrollback, not a whole build log. */
export const TERMINAL_KEEP = 256 * 1024;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

/** A size the PTY can be given: what the browser measured, within what a terminal can sanely be. */
export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  return {
    cols: typeof cols === "number" && Number.isFinite(cols) ? clamp(cols, 20, 400) : 80,
    rows: typeof rows === "number" && Number.isFinite(rows) ? clamp(rows, 5, 300) : 24,
  };
}

/**
 * The tail of a terminal's output, at most `max` characters. Unlike a command's output this is raw
 * terminal data, so it starts on a whole line where it can (that's also what keeps it from starting
 * halfway through an escape sequence, since those don't contain newlines) and resets the colours, or
 * the screen would keep whatever the dropped part left on.
 */
export function terminalTail(output: string, max: number): string {
  if (output.length <= max) return output;
  let tail = output.slice(-max);
  const nl = tail.indexOf("\n");
  if (nl >= 0 && nl < 8 * 1024) tail = tail.slice(nl + 1);
  return "\x1b[0m" + tail;
}

/**
 * The control sequence a shell's line editor needs for one of the editing keys a terminal window
 * handles itself — Option for words, Command for the line on a Mac; Ctrl with the arrows on the
 * others. Undefined for anything else, so the terminal gets the key as usual.
 */
export function editingSequence(
  mac: boolean,
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
): string | undefined {
  if (mac) {
    if (e.metaKey && !e.ctrlKey && !e.altKey) {
      // ⌘←/→ to the ends of the line, ⌘⌫ back to its start.
      return { ArrowLeft: "\x01", ArrowRight: "\x05", Backspace: "\x15" }[e.key];
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      // ⌥←/→ a word at a time, ⌥⌫ and ⌥⌦ kill a word.
      return { ArrowLeft: "\x1bb", ArrowRight: "\x1bf", Backspace: "\x1b\x7f", Delete: "\x1bd" }[e.key];
    }
    return undefined;
  }
  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    return { ArrowLeft: "\x1bb", ArrowRight: "\x1bf", Backspace: "\x17", Home: "\x01", End: "\x05" }[e.key];
  }
  return undefined;
}
