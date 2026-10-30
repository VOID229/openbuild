import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PiChatRequest, StreamEvent } from "../../shared/types";
import * as storage from "../storage";
import { cursorBin, cursorEnv, modelSlug, permissionArgs } from "./install";
import { CursorProtocol } from "./protocol";
import { createQuestions, QUESTION_PREFIX, type QuestionReply } from "./questions";
interface Saved { id: string; cwd: string; turns: number; pending: boolean; fingerprint?: string }
const key = (id: string) => `cursor-session:${id}`;
function saved(id: string): Saved | undefined {
  const raw = storage.getValue(key(id)); if (!raw) return;
  const s = JSON.parse(raw);
  if (!s || !/^[0-9a-f-]{36}$/i.test(s.id) || !Number.isInteger(s.turns) || s.turns < 0 || typeof s.cwd !== "string" || typeof s.pending !== "boolean") throw new Error("Invalid saved Cursor mapping; refusing to replace its history");
  return s;
}
function save(id: string, s: Saved) { storage.setValue(key(id), JSON.stringify(s)); }
const configDir = () => cursorEnv().CURSOR_CONFIG_DIR?.trim() || (process.env.XDG_CONFIG_HOME?.trim() ? join(process.env.XDG_CONFIG_HOME, "cursor") : join(homedir(), ".cursor"));
export const sessionDir = () => join(configDir(), "chats");
export function sessionPath(cwd: string, id: string) { return join(sessionDir(), createHash("md5").update(resolve(cwd)).digest("hex"), id, "store.db"); }
export function fingerprint(cwd: string, id: string): string {
  const path = sessionPath(cwd, id);
  if (!existsSync(path)) throw new Error("Cursor's saved chat is missing; refusing to start an empty replacement. Restore its native session or start a new thread.");
  const hash = createHash("sha256").update(readFileSync(path));
  // SQLite's WAL may contain committed history not yet checkpointed. Ignore SHM,
  // whose contents are merely process coordination, not conversation history.
  if (existsSync(path + "-wal")) { const wal = readFileSync(path + "-wal"); if (wal.length) hash.update(wal); }
  return hash.digest("hex");
}
interface Live { proc?: ReturnType<typeof Bun.spawn>; stop: () => void; questions?: ReturnType<typeof createQuestions> }
const hot = globalThis as typeof globalThis & { openbuildCursorLive?: Map<string, Live> };
const live = hot.openbuildCursorLive ??= new Map<string, Live>();
export const isSessionLive = (id: string) => live.has(id);
export const hasAsk = (threadId: string, askId: string) => !!live.get(threadId)?.questions?.hasAsk(askId);
export function answer(threadId: string, askId: string, reply: QuestionReply): boolean {
  return live.get(threadId)?.questions?.answer(askId, reply) ?? false;
}
export const canSteer = (id: string) => !!live.get(id)?.questions && live.get(id)?.proc?.exitCode === null;
export async function steer(id: string, steerId: string, message: string, images?: PiChatRequest["images"]): Promise<{ handled: boolean }> {
  if (images?.length) throw new Error("Cursor image attachments are not supported by this adapter");
  if (!canSteer(id)) throw new Error("Cursor isn't working on this thread");
  live.get(id)!.questions!.steer(steerId, message);
  return { handled: false };
}
export function release(id: string) { live.get(id)?.stop(); }
export function restartIdle() {} // Cursor is a one-shot process per turn; there are no idle children.
/** Escalation only after graceful SIGINT failed. Do not kill the worker's process
 * group: it also owns unrelated Pi/Codex turns. Descendants remain in that group
 * so the existing worker ownership fence can clean them up after a worker crash. */
function killTree(pid: number) {
  const ps = Bun.spawnSync(["ps", "-eo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
  if (ps.exitCode !== 0) return;
  const rows = ps.stdout.toString().trim().split("\n").map(s => s.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]); let changed = true;
  while (changed) { changed = false; for (const [child, parent] of rows) if (ids.has(parent!) && !ids.has(child!)) { ids.add(child!); changed = true; } }
  for (const id of [...ids].reverse()) try { process.kill(id, "SIGKILL"); } catch {}
}
export function runTurn(req: PiChatRequest, signal: AbortSignal): ReadableStream<Uint8Array> {
  let cancel = () => {};
  return new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (event: StreamEvent) => { if (!closed) try { controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n")); } catch { closed = true; cancel(); } };
      void (async () => {
        let owned = false, reserved = false, s: Saved | undefined;
        let p: ReturnType<typeof Bun.spawn> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
        let forced = false;
        let questions: ReturnType<typeof createQuestions> | undefined;
        try {
          if (signal.aborted) { send({ t: "done", finish: "aborted" }); return; }
          if (req.forkFrom) throw new Error("Cursor does not support forking through OpenBuild; start a new thread");
          if (req.images?.length) throw new Error("Cursor image attachments are not supported by this adapter");
          if (req.speed !== undefined) throw new Error("Cursor speed overrides are not supported; choose a listed Fast model instead");
          if (live.has(req.threadId)) throw new Error("Cursor thread is already running");
          s = saved(req.threadId);
          if (!Number.isInteger(req.prior) || req.prior !== (s?.turns ?? 0)) throw new Error("Cursor history mismatch: rewind, retry, or missing session history is not supported; old messages will not be resent");
          // Cursor hashes process.cwd(), which follows workspace symlinks.
          const cwd = realpathSync(resolve(req.cwd));
          if (s?.cwd && s.cwd !== cwd) throw new Error("Cursor thread workspace mismatch; cannot resume in another directory");
          if (s?.pending) throw new Error("Cursor's previous turn was interrupted or its outcome is uncertain. Check tool side effects and start a new thread; the prompt will not be replayed.");
          if (s && s.turns > 0 && (!s.fingerprint || fingerprint(cwd, s.id) !== s.fingerprint)) throw new Error("Cursor native history changed externally; refusing to append to divergent history. Start a new thread.");
          const l: Live = { stop: () => {
            questions?.stopSteering();
            questions?.close();
            if (!p || p.exitCode !== null) return;
            try { p.kill("SIGINT"); } catch {}
            if (!timer) { timer = setTimeout(() => { if (p && p.exitCode === null) { forced = true; killTree(p.pid); } }, 10000); timer.unref(); }
          } };
          live.set(req.threadId, l); owned = true; cancel = l.stop;
          signal.addEventListener("abort", cancel, { once: true });
          const slug = await modelSlug(req.model, req.effort);
          // Legacy clients send cursorAllowAllTools; both name the installed CLI's own flags.
          const permission = await permissionArgs(req.permission ?? (req.cursorAllowAllTools === true ? "force" : undefined));
          if (signal.aborted) { send({ t: "done", finish: "aborted" }); return; }
          if (!s) {
            // `create-chat` in CLI 2026.10.22 prints a UUID but never opens its
            // lazy store (and may not exit). Its intended contract is simply a
            // fresh UUID passed to --resume: initAndLoad creates the empty store.
            const id = crypto.randomUUID();
            s = { id, cwd, turns: 0, pending: false }; save(req.threadId, s);
          }
          if (signal.aborted) { send({ t: "done", finish: "aborted" }); return; }
          questions = createQuestions(send, () => { s = { ...s!, turns: s!.turns + 1 }; save(req.threadId, s); }); l.questions = questions;
          // Persist the identity and reservation BEFORE prompt submission. A worker crash
          // never permits a new process to accidentally resend an ambiguous prior prompt.
          s = { ...s, turns: req.prior + 1, pending: true }; save(req.threadId, s); reserved = true;
          const bin = cursorBin(); if (!bin) throw new Error("Cursor Agent executable disappeared");
          // Only an explicit per-turn user choice changes permissions. Otherwise preserve
          // Cursor's configured allowlist; print mode cannot relay approvals.
          // Deliberately omit --stream-partial-output: this CLI also emits accumulated
          // duplicate flushes, some indistinguishable from valid repeated text deltas.
          p = Bun.spawn([bin, "--print", "--output-format", "stream-json", "--trust", "--workspace", cwd, "--resume", s.id, "--model", slug, ...permission, "--plugin-dir", questions.pluginDir, "--", QUESTION_PREFIX + req.message], { cwd, env: cursorEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
          l.proc = p;
          if (signal.aborted) cancel();
          const protocol = new CursorProtocol(send);
          const stderr = new Response(p.stderr as ReadableStream).text();
          let parseError: unknown;
          try {
            let buffer = "";
            const decoder = new TextDecoder();
            const accept = (line: string) => { if (line.trim()) protocol.accept(JSON.parse(line)); };
            for await (const bytes of p.stdout as ReadableStream<Uint8Array>) {
              buffer += decoder.decode(bytes, { stream: true });
              if (buffer.length > 32 * 1024 * 1024) throw new Error("Cursor stream event exceeded 32 MiB");
              let end: number;
              while ((end = buffer.indexOf("\n")) >= 0) { accept(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
            }
            buffer += decoder.decode(); accept(buffer);
          } catch (e) { parseError = e; cancel(); }
          const [code, err] = await Promise.all([p.exited, stderr]);
          if (protocol.sessionId && protocol.sessionId !== s.id) throw new Error("Cursor resumed the wrong chat; refusing to replace the mapping");
          if (parseError) throw new Error(`Invalid Cursor stream: ${parseError instanceof Error ? parseError.message : String(parseError)}${err.trim() ? `\n${err.trim().slice(-8000)}` : ""}`);
          if (signal.aborted) {
            // SIGINT is handled by Cursor: it flushes/checkpoints then exits 130. A
            // hard kill cannot establish a safe history boundary and stays uncertain.
            if (!forced && (code === 130 || code === 0)) save(req.threadId, { ...s, pending: false, fingerprint: fingerprint(cwd, s.id) });
            send({ t: "done", finish: "aborted" }); return;
          }
          if (code !== 0) throw new Error(`Cursor Agent exited ${code}: ${err.trim().slice(-8000) || "no diagnostic output; check `cursor-agent status` and `cursor-agent models`"}`);
          if (!protocol.result || protocol.sessionId !== s.id) throw new Error("Cursor exited without a complete result for the saved chat; its turn will not be replayed");
          save(req.threadId, { ...s, pending: false, fingerprint: fingerprint(cwd, s.id) });
          send({ t: "done", finish: "stop", usage: protocol.usage });
        } catch (e) {
          // Retain pending on every ambiguous failure after submission. Errors before
          // reservation do not consume history and can safely be corrected/retried.
          if (signal.aborted) send({ t: "done", finish: "aborted" });
          else send({ t: "error", message: `${e instanceof Error ? e.message : String(e)}${reserved ? "\nThe turn may have changed files. Check side effects before starting a new thread." : ""}` });
        } finally {
          questions?.close();
          if (timer) clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          if (owned) live.delete(req.threadId);
          send({ t: "end" }); if (!closed) { closed = true; controller.close(); }
        }
      })();
    },
    cancel() { cancel(); },
  });
}
