import { join, resolve } from "node:path";
import type { PiChatRequest, StreamEvent, Usage } from "../../shared/types";
import * as storage from "../storage";
import { CodexProcess, CodexRpcError, type RpcMessage } from "./rpc";
import { toolEvent } from "./tools";
import { AUTO_REVIEW, permissionParams } from "./install";
interface Saved { id: string; cwd: string; turns: number; nativeTurns?: number; tokens?: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number; outputTokens: number } }
const key = (id: string) => `codex-session:${id}`;
function saved(id: string): Saved | undefined {
  const raw = storage.getValue(key(id));
  if (!raw) return;
  const s = JSON.parse(raw);
  if (!s?.id || typeof s.turns !== "number" || !s.cwd) throw new Error("Invalid saved Codex mapping; refusing to replace its history");
  return s;
}
function save(id: string, s: Saved) { storage.setValue(key(id), JSON.stringify(s)); }
type Ask = Extract<StreamEvent, { t: "ask" }>;
type Reply = { value?: string; confirmed?: boolean; cancelled?: boolean };
interface Live {
  proc: CodexProcess; ready: Promise<string>; busy: boolean; asks: Map<string, { ask: Ask; reply: (r: Reply) => void }>;
  /** The profile a turn on this process selected; Codex keeps it for later turns. */
  permission?: string;
  emit?: (e: StreamEvent) => void;
  /** The running native turn, once Codex has accepted it: only then can messages be steered into it. */
  turn?: { thread: string; id: string; steers: Set<string> };
}
const hot = globalThis as typeof globalThis & { openbuildCodexLive?: Map<string, Live>; openbuildCodexReaper?: ReturnType<typeof setInterval> };
const live = hot.openbuildCodexLive ??= new Map<string, Live>();
if (hot.openbuildCodexReaper) clearInterval(hot.openbuildCodexReaper);
hot.openbuildCodexReaper = setInterval(() => {
  for (const [id, l] of live) if (l.proc.exited || (!l.busy && Date.now() - l.proc.lastUsed > 20 * 60000)) release(id);
}, 60000);
hot.openbuildCodexReaper.unref();
export const isSessionLive = (id: string) => !!live.get(id) && !live.get(id)!.proc.exited;
export const hasAsk = (id: string, askId: string) => !!live.get(id)?.asks.has(askId);
export function answer(id: string, askId: string, reply: Reply): boolean {
  const l = live.get(id), p = l?.asks.get(askId);
  if (!l || !p) return false;
  l.asks.delete(askId); p.reply(reply);
  l.emit?.({ t: "asked", id: askId, answer: reply.cancelled ? undefined : p.ask.secret ? "[redacted]" : reply.value ?? (reply.confirmed ? "Allow once" : undefined) });
  return true;
}
/** Whether a message can be steered into this thread's running turn. */
export const canSteer = (id: string) => !!live.get(id)?.busy;
/**
 * Hand Codex a message while it works on a turn (native turn/steer); it reads it at its next step.
 * The reply stream reports a `steer` event once Codex places it in the turn.
 */
export async function steer(id: string, steerId: string, message: string, images?: PiChatRequest["images"]): Promise<{ handled: boolean }> {
  const l = live.get(id);
  if (!l?.busy || l.proc.exited) throw new Error("Codex isn't working on this thread anymore.");
  const turn = l.turn;
  if (!turn) throw new Error("Codex hasn't started on this reply yet. Try again in a moment.");
  turn.steers.add(steerId);
  try {
    await l.proc.request("turn/steer", { threadId: turn.thread, expectedTurnId: turn.id, clientUserMessageId: steerId, input: input(message, images) }, 30000);
  } catch (e) {
    turn.steers.delete(steerId);
    throw e instanceof CodexRpcError ? new Error(`Codex couldn't take the message: ${e.message}`) : e;
  }
  return { handled: false };
}
const input = (text: string, images?: PiChatRequest["images"]) => [{ type: "text", text, text_elements: [] }, ...(images ?? []).map((i) => ({ type: "image", url: `data:${i.mimeType};base64,${i.data}` }))];
export function release(id: string) { live.get(id)?.proc.close(); live.delete(id); }
export function restartIdle() { for (const [id, l] of live) if (!l.busy) release(id); }
export const sessionDir = () => join(process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex"), "sessions");
function question(l: Live, ask: Omit<Ask, "t" | "id">, reply: (r: Reply) => void) {
  const id = `codex-ask-${crypto.randomUUID()}`;
  const event: Ask = { t: "ask", id, ...ask };
  l.asks.set(id, { ask: event, reply }); l.emit?.(event);
}
function serverRequest(l: Live, m: RpcMessage) {
  if (m.id === undefined || !m.method) return;
  const p = m.params ?? {}, id = m.id;
  const respond = (r: unknown) => { if (!l.proc.exited) l.proc.respond(id, r); };
  if (m.method === "item/commandExecution/requestApproval" || m.method === "item/fileChange/requestApproval") {
    question(l, { method: "select", title: m.method.includes("commandExecution") ? `Allow Codex to run ${p.command ?? "this command"}?` : "Allow Codex file changes?", message: [p.reason, p.cwd].filter(Boolean).join("\n"), options: ["Allow once", "Deny", "Cancel turn"] }, (r) => respond({ decision: r.cancelled || r.value === "Cancel turn" ? "cancel" : r.confirmed || r.value === "Allow once" ? "accept" : "decline" }));
  } else if (m.method === "item/permissions/requestApproval") {
    question(l, { method: "select", title: "Grant Codex additional permissions for this turn?", message: `${p.reason ?? ""}\n${JSON.stringify(p.permissions, null, 2)}`, options: ["Allow once", "Deny"] }, (r) => respond({ permissions: !r.cancelled && (r.confirmed || r.value === "Allow once") ? p.permissions : {}, scope: "turn" }));
  } else if (m.method === "item/tool/requestUserInput") {
    const answers: Record<string, { answers: string[] }> = {};
    const qs = Array.isArray(p.questions) ? p.questions : [];
    if (!qs.length) { respond({ answers }); return; }
    let left = qs.length;
    for (const q of qs) question(l, { method: q.options?.length ? "select" : "input", title: q.header || q.question, message: q.question, options: q.options?.map((o: any) => o.label), other: !!q.isOther, secret: !!q.isSecret }, (r) => {
      answers[q.id] = { answers: r.cancelled ? [] : [r.value ?? ""] };
      if (--left === 0) respond({ answers });
    });
  } else {
    // Never execute delegated client tools or auto-authorize unknown requests.
    l.proc.respondError(id, `OpenBuild does not support Codex request ${m.method}`);
  }
}
function ensure(req: PiChatRequest): Live {
  let l = live.get(req.threadId);
  if (l && !l.proc.exited) {
    if (l.proc.cwd !== resolve(req.cwd)) throw new Error("Codex thread workspace mismatch");
    return l;
  }
  const proc = new CodexProcess(resolve(req.cwd));
  l = { proc, ready: Promise.resolve(""), busy: false, asks: new Map() };
  const current = l;
  proc.on((m) => serverRequest(current, m));
  l.ready = (async () => {
    await proc.initialize();
    const s = saved(req.threadId);
    if (s) {
      if (s.cwd !== proc.cwd) throw new Error("Codex thread workspace mismatch; cannot resume in another directory");
      const r = await proc.request("thread/resume", { threadId: s.id, cwd: s.cwd });
      if (r.thread?.id !== s.id || !Array.isArray(r.thread.turns) || r.thread.turns.length !== (s.nativeTurns ?? s.turns)) throw new Error("Codex history mismatch (possibly edited externally); refusing to replay messages");
      if (r.thread.turns.some((t: any) => t.status === "inProgress")) throw new Error("Codex has an unfinished turn; refusing to steer or resend it");
      return s.id;
    }
    const r = await proc.request("thread/start", { cwd: proc.cwd, model: req.model.replace(/^codex\//, "") });
    if (!r.thread?.id) throw new Error("Codex did not return a thread id");
    save(req.threadId, { id: r.thread.id, cwd: proc.cwd, turns: 0, nativeTurns: 0 });
    return r.thread.id;
  })();
  l.ready.catch(() => proc.close());
  live.set(req.threadId, l);
  return l;
}
export function runTurn(req: PiChatRequest, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancel: (() => void) | undefined;
  return new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (e: StreamEvent) => { if (!closed) { try { controller.enqueue(encoder.encode(JSON.stringify(e) + "\n")); } catch { closed = true; cancel?.(); } } };
      void (async () => {
        let l: Live | undefined, off: (() => void) | undefined, onAbort: (() => void) | undefined;
        let owned = false;
        try {
          if (signal.aborted) { send({ t: "done", finish: "aborted" }); return; }
          if (req.forkFrom) throw new Error("Codex does not support forking through OpenBuild; start a new thread");
          const before = saved(req.threadId);
          if (!Number.isInteger(req.prior) || req.prior !== (before?.turns ?? 0)) throw new Error("Codex history mismatch: rewind, retry, or missing session history is not supported; old messages will not be resent");
          l = ensure(req);
          if (l.busy) throw new Error("Codex thread is already running");
          // Overrides stick to the native thread. Leaving a picked mode (for the default, or from
          // auto-review's reviewer to a plain profile) needs a fresh process, which resumes with
          // only the user's own configuration before the new choice is applied.
          if (l.permission && l.permission !== req.permission && (!req.permission || l.permission === AUTO_REVIEW)) { release(req.threadId); l = ensure(req); }
          l.busy = owned = true; l.emit = send;
          const threadId = await l.ready;
          if (signal.aborted) { send({ t: "done", finish: "aborted" }); return; }
          const proc = l.proc;
          let turnId: string | undefined, aborted = false;
          const usage: Usage = {};
          const outputs = new Map<string, string>();
          const toolNames = new Map<string, string>();
          const childThreads = new Set<string>();
          const currentSaved = saved(req.threadId)!;
          const baseline = currentSaved.tokens;
          const nativeTurns = currentSaved.nativeTurns ?? currentSaved.turns;
          let afterTool = false;
          const texts = new Map<string, string>();
          let lastTextId: string | undefined;
          let finish!: (v: any) => void, fail!: (e: Error) => void;
          const completion = new Promise<any>((res, rej) => { finish = res; fail = rej; });
          completion.catch(() => {});
          off = proc.on((m) => {
            const p = m.params ?? {};
            if (m.method === "$/exit") { fail(new Error(p.message)); return; }
            if (m.method === "thread/started" && (p.thread?.parentThreadId === threadId || childThreads.has(p.thread?.parentThreadId))) childThreads.add(p.thread.id);
            const child = p.threadId !== threadId && childThreads.has(p.threadId);
            if (p.threadId !== threadId && !child) return;
            if (!child && turnId && p.turnId && p.turnId !== turnId) return;
            if (m.method === "item/started" || m.method === "item/completed") {
              for (const id of p.item?.receiverThreadIds ?? []) childThreads.add(id);
              if (p.item?.type === "subAgentActivity" && p.item.agentThreadId) childThreads.add(p.item.agentThreadId);
            }
            if (child) {
              // Child turns must never complete the parent turn or overwrite its usage/text.
              // Still expose every native child tool, namespaced to prevent item ID collisions.
              if (m.method === "item/started" || m.method === "item/completed") {
                const item = p.item;
                if (item) { const e = toolEvent(item, m.method === "item/completed", outputs.get(`${p.threadId}:${item.id}`)); if (e) { toolNames.set(`${p.threadId}:${item.id}`, e.name); send({ ...e, id: `${p.threadId}:${e.id}`, args: { ...e.args, agentThreadId: p.threadId } }); } }
              } else if (m.method === "item/commandExecution/outputDelta" || m.method === "item/fileChange/outputDelta") {
                const id = `${p.threadId}:${p.itemId}`;
                const output = (outputs.get(id) ?? "") + p.delta; outputs.set(id, output);
                send({ t: "tool", id, name: toolNames.get(id) ?? (m.method.includes("commandExecution") ? "bash" : "edit"), args: { agentThreadId: p.threadId }, status: "running", output });
              }
              return;
            }
            if (m.method === "turn/started") turnId ??= p.turn?.id;
            // A message steered into this turn: show it where Codex read it, and count it as a user message.
            if (m.method === "item/started" && p.item?.type === "userMessage" && p.item.clientId && l!.turn?.steers.delete(p.item.clientId)) {
              const s = saved(req.threadId); if (s) save(req.threadId, { ...s, turns: s.turns + 1 });
              send({ t: "steer", id: p.item.clientId, text: (p.item.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") });
              afterTool = true;
              return;
            }
            if (m.method === "item/agentMessage/delta") {
              if (lastTextId && (afterTool || lastTextId !== p.itemId)) send({ t: "text", v: "\n\n" });
              afterTool = false;
              lastTextId = p.itemId; texts.set(p.itemId, (texts.get(p.itemId) ?? "") + p.delta);
              send({ t: "text", v: p.delta });
            } else if (m.method === "item/reasoning/summaryTextDelta" || m.method === "item/reasoning/textDelta") send({ t: "reasoning", v: p.delta });
            else if (m.method === "item/commandExecution/outputDelta" || m.method === "item/fileChange/outputDelta") {
              const out = (outputs.get(p.itemId) ?? "") + p.delta; outputs.set(p.itemId, out);
              send({ t: "tool", id: p.itemId, name: toolNames.get(p.itemId) ?? (m.method.includes("commandExecution") ? "bash" : "edit"), status: "running", output: out });
            } else if (m.method === "item/started" || m.method === "item/completed") {
              const done = m.method === "item/completed", item = p.item;
              if (!item) return;
              if (done && item.type === "agentMessage") {
                const prev = texts.get(item.id) ?? "";
                if (item.text?.startsWith(prev) && item.text.length > prev.length) {
                  if (!prev && lastTextId && lastTextId !== item.id) send({ t: "text", v: "\n\n" });
                  send({ t: "text", v: item.text.slice(prev.length) }); lastTextId = item.id;
                }
              }
              const e = toolEvent(item, done, outputs.get(item.id)); if (e) { toolNames.set(item.id, e.name); afterTool = true; send(e); }
            } else if (m.method === "turn/plan/updated") send({ t: "tool", id: `codex-plan-${p.turnId}`, name: "todo", args: { codex: p }, output: (p.plan ?? []).map((x: any) => `${x.status === "completed" ? "[x]" : x.status === "inProgress" ? "[~]" : "[ ]"} ${x.step}`).join("\n"), status: "done" });
            else if (m.method === "turn/diff/updated") send({ t: "tool", id: `codex-diff-${p.turnId}`, name: "edit", args: { codex: p }, status: "done", patch: p.diff });
            else if (m.method === "thread/tokenUsage/updated") {
              const t = p.tokenUsage?.total, last = p.tokenUsage?.last;
              if (t) {
                const delta = (k: keyof NonNullable<Saved["tokens"]>) => Math.max(0, (t[k] ?? 0) - (baseline?.[k] ?? 0));
                usage.cacheRead = delta("cachedInputTokens"); usage.cacheWrite = delta("cacheWriteInputTokens");
                usage.input = Math.max(0, delta("inputTokens") - usage.cacheRead - usage.cacheWrite); usage.output = delta("outputTokens");
                usage.contextTokens = last?.totalTokens; usage.contextWindow = p.tokenUsage.modelContextWindow ?? undefined;
                const s = saved(req.threadId); if (s) save(req.threadId, { ...s, tokens: t });
                send({ t: "usage", usage: { ...usage } });
              }
            } else if (m.method === "turn/completed" && (!turnId || turnId === p.turn?.id)) finish(p.turn);
            else if (m.method === "error" && !p.willRetry) fail(new Error(p.error?.message ?? "Codex turn failed"));
          });
          onAbort = () => {
            if (aborted) return; aborted = true;
            for (const id of [...l!.asks.keys()]) answer(req.threadId, id, { cancelled: true });
            if (turnId && !proc.exited) void proc.request("turn/interrupt", { threadId, turnId }, 10000).catch(() => proc.close());
            // Don't leave a worker indefinitely blocked if the server ignores interrupt.
            const timer = setTimeout(() => proc.close(new Error("Codex did not stop after interrupt")), 15000); timer.unref();
            completion.finally(() => clearTimeout(timer)).catch(() => {});
          };
          cancel = onAbort;
          signal.addEventListener("abort", onAbort, { once: true });
          // Reserve before writing: an ambiguous transport failure must never cause an automatic resend.
          save(req.threadId, { id: threadId, cwd: proc.cwd, turns: req.prior + 1, nativeTurns: nativeTurns + 1, tokens: baseline });
          const r = await proc.request("turn/start", { threadId, input: input(req.message, req.images), model: req.model.replace(/^codex\//, ""), serviceTier: req.speed ?? null, ...(req.effort ? { effort: req.effort === "off" ? "none" : req.effort } : {}), ...permissionParams(req.permission) }).catch((e) => {
            // An RPC rejection consumes the UI message, but not a native turn. A next new
            // message can continue; rewinding/retrying old UI messages remains unsupported.
            // Transport failures retain the reservation because acceptance is ambiguous.
            if (e instanceof CodexRpcError) save(req.threadId, { id: threadId, cwd: proc.cwd, turns: req.prior + 1, nativeTurns, tokens: baseline });
            throw e;
          });
          if (req.permission) l.permission = req.permission;
          turnId ??= r.turn?.id;
          if (!turnId) throw new Error("Codex did not return a turn id");
          l.turn = { thread: threadId, id: turnId, steers: new Set() };
          if (signal.aborted || aborted) { aborted = false; onAbort(); }
          const result = await completion;
          if (result.status === "failed") throw new Error(result.error?.message ?? "Codex turn failed");
          send({ t: "done", finish: signal.aborted || aborted || result.status === "interrupted" ? "aborted" : "stop", usage });
        } catch (e) {
          if (signal.aborted) send({ t: "done", finish: "aborted" });
          else send({ t: "error", message: e instanceof Error ? e.message : String(e) });
          if (owned && l) l.proc.close();
        } finally {
          off?.(); if (onAbort) signal.removeEventListener("abort", onAbort);
          if (owned && l) { for (const id of [...l.asks.keys()]) answer(req.threadId, id, { cancelled: true }); l.busy = false; l.emit = undefined; l.turn = undefined; l.proc.lastUsed = Date.now(); }
          send({ t: "end" }); if (!closed) { closed = true; controller.close(); }
        }
      })();
    },
    cancel() { cancel?.(); },
  });
}
