// One Pi process per bot. It stays up while the bot is in a conversation and exits after it's been
// idle, the same way threads do. Messages that arrive mid-reply are steered in; everything else waits
// and runs when the bot is free. The process loads server/bots/extension.ts, which calls back over
// the unix socket in agent.ts.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { conversationTitle, firstName, replyBubbles } from "../../shared/bots";
import { procListeners } from "../computers/index";
import { PiError, PiProcess, type PiRecord } from "../pi/rpc";
import { agentDir, piBin } from "../pi/install";
import { botsDir } from "./db";
import * as db from "./db";
import { agentSocketPath, getFocus, listen, mintToken, revokeToken, setFocus } from "./agent";
import * as svc from "./service";
import type { Wake } from "./service";

const IDLE = 20 * 60 * 1000;
const TOOLS = ["bash", "read", "write", "edit", "browser", "process", "send_message", "react", "question", "remember", "forget", "search", "routine", "ask_bot", "manage_bot"].join(",");

interface Mind {
  proc: PiProcess;
  token: string;
  busy: boolean;
  /** The bot already wrote to the chat this run, so leftover assistant text isn't posted too. */
  sent: boolean;
  draft: string;
  onSettled?: () => void;
  onExit?: (e: Error) => void;
}

const hot = globalThis as {
  openbotsMinds?: Map<string, Mind>;
  openbotsQueue?: Map<string, Wake[]>;
  openbotsTimer?: ReturnType<typeof setInterval>;
  openbotsProc?: boolean;
  openbotsPumping?: Set<string>;
};
const minds = (hot.openbotsMinds ??= new Map());
const queue = (hot.openbotsQueue ??= new Map());
const pumping = (hot.openbotsPumping ??= new Set<string>());

export function busy(botId: string): boolean {
  return pumping.has(botId) || (queue.get(botId)?.length ?? 0) > 0;
}

export function wake(botId: string, item: Wake) {
  const mind = minds.get(botId);
  if (pumping.has(botId) && mind && !mind.proc.exited) {
    const text = render([item], botId);
    void mind.proc
      .send({ type: "steer", message: text }, 15_000)
      .then(() => {
        if (item.conversationId) db.setCursor(botId, item.conversationId, db.latestSeq(item.conversationId));
      })
      .catch(() => enqueue(botId, item));
    return;
  }
  enqueue(botId, item);
}

function enqueue(botId: string, item: Wake) {
  const list = queue.get(botId) ?? [];
  list.push(item);
  queue.set(botId, list);
  void pump(botId);
}

async function pump(botId: string) {
  if (pumping.has(botId)) return;
  pumping.add(botId);
  const mind = minds.get(botId);
  if (mind) mind.busy = true;
  try {
    while (queue.get(botId)?.length) {
      const jobs = queue.get(botId)!;
      queue.set(botId, []);
      await run(botId, jobs);
    }
  } finally {
    pumping.delete(botId);
    const current = minds.get(botId);
    if (current) current.busy = false;
    if (queue.get(botId)?.length) void pump(botId);
  }
}

export function stop(botId: string) {
  const mind = minds.get(botId);
  if (!mind) return;
  revokeToken(mind.token);
  mind.proc.close();
  minds.delete(botId);
  queue.delete(botId);
}

function sessionDir() {
  const dir = join(botsDir(), "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function workDir(botId: string) {
  const dir = join(botsDir(), "minds", botId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function ensureMind(botId: string): Promise<Mind> {
  const existing = minds.get(botId);
  if (existing && !existing.proc.exited) return existing;
  if (!piBin()) throw new PiError("Pi isn't installed. Install it in Settings → Pi.");
  const token = mintToken(botId);
  const proc = new PiProcess(
    ["--session-dir", sessionDir(), "--session-id", botId, "--no-skills", "--no-context-files", "--no-mcp", "--no-builtin-tools", "--tools", TOOLS, "-e", join(import.meta.dir, "extension.ts")],
    workDir(botId),
    { OPENBOTS_SOCKET: agentSocketPath(), OPENBOTS_TOKEN: token, OPENBOTS_BOT: botId },
  );
  const mind: Mind = { proc, token, busy: true, sent: false, draft: "" };
  proc.on((record) => onRecord(botId, mind, record));
  minds.set(botId, mind);
  return mind;
}

/** Pi's own default, from its settings. A resumed session keeps its last model, so this has to be asked for. */
function piDefaultModel(): string | undefined {
  try {
    const { defaultProvider, defaultModel } = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
    return defaultProvider && defaultModel ? `${defaultProvider}/${defaultModel}` : undefined;
  } catch {
    return undefined;
  }
}

/** Put a bot's Pi on its model before a run. A model that can't be used fails the reply instead of quietly running on another. */
export async function applyModel(proc: Pick<PiProcess, "send">, botId: string) {
  const model = db.getBot(botId)?.model || svc.getSettings().defaultModel || piDefaultModel();
  if (!model?.includes("/")) return;
  const slash = model.indexOf("/");
  const provider = model.slice(0, slash);
  const modelId = model.slice(slash + 1);
  const state = await proc.send<{ model?: { provider: string; id: string } }>({ type: "get_state" });
  if (state.model?.provider !== provider || state.model?.id !== modelId) await proc.send({ type: "set_model", provider, modelId }, 20_000);
}

/** Our extension returns a posted message id only after the service actually accepted it. */
export function successfulMessageTool(record: PiRecord): boolean {
  return record.type === "tool_execution_end"
    && (record.toolName === "send_message" || record.toolName === "question")
    && !record.isError && !record.result?.isError
    && typeof record.result?.details?.id === "string" && !!record.result.details.id;
}

export async function applyEffort(proc: Pick<PiProcess, "send">, botId: string) {
  const effort = db.getBot(botId)?.effort;
  if (!effort) return;
  const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!order.includes(effort)) throw new PiError(`Unknown bot effort: ${effort}`);
  const { levels } = await proc.send<{ levels: string[] }>({ type: "get_available_thinking_levels" });
  const supported = levels.filter((level) => order.includes(level));
  const level = supported.includes(effort) ? effort : supported.sort((a, b) => Math.abs(order.indexOf(a) - order.indexOf(effort)) - Math.abs(order.indexOf(b) - order.indexOf(effort)))[0];
  if (level) await proc.send({ type: "set_thinking_level", level });
}

function onRecord(botId: string, mind: Mind, record: PiRecord) {
  if (record.type === "agent_settled") mind.onSettled?.();
  if (record.type === "process_exit") mind.onExit?.(new PiError(String(record.message ?? "Pi exited")));
  mind.sent ||= successfulMessageTool(record);
  if (record.type === "tool_execution_start") {
    const activity = activityFor(String(record.toolName ?? ""), record.args);
    svc.setStatus(botId, { state: "working", activity, conversationId: getFocus(botId), since: Date.now() });
    mind.draft = "";
    const conversationId = getFocus(botId);
    if (conversationId) svc.setDraft(undefined, { conversationId, botId });
  }
  const delta = record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta" ? String(record.assistantMessageEvent.delta ?? "") : "";
  if (delta) {
    mind.draft += delta;
    const conversationId = getFocus(botId);
    if (conversationId && !mind.sent && !"[silent]".startsWith(mind.draft.trim().toLowerCase())) svc.setDraft({ conversationId, botId, text: mind.draft.slice(-4000) }, { conversationId, botId });
  }
}

function activityFor(tool: string, args: unknown): string {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  if (tool === "bash" || tool === "process") return "running a command";
  if (tool === "browser") return a.action === "open" ? `opening ${String(a.url ?? "").slice(0, 60)}` : "browsing";
  if (tool === "read" || tool === "write" || tool === "edit") return "working with files";
  if (tool === "ask_bot") return "asking another bot";
  return "thinking";
}

async function run(botId: string, jobs: Wake[]) {
  const conversationId = jobs.find((j) => j.conversationId)?.conversationId ?? svc.directId(botId);
  svc.setStatus(botId, { state: "working", conversationId, activity: "thinking", since: Date.now() });
  if (conversationId) svc.setTyping(conversationId, botId, true);
  setFocus(botId, conversationId);
  let mind: Mind | undefined;
  try {
    mind = await ensureMind(botId);
    mind.busy = true;
    mind.sent = false;
    mind.draft = "";
    const message = render(jobs, botId);
    if (!message.trim()) return;
    await applyModel(mind.proc, botId);
    await applyEffort(mind.proc, botId);
    const images = imagesFor(jobs, botId);
    markSeen(botId, jobs);
    let settled = false;
    mind.onSettled = () => {
      settled = true;
    };
    const accepted = await mind.proc.send({ type: "prompt", message, ...(images.length ? { images } : {}) }, 60_000);
    if ((accepted as { disposition?: string })?.disposition === "handled" || settled) {
      if (!settled) return;
    } else await waitSettled(mind);
    if (!mind.sent) {
      const text = mind.draft.trim();
      if (conversationId) {
        for (const part of replyBubbles(text)) {
          svc.postMessage(conversationId, { id: crypto.randomUUID(), author: botId, at: Date.now(), text: part.slice(0, 8000) });
        }
      }
    }
    for (const job of jobs) if (job.conversationId) db.setCursor(botId, job.conversationId, db.latestSeq(job.conversationId));
    svc.touchHeartbeat(botId);
    svc.setStatus(botId, { state: "idle" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    svc.setStatus(botId, { state: "error", error: message, since: Date.now() });
    const where = conversationId ?? svc.directId(botId);
    const last = db.getValue<number>(`told:${botId}`) ?? 0;
    if (where && Date.now() - last > 60_000) {
      db.setValue(`told:${botId}`, Date.now());
      svc.postMessage(where, { id: crypto.randomUUID(), author: botId, at: Date.now(), text: "", event: { kind: "error", text: "Couldn't reply", detail: message.slice(0, 300) } });
    }
    if (mind?.proc.exited) {
      revokeToken(mind.token);
      minds.delete(botId);
    }
  } finally {
    if (conversationId) {
      svc.setTyping(conversationId, botId, false);
      svc.setDraft(undefined, { conversationId, botId });
    }
    setFocus(botId, undefined);
  }
}

function waitSettled(mind: Mind): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mind.proc.close();
      reject(new PiError("The reply took too long and was stopped."));
    }, 15 * 60 * 1000);
    timer.unref?.();
    mind.onSettled = () => (clearTimeout(timer), resolve());
    mind.onExit = (e) => (clearTimeout(timer), reject(e));
  });
}

function render(jobs: Wake[], botId: string): string {
  const bots = db.listBots();
  const user = svc.getSettings().user?.name || "User";
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    if (job.conversationId && !seen.has(job.conversationId)) {
      seen.add(job.conversationId);
      parts.push(transcript(job.conversationId, bots, user, botId));
    }
    if (job.text && job.kind !== "messages") parts.push(job.text);
  }
  parts.push("Use send_message to reply (one call per bubble, in this conversation unless you name another). If there's nothing to say, send nothing and end with the plain reply [silent].");
  return parts.filter(Boolean).join("\n\n");
}

export function transcript(conversationId: string, bots: { id: string; name: string }[], user: string, botId: string): string {
  const c = db.getConversation(conversationId);
  if (!c) return "";
  const cursor = db.cursor(botId, conversationId);
  const rows = db.messages(conversationId, 16);
  const lines = rows.map((r) => {
    const m = r.message;
    const who = m.author === "me" ? user : firstName(bots.find((b) => b.id === m.author)?.name ?? "Bot");
    const body = m.event ? `(${m.event.text}${m.event.detail ? `: ${m.event.detail}` : ""})` : m.text.slice(0, 2000);
    const mark = r.seq > cursor ? "" : " [already seen]";
    return `[${m.id.slice(0, 8)}] ${who}${mark}: ${body}`;
  });
  return `Conversation ${conversationId.slice(0, 8)} (${c.kind}, “${conversationTitle(c, bots)}”):\n${c.instructions ? `Group instructions: ${c.instructions}\n` : ""}${lines.join("\n") || "(empty)"}`;
}

function imagesFor(jobs: Wake[], botId: string): { type: "image"; data: string; mimeType: string }[] {
  for (const job of jobs) {
    if (!job.conversationId) continue;
    const cursor = db.cursor(botId, job.conversationId);
    const rows = db.messagesAfter(job.conversationId, cursor, 20);
    const mine = rows.filter((r) => r.message.author === "me" && r.message.images?.length).at(-1);
    if (!mine) continue;
    const out = [];
    for (const url of mine.message.images!.slice(0, 4)) {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(url);
      if (m) out.push({ type: "image" as const, mimeType: m[1]!, data: m[2]!.replace(/\s/g, "") });
    }
    if (out.length) return out;
  }
  return [];
}

function markSeen(botId: string, jobs: Wake[]) {
  for (const job of jobs) {
    if (!job.conversationId) continue;
    const cursor = db.cursor(botId, job.conversationId);
    for (const row of db.messagesAfter(job.conversationId, cursor, 50)) {
      const m = row.message;
      if (m.author !== "me" || m.seenBy?.includes(botId)) continue;
      svc.patchMessage(job.conversationId, m.id, { seenBy: [...(m.seenBy ?? []), botId] });
    }
  }
}

export function startBots() {
  listen();
  svc.setHooks({ wake, stop });
  if (!hot.openbotsProc) {
    hot.openbotsProc = true;
    procListeners.add((computerId, proc, tail) => {
      if (!db.getBot(computerId)) return;
      wake(computerId, {
        kind: "note",
        conversationId: svc.directId(computerId),
        text: `A process on your computer finished: ${proc.name || proc.command} (exit ${proc.exitCode ?? "?"}).\n${tail.slice(-2000)}\nTell the user if it matters.`,
      });
    });
  }
  if (hot.openbotsTimer) clearInterval(hot.openbotsTimer);
  hot.openbotsTimer = setInterval(() => {
    try {
      svc.tick(busy);
    } catch (err) {
      // A stale record or a failed wake must not escape the interval and crash the server.
      console.error("[bots] scheduler failed:", err);
    }
    for (const [id, mind] of minds) {
      if (!mind.busy && (mind.proc.exited || Date.now() - mind.proc.lastUsed > IDLE)) stop(id);
    }
  }, 15_000);
  hot.openbotsTimer.unref?.();
}
