// A command the user ran from the composer ("!cmd" or "!!cmd"): the command as their own bubble, and
// under it, like a reply, its output as it comes in, with how it ended (or a Stop button while it runs).
import { Check, ChevronRight, CircleAlert, Copy, Eye, EyeOff, Square, SquareTerminal } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { stopShell } from "../lib/shell";
import { useStore } from "../lib/store";
import type { Message } from "../lib/types";
import { copyText, cx, duration } from "../lib/ui";
import { Fold } from "./Fold";
import { IconButton, Spinner } from "./primitives";

/** Where the command ran, as shown: a scratch thread's commands run in the home folder. */
function useWhere(chatId: string): string {
  const ws = useStore((s) => s.chats.find((c) => c.id === chatId)?.workspace);
  if (!ws || (!ws.projectId && !ws.projectName)) return "~";
  const name = ws.projectName || ws.cwd.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  return ws.worktree && ws.branch ? `${name} · ${ws.branch}` : name;
}

const seconds = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function CopyOutput({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? "Copied" : "Copy output"}
      tooltipSide="top"
      className="shell-action"
      onClick={async (e) => {
        e.stopPropagation();
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </IconButton>
  );
}

export function ShellMessage({ message, chatId }: { message: Message; chatId: string }) {
  const run = message.shell!;
  const running = run.status === "running";
  const where = useWhere(chatId);
  // Pi stops all of a thread's running commands together, so say so when there are others.
  const others = useStore((s) => (running ? (s.chats.find((c) => c.id === chatId)?.messages.filter((m) => m.id !== message.id && m.shell?.status === "running").length ?? 0) : 0));
  const now = useNow(running);
  const [open, setOpen] = useState(true);
  const [stopping, setStopping] = useState(false);
  const output = run.output.replace(/\n+$/, "");

  // Keep following new output at the bottom, unless the reader scrolled up in it.
  const pre = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = pre.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [output, open]);

  const elapsed = running ? now - (message.startedAt ?? message.createdAt) : run.ms;
  const failed = run.status === "error" || (run.status === "done" && run.exitCode !== undefined && run.exitCode !== 0);
  const status = running
    ? stopping
      ? "Stopping…"
      : elapsed !== undefined && elapsed >= 2000
        ? duration(elapsed)
        : ""
    : run.status === "stopped"
      ? "Stopped"
      : run.status === "error"
        ? "Failed"
        : run.exitCode
          ? `Exit ${run.exitCode}`
          : run.exitCode === undefined
            ? "Ended"
            : run.ms !== undefined
              ? seconds(run.ms)
              : "";

  return (
    <div className="msg msg-shell" data-message-id={message.id}>
      <div className="msg-user">
        <div className="bubble bubble-shell">
          <span className="shell-sigil" aria-hidden>
            $
          </span>
          {run.command}
        </div>
      </div>
      <div className={cx("shell-run", open && "shell-open")}>
        <div className="shell-head">
          <button type="button" className="shell-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <SquareTerminal size={14} className="shell-icon" />
            <span className="shell-where">{where}</span>
            <span
              className="shell-audience"
              data-tooltip={run.hidden ? "Ran with !!, so the agent never sees it" : running ? "The agent reads this with your next message" : "The agent reads this with the next message after it"}
              data-tooltip-side="top"
            >
              {run.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
              {run.hidden ? "Only you" : "Shared with the agent"}
            </span>
            <span className="shell-status">
              {status && <span className={cx(failed && "bad")}>{status}</span>}
              {running ? <Spinner size={12} /> : failed ? <CircleAlert size={13} className="bad" /> : run.status === "done" ? <Check size={13} className="ok" /> : null}
            </span>
            <ChevronRight size={14} className="shell-chevron" />
          </button>
          {output && <CopyOutput text={run.output} />}
          {running && (
            <IconButton
              label="Stop command"
              tooltip={others ? `Stop (Pi also stops the ${others === 1 ? "other running command" : `${others} other running commands`} in this thread)` : "Stop"}
              tooltipSide="top"
              className="shell-action"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                void stopShell(message);
              }}
            >
              <Square size={11} fill="currentColor" />
            </IconButton>
          )}
        </div>
        <Fold open={open} className="shell-body">
          {output ? (
            <pre
              ref={pre}
              className="shell-output"
              onScroll={(e) => {
                const el = e.currentTarget;
                pinned.current = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
              }}
            >
              {output}
            </pre>
          ) : (
            <div className={cx("shell-empty", running && "shimmer")}>{running ? "Running…" : "No output"}</div>
          )}
          {run.error && <div className="shell-note bad">{run.error}</div>}
          {run.fullOutputPath && !run.hidden && (
            <div className="shell-note">
              The agent got the end of the output. All of it is in <code>{run.fullOutputPath}</code>
            </div>
          )}
        </Fold>
      </div>
    </div>
  );
}
