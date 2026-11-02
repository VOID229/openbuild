// ACP runs inside the detached worker: server connections never own the agent's lifetime.
import { AcpProcess } from "../fx/acp";
import { hermesProgram } from "./install";
import * as storage from "../storage";
import { contentOf } from "../acpContent";
import type { PiChatRequest, StreamEvent } from "../../shared/types";
type Reply = { value?: string; confirmed?: boolean; cancelled?: boolean };
type Saved = { id: string; cwd: string; turns: number };
type Live = { proc: AcpProcess; ready: Promise<string>; busy: boolean; accepting?: boolean; emit?: (e: StreamEvent) => void; asks: Map<string, { rpc: number | string; options: any[] }>; steers: Map<string, { text: string; completion: Promise<void> }> };
const live = new Map<string, Live>();
const key = (id: string) => `hermes-session:${id}`;
const saved = (id: string): Saved | undefined => { const raw = storage.getValue(key(id)); if (!raw) return; const s = JSON.parse(raw); if (!s.id || !s.cwd || typeof s.turns !== "number") throw new Error("Invalid Hermes session mapping"); return s; };
const save = (id: string, s: Saved) => storage.setValue(key(id), JSON.stringify(s));
function ensure(id: string, cwd: string) {
  const old = live.get(id);
  if (old && !old.proc.exited && old.proc.cwd === cwd) return old;
  if (old?.busy) throw new Error("Hermes is busy in another workspace");
  release(id);
  const proc = new AcpProcess(cwd, hermesProgram());
  const l: Live = { proc, ready: Promise.resolve(""), busy: false, asks: new Map(), steers: new Map() };
  proc.on(m => {
    if (m.id === undefined || m.method !== "session/request_permission") return;
    const options = m.params?.options ?? [], askId = `hermes-${m.id}`;
    l.asks.set(askId, { rpc: m.id, options });
    l.emit?.({ t: "ask", id: askId, method: "select", title: m.params?.toolCall?.title ?? "Allow Hermes to run this tool?", options: options.map((o: any) => o.name) });
  });
  l.ready = (async () => {
    await proc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const s = saved(id);
    if (s) {
      if (s.cwd !== cwd) throw new Error("Hermes session belongs to another workspace");
      await proc.request("session/load", { sessionId: s.id, cwd, mcpServers: [] }, 60000);
      return s.id;
    }
    const r = await proc.request<any>("session/new", { cwd, mcpServers: [] }, 60000);
    save(id, { id: r.sessionId, cwd, turns: 0 }); return r.sessionId;
  })();
  l.ready.catch(() => {}); live.set(id, l); return l;
}
export const isSessionLive = (id: string) => !!live.get(id) && !live.get(id)!.proc.exited;
export const canSteer = (id: string) => !!live.get(id)?.accepting;
export const hasAsk = (id: string, ask: string) => !!live.get(id)?.asks.has(ask);
export function answer(id: string, ask: string, reply: Reply) {
  const l = live.get(id), q = l?.asks.get(ask); if (!l || !q) return false;
  const option = reply.cancelled ? undefined : q.options.find(o => o.name === reply.value) ?? (reply.confirmed ? q.options.find(o => o.kind?.startsWith("allow")) : undefined);
  l.proc.respond(q.rpc, { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } });
  l.asks.delete(ask); l.emit?.({ t: "asked", id: ask, answer: option?.name }); return true;
}
export async function steer(id: string, steerId: string, text: string, images?: PiChatRequest["images"]) {
  const l = live.get(id); if (!l?.accepting) throw new Error("Hermes isn't working on this thread");
  if (!text.trim() || images?.length) throw new Error("Hermes steering requires text; queue images as a follow-up");
  const old = l.steers.get(steerId); if (old) { if (old.text !== text) throw new Error("Steering ID reused"); return { handled: false }; }
  const sessionId = await l.ready;
  const completion = l.proc.request<any>("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 0).then(r => {
    if (r.stopReason !== "end_turn") throw new Error("Hermes did not accept the correction");
    const s = saved(id); if (s) save(id, { ...s, turns: s.turns + 1 });
    l.emit?.({ t: "steer", id: steerId, text });
  }).catch(e => { l.emit?.({ t: "notice", message: `Hermes steering: ${e.message}` }); });
  l.steers.set(steerId, { text, completion }); return { handled: false };
}
export function release(id: string) { const l = live.get(id); if (l) { l.accepting = false; for (const ask of l.asks.keys()) answer(id, ask, { cancelled: true }); l.proc.close(); } live.delete(id); }
export function restartIdle() { for (const [id, l] of live) if (!l.busy) release(id); }
const reaper = setInterval(() => { for (const [id, l] of live) if (!l.busy && (l.proc.exited || Date.now() - l.proc.lastUsed > 1200000)) release(id); }, 60000); reaper.unref();
export function runTurn(req: PiChatRequest, signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({ async start(controller) {
    const enc = new TextEncoder(); let closed = false;
    const send = (e: StreamEvent) => { if (!closed) controller.enqueue(enc.encode(JSON.stringify(e) + "\n")); };
    let acquired = false;
    let l: Live | undefined, off: (() => void) | undefined, abort: (() => void) | undefined;
    const tools = new Map<string, { name: string; args: Record<string, unknown>; at: number }>();
    try {
      if (signal.aborted) { send({ t: "done", finish: "aborted" }); return; }
      l = ensure(req.threadId, req.cwd); if (l.busy) throw new Error("Hermes is still working on the previous message");
      l.busy = true; acquired = true; l.emit = send; l.steers.clear();
      const sessionId = await l.ready;
      if (signal.aborted) { send({ t: "done", finish: "aborted" }); return; }
      await l.proc.request("session/set_model", { sessionId, modelId: req.model.replace(/^hermes\//, "") }, 60000);
      off = l.proc.on(m => {
        if (m.method !== "session/update" || m.params?.sessionId !== sessionId) return;
        const u = m.params.update;
        if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") {
          if (u.content?.type === "text") send({ t: u.sessionUpdate === "agent_thought_chunk" ? "reasoning" : "text", v: u.content.text });
        } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
          const id = u.toolCallId, prior = tools.get(id);
          const display = contentOf(u.content ?? [], req.cwd);
          const raw = u.rawInput ?? (u.kind === "execute" && display.text.startsWith("$ ") ? { command: display.text.slice(2) } : {});
          if (u.locations?.[0]?.path && !raw.path) raw.path = u.locations[0].path;
          const name = prior?.name ?? ({ execute: "bash", read: "read", edit: "edit", search: "grep", fetch: "fetch" }[u.kind as string] ?? u.title ?? "tool");
          const args = u.rawInput || !prior ? raw : prior.args;
          const t = { name, args, at: prior?.at ?? Date.now() }; tools.set(id, t);
          send({ t: "tool", id, name, args, status: u.status === "failed" ? "error" : u.status === "completed" ? "done" : "running", output: display.text.slice(0, 12000), patch: display.patch, ms: Date.now() - t.at });
        }
      });
      abort = () => { for (const ask of l!.asks.keys()) answer(req.threadId, ask, { cancelled: true }); l!.proc.notify("session/cancel", { sessionId }); };
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      const s = saved(req.threadId)!;
      if (req.prior < s.turns) send({ t: "notice", message: "Hermes retains earlier messages in its session context." });
      save(req.threadId, { ...s, turns: s.turns + 1 });
      const prompt: any[] = (req.images ?? []).map(i => ({ type: "image", data: i.data, mimeType: i.mimeType })); prompt.push({ type: "text", text: req.message });
      l.accepting = true;
      const r = await l.proc.request<any>("session/prompt", { sessionId, prompt }, 0);
      l.accepting = false;
      await Promise.all([...l.steers.values()].map(s => s.completion));
      send({ t: "done", finish: signal.aborted || r.stopReason === "cancelled" ? "aborted" : r.stopReason === "max_tokens" ? "length" : r.stopReason === "refusal" ? "refusal" : "stop" });
    } catch (e) { send(signal.aborted ? { t: "done", finish: "aborted" } : { t: "error", message: (e as Error).message }); }
    finally { off?.(); if (abort) signal.removeEventListener("abort", abort); if (l && acquired) { l.accepting = false; for (const ask of l.asks.keys()) answer(req.threadId, ask, { cancelled: true }); l.busy = false; l.emit = undefined; l.proc.lastUsed = Date.now(); } send({ t: "end" }); closed = true; controller.close(); }
  } });
}
