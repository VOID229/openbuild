import { resolve } from "node:path";
import type { PiChatRequest, StreamEvent, Usage } from "../../shared/types";
import * as storage from "../storage";
import { workerConnection, locationQuery, type Connection, type NativeEvent } from "./connection";
import { toolEvent, type NativeTool } from "./tools";
interface Saved { id: string; cwd: string; turns: number; pending?: boolean }
const key = (id: string) => `opencode-session:${id}`;
function saved(id: string): Saved | undefined {
  const raw = storage.getValue(key(id)); if (!raw) return;
  const s = JSON.parse(raw);
  if (!s || typeof s.id !== "string" || !s.id || typeof s.cwd !== "string" || !Number.isInteger(s.turns) || s.turns < 0) throw new Error("Invalid OpenCode session mapping; refusing to replace history");
  return s;
}
const save = (id: string, s: Saved) => storage.setValue(key(id), JSON.stringify(s));
type Reply = { value?: string; confirmed?: boolean; cancelled?: boolean };
type Ask = Extract<StreamEvent, { t: "ask" }>;
interface Live { busy: boolean; connection?: Connection; emit: (e: StreamEvent) => void; asks: Map<string, { ask: Ask; reply: (r: Reply) => void }>; abort: () => void }
const live = new Map<string, Live>();
export const isSessionLive = (id: string) => !!live.get(id)?.connection?.alive;
export const hasAsk = (id: string, askId: string) => !!live.get(id)?.asks.has(askId);
export function answer(id: string, askId: string, reply: Reply): boolean {
  const l = live.get(id), p = l?.asks.get(askId); if (!l || !p) return false;
  l.asks.delete(askId); l.emit({ t: "asked", id: askId, answer: reply.cancelled ? undefined : reply.value ?? (reply.confirmed ? "Allow once" : undefined) }); p.reply(reply); return true;
}
export function release(id: string) { const l = live.get(id); if (!l) return; if (l.busy) l.abort(); else live.delete(id); }
export function restartIdle() { for (const [id, l] of live) if (!l.busy) live.delete(id); }
function question(l: Live, a: Omit<Ask, "t" | "id">, signal: AbortSignal): Promise<Reply> {
  if (signal.aborted) return Promise.resolve({ cancelled: true });
  return new Promise((resolve) => {
    const id = `opencode-ask-${crypto.randomUUID()}`, ask: Ask = { t: "ask", id, ...a };
    const abort = () => { if (l.asks.delete(id)) { l.emit({ t: "asked", id }); finish({ cancelled: true }); } };
    const finish = (r: Reply) => { signal.removeEventListener("abort", abort); resolve(r); };
    l.asks.set(id, { ask, reply: finish }); signal.addEventListener("abort", abort, { once: true }); l.emit(ask);
  });
}
// OpenCode 2's prompt schema has no system/instructions field. Scope client guidance to
// this submitted message; don't change workspace config or load a Pi extension.
export const questionPrompt = (message: string) => `<openbuild-question-instructions>\nWhen you need a decision, clarification, or missing information from the user to proceed, use the native question tool (which creates a form) instead of asking in prose. Use simple string fields with single-choice options and custom answers enabled, or a plain string field for free text. Ask multiple questions as separate simple fields, not multiselect, conditional, hidden, or constrained fields. Offer concrete choices when useful. Wait for the form response before continuing; never invent the user's answer. If the user cancels, do not assume an answer or immediately ask again.\n</openbuild-question-instructions>\n\n${message}`;

const sessionPath = (id: string) => `/api/session/${encodeURIComponent(id)}`;
async function verifyHistory(c: Connection, s: Saved) {
  if (s.pending) throw new Error("OpenCode has an unfinished or ambiguous turn; refusing to resend or continue it");
  const active = await c.request("/api/session/active");
  if (!active?.data || typeof active.data !== "object") throw new Error("Invalid OpenCode active sessions response");
  if (active.data[s.id]) throw new Error("OpenCode native session is already running; refusing to steer it");
  const info = (await c.request(sessionPath(s.id))).data;
  if (info?.id !== s.id || info.location?.directory !== s.cwd || info.revert || info.fork) throw new Error("OpenCode native history/workspace mismatch; refusing to replay prompts");
  let cursor: string | undefined; const seen = new Set<string>(); let count = 0;
  do {
    const r = await c.request(`${sessionPath(s.id)}/message?type=user&limit=100&${cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=asc"}`);
    if (!Array.isArray(r.data)) throw new Error("Invalid OpenCode message history");
    count += r.data.filter((m: any) => m.type === "user").length;
    cursor = r.cursor?.next ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error("OpenCode repeated history cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  if (count !== s.turns) throw new Error("OpenCode native history mismatch; old prompts will not be replayed");
}
async function selectedModel(c: Connection, req: PiChatRequest) {
  const match = /^opencode\/([^/]+)\/(.+)$/.exec(req.model);
  if (!match) throw new Error("Expected model opencode/<provider>/<id>");
  const r = await c.request(`/api/model?${locationQuery(resolve(req.cwd))}`);
  const m = r.data?.find((m: any) => m.providerID === match[1] && m.id === match[2] && m.enabled);
  if (!m) throw new Error("OpenCode model is not enabled in this workspace");
  const variants = (m.variants ?? []).map((v: any) => v.id);
  // Effort is a native variant only when actually advertised; off is the UI default, not a fabricated variant.
  if (req.effort && req.effort !== "off" && !variants.includes(req.effort)) throw new Error(`OpenCode model does not offer variant ${req.effort}`);
  return { providerID: m.providerID, id: m.id, ...(variants.includes(req.effort) ? { variant: req.effort } : {}) };
}
function unsupportedField(f: any) {
  return !["string", "number", "integer", "boolean"].includes(f.type) || f.hidden || f.when?.length || f.format || f.pattern || f.minLength !== undefined || f.maxLength !== undefined || f.minimum !== undefined || f.maximum !== undefined;
}
async function handleForm(c: Connection, l: Live, form: any, signal: AbortSignal) {
  const path = `${sessionPath(form.sessionID)}/form/${encodeURIComponent(form.id)}`;
  if (!Array.isArray(form.fields) || !form.fields.length || form.fields.some(unsupportedField)) {
    l.emit({ t: "error", message: "OpenCode requested an unsupported complex form; cancelled it. Answer in the native client or ask for a simple question." });
    await c.request(path, "DELETE"); return;
  }
  const answer: Record<string, unknown> = {};
  for (const f of form.fields) {
    const options: string[] | undefined = f.type === "boolean" ? ["Yes", "No"] : f.options?.map((o: any) => o.label);
    const r = await question(l, { method: options?.length ? "select" : "input", title: f.title ?? form.title ?? f.key, message: f.description, options, other: f.custom === true, placeholder: f.placeholder, prefill: f.default === undefined ? undefined : String(f.default) }, signal);
    if (r.cancelled || signal.aborted) { await c.request(path, "DELETE"); return; }
    let value: unknown = r.value ?? "";
    if (f.type === "boolean") { if (!["Yes", "No"].includes(String(value))) throw new Error("Invalid boolean form answer"); value = value === "Yes"; }
    else if (f.type === "number" || f.type === "integer") { value = Number(value); if (!String(r.value ?? "").trim() || !Number.isFinite(value) || (f.type === "integer" && !Number.isInteger(value))) throw new Error("Invalid numeric form answer"); }
    else if (f.options?.length) { const option = f.options.find((o: any) => o.label === value); if (option) value = option.value; else if (!f.custom) throw new Error("Invalid form selection"); }
    answer[f.key] = value;
  }
  await c.request(path + "/reply", "POST", { answer });
}
export function runTurn(req: PiChatRequest, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder(); const local = new AbortController();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: StreamEvent) => { if (!closed) try { controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); } catch { closed = true; local.abort(); } };
      void (async () => {
        let l: Live | undefined, owned = false, off: (() => void) | undefined, stopAbort: (() => void) | undefined;
        const askStop = new AbortController();
        const streamStop = new AbortController();
        const aborted = AbortSignal.any([signal, local.signal]);
        try {
          if (aborted.aborted) { send({ t: "done", finish: "aborted" }); return; }
          if (req.forkFrom) throw new Error("OpenCode forks are unsupported; start a new thread");
          if (req.permission) throw new Error("OpenCode uses native permission policy; permission overrides are unsupported");
          if (live.get(req.threadId)?.busy) throw new Error("OpenCode thread is already running");
          let s = saved(req.threadId);
          if (!Number.isInteger(req.prior) || req.prior !== (s?.turns ?? 0)) throw new Error("OpenCode history mismatch; retry/rewind/missing history is unsupported and prompts will not be replayed");
          if (s && s.cwd !== resolve(req.cwd)) throw new Error("OpenCode thread workspace mismatch");
          l = { busy: true, emit: send, asks: new Map(), abort: () => local.abort() }; live.set(req.threadId, l); owned = true;
          const c = await workerConnection(); l.connection = c;
          if (!c.alive) throw new Error("OpenCode server exited; prompt will not be resent");
          const model = await selectedModel(c, req);
          if (s) { await verifyHistory(c, s); await c.request(`${sessionPath(s.id)}/model`, "POST", { model }, aborted); }
          else {
            const created = await c.request("/api/session", "POST", { location: { directory: resolve(req.cwd) }, model }, aborted);
            if (!created.data?.id) throw new Error("OpenCode did not return a session id");
            s = { id: created.data.id, cwd: resolve(req.cwd), turns: 0 }; save(req.threadId, s);
          }
          const state = s; const root = state.id;
          const children = new Set<string>(); const tools = new Map<string, NativeTool>(); const texts = new Map<string, string>(); let lastText: string | undefined;
          const usage: Usage = {}; let submitted = false, terminal = false, definitive = false;
          let finish!: (value: string) => void, fail!: (e: Error) => void;
          const completion = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; }); completion.catch(() => {});
          const end = (value: string) => { if (!terminal) { terminal = true; finish(value); } };
          const failure = (e: unknown) => { if (!terminal) { terminal = true; fail(e instanceof Error ? e : new Error(String(e))); } };
          const current = l;
          const tasks = new Set<string>();
          const event = ({ type, data: d }: NativeEvent) => {
            if (terminal) return;
            if (type === "session.created") { const child = d.session ?? d; if (child.parentID === root || children.has(child.parentID)) children.add(child.sessionID ?? child.id); }
            const sid = d.sessionID ?? d.form?.sessionID;
            const child = children.has(sid);
            if (sid !== root && !child) return;
            if (type === "permission.asked") {
              const k = `permission:${d.id}`; if (tasks.has(k)) return; tasks.add(k);
              void (async () => { const r = await question(current, { method: "select", title: `Allow OpenCode ${d.action}?`, message: JSON.stringify(d.resources ?? []), options: ["Allow once", "Deny"] }, askStop.signal); await c.request(`${sessionPath(sid)}/permission/${encodeURIComponent(d.id)}/reply`, "POST", { decision: !r.cancelled && (r.confirmed || r.value === "Allow once") ? "once" : "reject" }); })().catch(failure); return;
            }
            if (type === "form.created") { const form = d.form; if (!form?.id) { failure(new Error("Invalid OpenCode form")); return; } const k = `form:${form.id}`; if (tasks.has(k)) return; tasks.add(k); void handleForm(c, current, form, askStop.signal).catch(async (e) => { await c.request(`${sessionPath(sid)}/form/${encodeURIComponent(form.id)}`, "DELETE").catch(() => {}); failure(e); }); return; }
            if (type.startsWith("session.tool.")) {
              const id = child ? `${sid}:${d.id}` : d.id;
              let tool = tools.get(id);
              if (type === "session.tool.input.started") { tool = { name: d.name }; tools.set(id, tool); }
              if (!tool) { tool = { name: d.name ?? "tool" }; tools.set(id, tool); }
              if (d.input !== undefined) tool.input = d.input;
              if (d.metadata) tool.metadata = { ...tool.metadata, ...d.metadata };
              const e = toolEvent(id, tool, type.endsWith(".failed") ? "error" : type.endsWith(".success") ? "done" : "running", d);
              if (child) e.args = { ...e.args, agentThreadId: sid };
              send(e); return;
            }
            if (child) return; // Child text/usage/completion cannot finish or overwrite the root.
            if (!submitted) return;
            if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(type)) {
              const kind = type.startsWith("session.text.") ? "text" : "reasoning";
              const id = `${kind}:${d.assistantMessageID}:${d.ordinal}`; const previous = texts.get(id) ?? "";
              let next = previous;
              if (typeof d.delta === "string") next += d.delta;
              else if (typeof d.text === "string") { if (!d.text.startsWith(previous)) { failure(new Error("OpenCode final text diverged from streamed text")); return; } next = d.text; }
              const delta = next.slice(previous.length); texts.set(id, next);
              if (delta) { if (kind === "text" && lastText && lastText !== id) send({ t: "text", v: "\n\n" }); if (kind === "text") lastText = id; send({ t: kind, v: delta }); }
            } else if (type === "session.step.ended") {
              const t = d.tokens; if (!t) return;
              usage.input = (usage.input ?? 0) + (t.input ?? 0); usage.output = (usage.output ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0);
              usage.cacheRead = (usage.cacheRead ?? 0) + (t.cache?.read ?? 0); usage.cacheWrite = (usage.cacheWrite ?? 0) + (t.cache?.write ?? 0); if (typeof d.cost === "number") usage.cost = (usage.cost ?? 0) + d.cost;
              send({ t: "usage", usage: { ...usage } });
            } else if (type === "session.execution.succeeded") { definitive = true; end("stop"); }
            else if (type === "session.execution.interrupted") { definitive = true; end("aborted"); }
            else if (type === "session.execution.failed") { definitive = true; failure(new Error(d.error?.message ?? "OpenCode execution failed")); }
          };
          off = await c.subscribe(event, failure, streamStop.signal);
          let abortTimer: ReturnType<typeof setTimeout> | undefined;
          const interrupt = () => {
            askStop.abort();
            abortTimer ??= setTimeout(() => failure(new Error("OpenCode interrupt timed out; native turn may still be running")), 10_000);
            if (!submitted) end("aborted");
            else void c.request(`${sessionPath(root)}/interrupt`, "POST").catch(failure);
          };
          stopAbort = () => { aborted.removeEventListener("abort", interrupt); clearTimeout(abortTimer); };
          aborted.addEventListener("abort", interrupt, { once: true });
          if (aborted.aborted) interrupt();
          if (!terminal) {
            // Reserve BEFORE sending. Ambiguous acceptance/SSE loss must never cause a replay.
            save(req.threadId, { ...state, turns: req.prior + 1, pending: true }); submitted = true;
            try {
              await c.request(`${sessionPath(root)}/prompt`, "POST", { text: questionPrompt(req.message), ...(req.images?.length ? { files: req.images.map((i) => ({ uri: `data:${i.mimeType};base64,${i.data}` })) } : {}) });
            } catch (error) {
              // A native terminal event is stronger evidence than a lost prompt HTTP reply.
              // Still settle through completion below so a confirmed Stop isn't left pending.
              if (!definitive) throw error;
            }
          }
          let result: string;
          try { result = await completion; }
          finally { if (submitted && definitive) save(req.threadId, { ...state, turns: req.prior + 1, pending: false }); }
          send({ t: "done", finish: result, usage });
        } catch (e) { send({ t: "error", message: e instanceof Error ? e.message : String(e) }); }
        finally {
          stopAbort?.(); askStop.abort(); streamStop.abort(); off?.();
          if (owned && l) { l.busy = false; l.emit = () => {}; l.asks.clear(); }
          send({ t: "end" }); if (!closed) { closed = true; controller.close(); }
        }
      })();
    },
    cancel() { local.abort(); },
  });
}
