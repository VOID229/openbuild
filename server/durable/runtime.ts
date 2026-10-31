import { HtmlDelivery, HTML_DELIVERY_NOTE } from "../htmlDelivery";
import { PLUGIN_GUIDANCE_NOTE } from "../pluginGuidance";
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
import { durableQuestions, questionTick, type DurableQuestion, type QuestionReply } from "./questions";
import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { PiChatRequest, StreamEvent, Usage } from "../../shared/types";
import { Run } from "../runs";
import { dataDir } from "../paths";
import { agentDir, packageRoot } from "../pi/install";
import { addUsage } from "../pi/usage";

/** `text` is what the model reads; `display` is what the user wrote, when they differ. */
interface DurableSteer { id: string; text: string; display?: string; images?: PiChatRequest["images"] }
interface Manifest {
  steers?: DurableSteer[];
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
  questions?: Record<string, DurableQuestion>;
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
    this.dismissQuestions(m);
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
        registry.install(durableQuestions((callId, question, options, ctx) => this.waitQuestion(id, callId, question, options, ctx)));
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
  private async waitQuestion(threadId: string, callId: string, question: string, options: string[], ctx: Context): Promise<string | undefined> {
    const m = [...this.manifests.values()].find(m => m.request.threadId === threadId && !m.ended);
    if (!m || m.stopping) throw new Error("Question's durable run is no longer active");
    m.questions ??= Object.create(null);
    let q = Object.hasOwn(m.questions!, callId) ? m.questions![callId] : undefined;
    if (!q) {
      q = { question, options, answered: false };
      Object.defineProperty(m.questions, callId, { value: q, writable: true, enumerable: true, configurable: true });
      const offset = m.events.length;
      try { this.emit(m, [{ t: "ask", id: callId, method: "select", title: question, options, other: true }]); }
      catch (error) {
        delete m.questions![callId];
        m.events.length = offset;
        throw error;
      }
    } else if (q.question !== question || !isDeepStrictEqual(q.options, options)) {
      throw new Error("Durable question call ID was reused with different arguments");
    }
    while (!q.answered) {
      await questionTick(ctx);
      if (this.closed || m.ended || m.stopping) throw new Error("Durable question interrupted");
    }
    return q.answer;
  }
  async answer(threadId: string, askId: string, reply: QuestionReply): Promise<boolean> {
    await this.recover();
    const m = [...this.manifests.values()].find(m => m.request.threadId === threadId && !m.ended && !m.stopping && m.questions && Object.hasOwn(m.questions, askId));
    const q = m?.questions?.[askId];
    if (!m || !q) return false;
    const answer = reply.cancelled ? undefined : reply.value;
    if (!reply.cancelled && typeof answer !== "string") return false;
    // Idempotent acknowledgement if the worker died after fsync but before its HTTP response.
    if (q.answered) return q.answer === answer;
    q.answered = true;
    if (answer !== undefined) q.answer = answer;
    const offset = m.events.length;
    try { this.emit(m, [{ t: "asked", id: askId, ...(answer !== undefined ? { answer } : {}) }]); }
    catch (error) {
      // Never let the live waiter consume a reply whose durable commit failed.
      q.answered = false;
      delete q.answer;
      m.events.length = offset;
      throw error;
    }
    return true;
  }
  private dismissQuestions(m: Manifest) {
    const events: StreamEvent[] = [];
    for (const [id, q] of Object.entries(m.questions ?? {})) {
      if (!q.answered) { q.answered = true; events.push({ t: "asked", id }); }
    }
    if (events.length) this.emit(m, events);
  }
  private submitSteer(root: Conversation, m: Manifest, item: DurableSteer) {
    const content = item.images?.length
      ? [{ type: "text" as const, text: item.text }, ...item.images.map(image => ({ type: "image" as const, ...image }))]
      : item.text;
    return root.submit({ type: "input", content, whenBusy: "steer", requestId: JSON.stringify(["openbuild-steer", m.id, item.id]),
      entry: { kind: "openbuild.steer", data: { run: m.id, id: item.id, text: item.display ?? item.text } } }, context);
  }
  async steer(threadId: string, id: string, text: string, images?: PiChatRequest["images"], display?: string): Promise<{ handled: boolean }> {
    if (this.closed) throw new Error("Durable runtime is closed");
    await this.recover();
    return this.serial("$admission", async () => {
      if (this.deleted(threadId)) throw new DurableUnsupportedError("This durable thread was deleted");
      const input: DurableSteer = { id, text, ...(display !== undefined ? { display } : {}), ...(images?.length ? { images: images.map(i => ({ data: i.data, mimeType: i.mimeType })) } : {}) };
      const previous = [...this.manifests.values()].findLast(m => m.request.threadId === threadId && m.steers?.some(s => s.id === id));
      if (previous) {
        if (!isDeepStrictEqual(previous.steers!.find(s => s.id === id), input)) throw new DurableUnsupportedError("Steering ID was reused with different input");
        if (previous.events.some(e => e.t === "steer" && e.id === id)) return { handled: false };
        if (!previous.ended) {
          if (previous.stopping) throw new DurableUnsupportedError("Durable is stopping this thread");
          await this.submitSteer((await this.thread(threadId)).root, previous, input);
          return { handled: false };
        }
        // Stop withdrew this unread input. Its queue item can steer a later run.
      }
      const m = [...this.manifests.values()].find(m => m.request.threadId === threadId && !m.ended && !m.stopping);
      if (!m) throw new DurableUnsupportedError("Durable isn't working on this thread");
      const { root } = await this.thread(threadId);
      (m.steers ??= []).push(input);
      try { this.persist(m); } // intent survives either side of upstream's idempotent submit
      catch (error) { m.steers!.pop(); throw error; }
      await this.submitSteer(root, m, input);
      return { handled: false };
    });
  }
  private project(m: Manifest, entries: readonly EntryRecord[]) {
    const skip = new Set([...m.baseline, ...m.seen]);
    for (const entry of entries) {
      if (skip.has(entry.id)) continue;
      const events: StreamEvent[] = [];
      let pageIndex = 0;
      if (entry.kind === "openbuild.steer") {
        const data = entry.data as { run?: string; id?: string; text?: string } | undefined;
        if (data?.run === m.id && m.steers?.some(item => item.id === data.id)) events.push({ t: "steer", id: data.id, text: data.text ?? "" });
      }
      for (const message of entry.model ?? []) {
        const html = new HtmlDelivery(event => events.push(event), () => `html-${entry.id}-${pageIndex++}`);
        if (message.role === "assistant") {
          // Provider-reported tokens for the latest request/answer, including cached context.
          addUsage(m.usage ??= {}, message.usage);
          if (message.usage) events.push({ t: "usage", usage: { ...m.usage } });
          for (const block of message.content) {
            if (block.type === "text" && block.text) html.push({ t: "text", v: block.text });
            else if (block.type === "thinking" && block.thinking) html.push({ t: "reasoning", v: block.thinking });
            else if (block.type === "toolCall") html.push({ t: "tool", id: block.id, name: block.name, args: block.arguments, status: "running" });
          }
          html.flush();
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
      ? [{ type: "text" as const, text: HTML_DELIVERY_NOTE + PLUGIN_GUIDANCE_NOTE + m.request.message }, ...m.request.images.map(i => ({ type: "image" as const, ...i }))]
      : HTML_DELIVERY_NOTE + PLUGIN_GUIDANCE_NOTE + m.request.message;
    // The manifest exists before submit. Retrying after either side of this await is safe.
    const submission = await root.submit({ type: "input", content, requestId: m.id, whenBusy: "reject" }, context);
    // Persist "may have been submitted" before anything else can fail: from here on, recovery must
    // replay instead of terminalizing, and upstream dedupes the requestId.
    m.submitted = true;
    this.persist(m);
    if (!m.stopping) for (const item of m.steers ?? []) await this.submitSteer(root, m, item);
    harness.resume();
    if (m.stopping) await root.abort(context);
    void (async () => {
      try {
        const result = await submission.wait(context);
        while (!m.ended) {
          const count = m.steers?.length ?? 0;
          // A late steer can start a continuation after the original input settles.
          // Keep the reply open until every admitted input has settled.
          if (!m.stopping) await Promise.all((m.steers ?? []).map(async item => (await this.submitSteer(root, m, item)).wait(context)));
          const ended = await this.serial("$admission", async () => {
            if (m.ended) return true;
            if ((m.steers?.length ?? 0) !== count) return false;
            const final = await root.watch(context);
            try { this.project(m, final.value.entries); } finally { await final.stop(); }
            if (result.status === "unanswered" && !m.stopping) m.events.push({ t: "error", message: `Durable submission unanswered: ${result.reason}` });
            this.dismissQuestions(m);
            m.events.push({ t: "done", finish: m.stopping ? "aborted" : result.status, usage: m.usage });
            m.ended = true;
            this.persist(m);
            for (const event of m.events.slice(run.events.length)) run.push(event);
            run.end();
            return true;
          });
          if (ended) break;
        }
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
      if (req.prior < previous.length + previous.reduce((n, m) => n + m.events.filter(e => e.t === "steer").length, 0)) throw new DurableUnsupportedError("Durable history rewinds/imports are not supported; start a new thread");
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
    return this.serial("$admission", async () => {
      const m = this.manifests.get(id);
      if (!m) return false;
      if (!m.ended) {
        m.stopping = true; this.persist(m);
        if (!this.driving.has(m.id)) this.retire(m);
        else await (await this.thread(m.request.threadId)).root.abort(context);
      }
      return true;
    });
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
