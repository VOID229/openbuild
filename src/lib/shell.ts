// Commands the user runs from the composer (server/pi/shell.ts): "!cmd" runs in the thread's folder and
// the agent reads the command and its output with the next message; "!!cmd" runs for the user alone.
// Neither waits for a reply nor interrupts one. Each is its own message in the thread, following its
// own stream on the server, so a reload or another device picks it back up.
import { readEvents, type ReplyStream } from "../../shared/replies";
import { outputTail, shellCommand } from "../../shared/shell";
import type { ShellEvent } from "../../shared/types";
import { makeTitle, newWorkspace } from "./chat";
import { uid } from "./id";
import { canResume, replyHost } from "./runtime";
import { apiUrl, deviceServerId } from "./devices";
import { threadDevice, useStore } from "./store";
import type { Chat, Message, ShellRun } from "./types";

export { shellCommand };

/** Output kept on screen and saved with the thread (the latest of it, for a long-running command). */
const KEEP = 64 * 1024;
/** Give up on a command the server can't be reached about for this long. */
const PATIENCE = 10 * 60 * 1000;

/** Commands this app is following, by message id. */
const following = new Map<string, AbortController>();

/** Run "!cmd" or "!!cmd" in `chatId` (default: the open chat, or a new one). Throws what went wrong before it started. */
export async function runShell(text: string, chatId = useStore.getState().activeChatId): Promise<void> {
  const parsed = shellCommand(text);
  if (!parsed) return;
  const st = useStore.getState();
  const existing = chatId ? st.chats.find((c) => c.id === chatId) : undefined;
  const runtime = existing ? (existing.runtime ?? "pi") : (st.settings.threadRuntime ?? "pi");
  if (runtime === "durable") throw new Error("Shell commands aren't available in Durable threads yet.");
  const now = Date.now();
  const plannedDevice = existing?.workspace?.deviceId ?? (existing ? undefined : threadDevice(st));
  const via = plannedDevice ? (deviceServerId(plannedDevice) ?? replyHost()) : replyHost();
  const stream: ReplyStream = { id: uid(), via: via ?? "", deviceId: plannedDevice };
  const message: Message = {
    id: uid(),
    role: "shell",
    content: parsed.command,
    createdAt: now,
    startedAt: now,
    shell: { command: parsed.command, hidden: parsed.hidden || undefined, status: "running", output: "", stream },
  };
  const chat: Chat = existing
    ? { ...existing, runtime, updatedAt: now, messages: [...existing.messages, message] }
    : { id: uid(), title: makeTitle(parsed.command, []), runtime, createdAt: now, updatedAt: now, messages: [message], efforts: { ...st.settings.modelEfforts } };
  st.upsertChat(chat);
  if (chatId === st.activeChatId) useStore.setState({ activeChatId: chat.id });
  // A thread's first command sets up where it works, as its first message would.
  let workspace = chat.workspace;
  if (!workspace) {
    try {
      workspace = await newWorkspace(chat);
    } catch (err) {
      return patchShell(chat.id, message.id, { status: "error", error: (err as Error).message }, true);
    }
    useStore.getState().updateChat(chat.id, { workspace });
    if (workspace.deviceId) {
      stream.deviceId = workspace.deviceId;
      patchShell(chat.id, message.id, { stream }, true);
    }
  }
  void follow(chat.id, message.id, { cwd: workspace.cwd, command: parsed.command, hidden: parsed.hidden });
}

/** Stop a running command. Pi stops the thread's other running commands with it. */
export async function stopShell(message: Message) {
  const stream = message.shell?.stream;
  if (!stream || message.shell?.status !== "running") return;
  try {
    await fetch(apiUrl(stream.deviceId, `/api/pi/shells/${encodeURIComponent(stream.id)}/stop`), { method: "POST" });
  } catch (err) {
    console.warn("[shell] couldn't stop a command", err);
  }
}

/** Pick back up commands still running on this server (after a reload, or ones another device started). */
export function resumeShells(chatId?: string) {
  for (const chat of useStore.getState().chats) {
    if (chatId && chat.id !== chatId) continue;
    for (const m of chat.messages) {
      if (m.shell?.status === "running" && m.shell.stream && canResume(m.shell.stream.via)) void follow(chat.id, m.id);
    }
  }
}

function patchShell(chatId: string, messageId: string, patch: Partial<ShellRun>, persist = false) {
  useStore.getState().patchMessage(chatId, messageId, (m) => (m.shell ? { shell: { ...m.shell, ...patch } } : {}), persist);
}

/**
 * Follow a command's output into its message until it's over. `start`: run it first (otherwise it's
 * already running, and only the device that started it saves it along the way).
 */
async function follow(chatId: string, messageId: string, start?: { cwd: string; command: string; hidden: boolean }) {
  const message = useStore.getState().chats.find((c) => c.id === chatId)?.messages.find((m) => m.id === messageId);
  const shell = message?.shell;
  if (!shell?.stream || following.has(messageId)) return;
  const startedAt = message!.startedAt ?? message!.createdAt;
  const ctrl = new AbortController();
  following.set(messageId, ctrl);
  let output = shell.output;
  let exit: Extract<ShellEvent, { t: "exit" }> | undefined;
  let savedAt = Date.now();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (exit) return;
    const persist = !!start && Date.now() - savedAt > 2000;
    if (persist) savedAt = Date.now();
    patchShell(chatId, messageId, { output }, persist);
  };
  try {
    for await (const e of shellEvents(chatId, shell.stream, start, ctrl.signal)) {
      if (e.t === "snap") output = outputTail(e.output, KEEP);
      else if (e.t === "out") output = outputTail(output + e.v, KEEP);
      else if (e.t === "exit") exit = e;
      if (!scheduled && !exit) {
        scheduled = true;
        if (document.hidden) setTimeout(flush, 250);
        else requestAnimationFrame(flush);
      }
    }
  } catch (err) {
    exit = { t: "exit", status: "error", error: (err as Error).message, ms: Date.now() - startedAt };
  } finally {
    following.delete(messageId);
  }
  const ended = exit ?? { t: "exit", status: "error", error: "Lost the connection to this command.", ms: Date.now() - startedAt };
  patchShell(chatId, messageId, { output, status: ended.status, exitCode: ended.exitCode, fullOutputPath: ended.fullOutputPath, error: ended.error, ms: ended.ms }, true);
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
});

/**
 * A command's events: POST it (when `start` is given) or watch it, reconnecting when the connection
 * drops; the server sends the output so far again on each connection. Ends with its "exit".
 */
async function* shellEvents(threadId: string, stream: ReplyStream, start: { cwd: string; command: string; hidden: boolean } | undefined, signal: AbortSignal): AsyncGenerator<ShellEvent> {
  let posted = !start;
  let failingSince: number | undefined;
  let delay = 500;
  while (!signal.aborted) {
    let res: Response | undefined;
    try {
      res = posted
        ? await fetch(apiUrl(stream.deviceId, `/api/pi/shells/${encodeURIComponent(stream.id)}`), { signal })
        : await fetch(apiUrl(stream.deviceId, `/api/pi/threads/${encodeURIComponent(threadId)}/shell`), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: stream.id, ...start }),
            signal,
          });
    } catch {
      // Unreachable; retry below. Posting again is safe: the server runs a command once per id.
    }
    if (res?.status === 404 && posted) throw new Error("This command can't be picked back up (the server restarted?).");
    if (res && !res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `Couldn't run the command (HTTP ${res.status})`);
    }
    if (res?.body) {
      posted = true;
      try {
        for await (const e of readEvents(res.body) as AsyncGenerator<ShellEvent>) {
          if (e.t === "end") return;
          failingSince = undefined;
          delay = 500;
          yield e;
        }
      } catch {
        // Cut off: reconnect below.
      }
    }
    if (signal.aborted) return;
    failingSince ??= Date.now();
    if (Date.now() - failingSince > PATIENCE) throw new Error("Lost the connection to this command.");
    await wait(delay, signal);
    delay = Math.min(delay * 2, 5000);
  }
}
