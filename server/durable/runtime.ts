/**
 * The Durable runtime itself. It owns the worker's storage, so exactly one process may run it for a
 * given data directory: `worker.ts` does, and the server talks to that process (see `remote.ts`).
 * Tests use it directly.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { Harness, createRegistry, type Conversation, type EntryRecord, type WatchHandle } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { durableCodingTools } from "./tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { PiChatRequest, StreamEvent, Usage } from "../../shared/types";
import { Run } from "../runs";
import { dataDir } from "../paths";
import { agentDir, packageRoot } from "../pi/install";
import { addUsage } from "../pi/usage";

interface Manifest {
  version: 1;
  id: string;
  request: PiChatRequest;
  /** IDs preceding admission, not offsets into the active (possibly compacted) transcript. */
  baseline: EntryRecord["id"][];
  seen: EntryRecord["id"][];
  events: StreamEvent[];
  ended: boolean;
  /** True once `root.submit()` committed: the input may be in the transcript, so replay stays possible. */
  submitted?: boolean;
  usage?: Usage;
  stopping?: boolean;
}
interface Thread {
  harness: Harness;
  root: Conversation;
}
export class DurableUnsupportedError extends Error {
  readonly status = 409;
  constructor(message: string, readonly code: "busy" | "unsupported" = "unsupported") { super(message); }
}
const key = (id: string) => createHash("sha256").update(id).digest("hex");

/** Atomic replacement plus file AND parent-directory fsync; no acknowledged admission is memory-only. */
function save(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const dir = openSync(join(file, ".."), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

/** Host-owned Run-compatible replay. Client cancellation never propagates into the Harness. */
export class DurableRun extends Run {
  constructor(readonly id: string, readonly threadId: string, private cancelRun: () => Promise<unknown>) { super(); }
  override stop() { void this.cancelRun().catch(console.error); }
}

/** Injectable Models are used by offline recovery tests; production uses Pi's configured ModelRuntime. */
export class DurableRuntime {
  private runs = new Map<string, DurableRun>();
  private manifests = new Map<string, Manifest>();
  private threads = new Map<string, Promise<Thread>>();
  private watches = new Set<WatchHandle<unknown>>();
  private tails = new Map<string, Promise<unknown>>();
  private models?: Promise<Models>;
  private driving = new Map<string, Promise<DurableRun>>();
  private recoveryErrors = new Map<string, unknown>();
  private manifestErrors = new Map<string, unknown>();
  private retryAt = new Map<string, number>();
  private closed = false;
  private recovering?: Promise<void>;
  constructor(readonly directory = join(dataDir(), "durable"), private suppliedModels?: Models, private options: { bashTimeoutSeconds?: number } = {}) {}

  private file(id: string) { return join(this.directory, "runs", `${key(id)}.json`); }
  private persist(m: Manifest) { save(this.file(m.id), m); }
  private tombstone(threadId: string) { return join(this.directory, "deleted", `${key(threadId)}.json`); }
  private deleted(threadId: string) { return existsSync(this.tombstone(threadId)); }
  private retire(m: Manifest) {
    const run = this.handle(m);
    m.stopping = true;
    m.ended = true;
    m.events.push({ t: "done", finish: "aborted" });
    this.persist(m);
    for (const event of m.events.slice(run.events.length)) run.push(event);
    run.end();
    this.recoveryErrors.delete(m.id);
  }
  /**
   * Admission failed before the input could have entered the transcript: nothing was submitted, so
   * terminalize the manifest instead of leaving the thread permanently "still working".
   */
  private fail(m: Manifest, error: unknown) {
    if (m.ended) return;
    const run = this.handle(m);
    const message = error instanceof Error ? error.message : String(error);
    m.stopping = true;
    m.ended = true;
    m.events.push({ t: "error", message }, { t: "done", finish: "error" });
    this.persist(m);
    for (const event of m.events.slice(run.events.length)) run.push(event);
    run.end();
    this.recoveryErrors.delete(m.id);
  }
  /** Drive a newly admitted run, terminalizing it when it failed before submit. */
  private async admit(m: Manifest): Promise<DurableRun> {
    try {
      return await this.drive(m);
    } catch (error) {
      // Never terminalize after submit: upstream's requestId dedupe makes that replay safe, while a
      // pre-submit failure has no side effects and would otherwise wedge every later turn.
      if (!m.submitted) this.fail(m, error);
      throw error;
    }
  }
  private load() {
    const path = join(this.directory, "runs");
    if (!existsSync(path)) return;
    for (const name of readdirSync(path)) {
      if (!name.endsWith(".json")) continue;
      try {
        const m = JSON.parse(readFileSync(join(path, name), "utf8")) as Manifest;
        if (m.version !== 1 || typeof m.id !== "string" || key(m.id) + ".json" !== name ||
            !m.request || typeof m.request.threadId !== "string" ||
            !Array.isArray(m.events) || !Array.isArray(m.baseline) || !Array.isArray(m.seen) || typeof m.ended !== "boolean") {
          throw new Error(`Invalid durable manifest: ${name}`);
        }
        if (!this.manifests.has(m.id)) this.manifests.set(m.id, m);
      } catch (error) {
        this.manifestErrors.set(name, error);
        console.error("[durable] Cannot read run manifest", name, error);
      }
    }
  }
  private getModels(): Promise<Models> {
    if (this.models) return this.models;
    const pending = (async () => {
      if (this.suppliedModels) return this.suppliedModels;
      const root = packageRoot();
      if (!root) throw new Error("Durable runtime needs an installed Pi 1.4-compatible ModelRuntime (configure credentials in Pi first).");
      const { ModelRuntime } = await import(pathToFileURL(join(root, "dist", "core", "model-runtime.js")).href);
      return ModelRuntime.create({ authPath: join(agentDir(), "auth.json"), modelsPath: join(agentDir(), "models.json"), allowModelNetwork: false });
    })();
    this.models = pending;
    pending.catch(() => { if (this.models === pending) this.models = undefined; });
    return pending;
  }
  private thread(id: string): Promise<Thread> {
    let pending = this.threads.get(id);
    if (!pending) {
      pending = (async () => {
        const models = await this.getModels();
        const registry = createRegistry();
        registry.install(durableCodingTools(this.options.bashTimeoutSeconds));
        const storage = await openNodeJsonlStorage(join(this.directory, "threads", key(id)), context, { fsync: true });
        const harness = await Harness.open(storage, { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) }, context);
        return { harness, root: await harness.root(context) };
      })();
      this.threads.set(id, pending);
      pending.catch(() => this.threads.delete(id));
    }
    return pending;
  }
  /** Serialize admission with recovery and all other requests on the same thread. */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.tails.set(id, next);
    return next;
  }
  private handle(m: Manifest): DurableRun {
    let run = this.runs.get(m.id);
    if (!run) {
      run = new DurableRun(m.id, m.request.threadId, () => this.stopRun(m.id));
      for (const e of m.events) run.push(e);
      if (m.ended) run.end();
      this.runs.set(m.id, run);
    }
    return run;
  }
  private emit(m: Manifest, events: StreamEvent[], seen?: EntryRecord["id"]) {
    m.events.push(...events);
    if (seen) m.seen.push(seen);
    this.persist(m); // publish only AFTER durable projection commit
    const run = this.handle(m);
    // handle() may have just hydrated the full log.
    for (const event of m.events.slice(run.events.length)) run.push(event);
  }
  private project(m: Manifest, entries: readonly EntryRecord[]) {
    const skip = new Set([...m.baseline, ...m.seen]);
    for (const entry of entries) {
      if (skip.has(entry.id)) continue;
      const events: StreamEvent[] = [];
      for (const message of entry.model ?? []) {
        if (message.role === "assistant") {
          // Provider-reported tokens for the latest request/answer, including cached context.
          addUsage(m.usage ??= {}, message.usage);
          if (message.usage) events.push({ t: "usage", usage: { ...m.usage } });
          for (const block of message.content) {
            if (block.type === "text" && block.text) events.push({ t: "text", v: block.text });
            else if (block.type === "thinking" && block.thinking) events.push({ t: "reasoning", v: block.thinking });
            else if (block.type === "toolCall") events.push({ t: "tool", id: block.id, name: block.name, args: block.arguments, status: "running" });
          }
          if (message.stopReason === "error") events.push({ t: "error", message: message.errorMessage ?? "Model failed" });
        } else if (message.role === "toolResult") {
          events.push({ t: "tool", id: message.toolCallId, name: message.toolName, status: message.isError ? "error" : "done", output: message.content.filter(b => b.type === "text").map(b => b.text).join("\n") });
        }
      }
      this.emit(m, events, entry.id);
      skip.add(entry.id);
    }
  }
  private drive(m: Manifest): Promise<DurableRun> {
    let pending = this.driving.get(m.id);
    if (!pending) {
      pending = this.driveImpl(m);
      this.driving.set(m.id, pending);
      pending.then(() => this.recoveryErrors.delete(m.id), () => this.driving.delete(m.id));
    }
    return pending;
  }
  private async driveImpl(m: Manifest) {
    const run = this.handle(m);
    const { harness, root } = await this.thread(m.request.threadId);
    const at = m.request.model.indexOf("/");
    if (at < 1) throw new Error("Expected model provider/model-id");
    const selected = (await this.getModels()).getModel(m.request.model.slice(0, at), m.request.model.slice(at + 1));
    (m.usage ??= {}).contextWindow = selected?.contextWindow;
    await root.configure({ model: { provider: m.request.model.slice(0, at), modelId: m.request.model.slice(at + 1) }, thinkingLevel: m.request.effort, cwd: m.request.cwd }, context);
    const watch = await root.watch(context);
    this.watches.add(watch as WatchHandle<unknown>);
    this.project(m, watch.value.entries);
    watch.start(async value => { if (!m.ended) this.project(m, value.entries); });
    const content = m.request.images?.length
      ? [{ type: "text" as const, text: m.request.message }, ...m.request.images.map(i => ({ type: "image" as const, ...i }))]
      : m.request.message;
    // The manifest exists before submit. Retrying after either side of this await is safe.
    const submission = await root.submit({ type: "input", content, requestId: m.id, whenBusy: "reject" }, context);
    // Persist "may have been submitted" before anything else can fail: from here on, recovery must
    // replay instead of terminalizing, and upstream dedupes the requestId.
    m.submitted = true;
    this.persist(m);
    harness.resume();
    if (m.stopping) await root.abort(context);
    void (async () => {
      try {
        const result = await submission.wait(context);
        if (m.ended) return;
        // Acquire a fresh snapshot after wait: the asynchronous watch may not yet have delivered the answer.
        const final = await root.watch(context);
        if (m.ended) { await final.stop(); return; }
        this.project(m, final.value.entries);
        await final.stop();
        if (m.ended) return;
        if (result.status === "unanswered" && !m.stopping) m.events.push({ t: "error", message: `Durable submission unanswered: ${result.reason}` });
        m.events.push({ t: "done", finish: m.stopping ? "aborted" : result.status, usage: m.usage });
        m.ended = true;
        this.persist(m);
        for (const event of m.events.slice(run.events.length)) run.push(event);
        run.end();
      } catch (error) {
        // Close/crash is NOT a terminal run. Leave metadata pending for automatic recovery.
        if (!this.closed) console.error("Durable run paused; reopen to recover", m.id, error);
      } finally {
        await watch.stop();
        this.watches.delete(watch as WatchHandle<unknown>);
      }
    })();
    return run;
  }
  async recover(): Promise<void> {
    return this.recovering ??= (async () => {
      this.load();
      for (const m of this.manifests.values()) {
        this.handle(m);
        if (!m.ended && this.deleted(m.request.threadId)) this.retire(m);
        if (!m.ended) {
          try {
            await this.serial(m.request.threadId, () => this.drive(m));
            this.recoveryErrors.delete(m.id);
          } catch (error) {
            // One broken workspace/model/storage must not strand unrelated threads at startup.
            this.recoveryErrors.set(m.id, error);
            this.retryAt.set(m.id, Date.now() + 5_000);
            console.error("[durable] Startup recovery failed for run", m.id, error);
          }
        }
      }
    })().catch(error => { this.recovering = undefined; throw error; });
  }
  async startRun(req: PiChatRequest): Promise<DurableRun> {
    // HTTP JSON can carry extra properties despite its TypeScript type. Never persist auth/key
    // fields supplied by a caller; credentials belong exclusively to Pi's live credential store.
    req = {
      threadId: req.threadId, cwd: req.cwd, model: req.model, effort: req.effort ?? "off",
      message: req.message, prior: req.prior,
      ...(req.runtime !== undefined ? { runtime: req.runtime } : {}),
      ...(req.forkFrom !== undefined ? { forkFrom: req.forkFrom } : {}),
      ...(req.images !== undefined ? { images: req.images.map(i => ({ data: i.data, mimeType: i.mimeType })) } : {}),
      ...(req.stream !== undefined ? { stream: { id: req.stream.id } } : {}),
    };
    if (this.closed) throw new Error("Durable runtime is closed");
    await this.recover();
    const id = req.stream?.id;
    if (!id) throw new DurableUnsupportedError("Durable turns require a stable stream.id/requestId");
    return this.serial("$admission", async () => {
      if (this.deleted(req.threadId)) throw new DurableUnsupportedError("This durable thread was deleted");
      if (this.manifestErrors.has(`${key(id)}.json`)) throw this.manifestErrors.get(`${key(id)}.json`);
      const existing = this.manifests.get(id);
      if (existing) {
        if (!isDeepStrictEqual(existing.request, req)) throw new DurableUnsupportedError("requestId already belongs to a different request");
        return existing.ended ? this.handle(existing) : this.admit(existing);
      }
      if (req.forkFrom) throw new DurableUnsupportedError("Durable history forks are not supported");
      const previous = [...this.manifests.values()].filter(m => m.request.threadId === req.threadId);
      if (previous.some(m => !m.ended)) throw new DurableUnsupportedError("This durable thread is still working", "busy");
      // Rejected admissions (busy/model/workspace errors) can leave extra user turns in the UI.
      // They never entered Durable's transcript. A larger UI count is therefore harmless: submit
      // only this new input against the server-owned history. A smaller count is still a rewind.
      if (req.prior < previous.length) throw new DurableUnsupportedError("Durable history rewinds/imports are not supported; start a new thread");
      const separator = req.model.indexOf("/");
      if (separator < 1 || !(await this.getModels()).getModel(req.model.slice(0, separator), req.model.slice(separator + 1))) {
        throw new Error(`Durable model is not available in Pi's configured ModelRuntime: ${req.model}`);
      }
      const { root } = await this.thread(req.threadId);
      const watch = await root.watch(context);
      const baseline = watch.value.entries.map(e => e.id);
      await watch.stop();
      const m: Manifest = { version: 1, id, request: structuredClone(req), baseline, seen: [], events: [], ended: false };
      this.persist(m);
      this.manifests.set(id, m);
      return this.admit(m);
    });
  }
  async findRun(id: string): Promise<DurableRun | undefined> {
    await this.recover();
    if (this.manifestErrors.has(`${key(id)}.json`)) throw this.manifestErrors.get(`${key(id)}.json`);
    if (this.recoveryErrors.has(id)) {
      const m = this.manifests.get(id);
      if (m && !m.ended && !this.deleted(m.request.threadId) && Date.now() >= (this.retryAt.get(id) ?? 0)) {
        this.retryAt.set(id, Date.now() + 5_000);
        try { await this.serial(m.request.threadId, () => this.drive(m)); }
        catch (error) { this.recoveryErrors.set(id, error); }
      }
      if (this.recoveryErrors.has(id)) throw this.recoveryErrors.get(id);
    }
    return this.runs.get(id);
  }
  async stopRun(id: string): Promise<boolean> {
    await this.recover();
    const m = this.manifests.get(id);
    if (!m) return false;
    if (!m.ended) {
      m.stopping = true; this.persist(m);
      // A run with no live drive (for example an admission failure from an earlier process) cannot
      // be aborted: end it, so Stop actually unsticks the thread.
      if (!this.driving.has(m.id)) this.retire(m);
      else await (await this.thread(m.request.threadId)).root.abort(context);
    }
    return true;
  }
  /** Deletion fence: permanent, persisted before cancellation, never inferred from missing chat metadata. */
  async stopThread(threadId: string): Promise<void> {
    save(this.tombstone(threadId), { threadId, deletedAt: Date.now() });
    await this.recover();
    // Serialize with admission: a request which passed the fence before deletion must finish admitting
    // before we abort it. Later admissions see the tombstone and cannot resurrect the thread.
    await this.serial("$admission", async () => {
      const pending = [...this.manifests.values()].filter(m => m.request.threadId === threadId && !m.ended);
      for (const m of pending) { m.stopping = true; this.persist(m); }
      if (pending.length && this.threads.has(threadId)) await (await this.thread(threadId)).root.abort(context);
      for (const m of pending) if (!m.ended) this.retire(m);
    });
  }
  async compact(threadId: string, instructions?: string): Promise<number> {
    await this.recover();
    if (this.deleted(threadId)) throw new DurableUnsupportedError("This durable thread was deleted");
    if (![...this.manifests.values()].some(m => m.request.threadId === threadId)) throw new DurableUnsupportedError("Unknown durable thread");
    return (await this.thread(threadId)).root.compact(instructions, context);
  }
  /** Whether any admitted turn hasn't ended: the worker must stay up while one might still be running. */
  pending(): boolean {
    return [...this.manifests.values()].some(m => !m.ended);
  }
  async close() {
    this.closed = true;
    for (const thread of this.threads.values()) await (await thread).harness.close(context);
  }
}
