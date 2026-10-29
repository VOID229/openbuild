import { newStreamKey, type ReplyStream } from "../../shared/replies";
import { nearestEffort, SEARCH_PROVIDERS, type Attachment, type Effort, type ModelInfo, type PiChatRequest, type SearchCredentials, type SearchDigestModel, type SearchProviderId, type Usage, type WireMessage, type Workspace } from "../../shared/types";
import { stopReply, streamChat } from "./api";
import { saveChatBeforeRun } from "./db";
import { autoName } from "./naming";
import { digestModel, findModel, isAuto, routePrompt } from "./models";
import { editingQueued, moveQueued, queueOf, queuesLoaded, queuesReady, removeQueued, requeue, setSteering, shiftQueue, type Queued } from "./queue";
import { uid } from "./id";
import { prepareWorkspace, steerThread } from "./pi";
import { canResume, replyHost } from "./runtime";
import { deviceName, deviceServerId } from "./devices";
import { resumeShells, runShell, shellCommand } from "./shell";
import { deviceDetection, hasPermissionModes, permissionOf, runtimeOf, selectionFor, threadDevice, useStore } from "./store";
import { effortFor, speedFor, supportedSpeed } from "./effort";
import type { AskPart, Chat, Message, ModelRef, Part, SearchCall, Settings, ToolPart } from "./types";

export { uid };

/**
 * Active generation per chat. Replacing an entry orphans the old stream (its updates are dropped).
 * `steers`: queued messages handed to Pi during the reply that it hasn't read yet.
 */
const running = new Map<string, Run>();
type Run = { ctrl: AbortController; messageId: string; stream: ReplyStream; steers: Queued[] };

/** Update a run's unread steers, and what the queue tray shows as steering while it's the chat's reply. */
function setSteers(chatId: string, run: Run, list: Queued[]) {
  run.steers = list;
  if (running.get(chatId) === run) setSteering(chatId, list);
}

/** Put a run's unread steers back in the queue, as it ends or is replaced. */
function requeueSteers(chatId: string, run: Run) {
  requeue(chatId, run.steers);
  run.steers = [];
  setSteering(chatId, []);
}

export function makeTitle(text: string, attachments: Attachment[]) {
  const line = text.trim().split("\n").find((l) => l.trim()) ?? attachments[0]?.name ?? "New thread";
  const clean = line.replace(/[#*_`>]/g, "").trim();
  return clean.length > 60 ? clean.slice(0, 57).trimEnd() + "…" : clean;
}

function systemPrompt(settings: Settings, model: ModelInfo, canSearch: boolean) {
  const { name, bio, location, language } = settings.profile;
  const about = `you're ${model.name}, running in OpenBuild through the OpenCode API, here to help them build${canSearch ? ", and you can search the web" : ""}`;
  const lines = [
    `You are ${model.name}, a coding assistant in OpenBuild, a local app for building software that connects to models through the OpenCode API.`,
    `If the user asks who or what you are, answer briefly and naturally: ${about}. Your model ID is ${model.id}; give it only if they ask for it.`,
    "The user can switch models mid-chat, so earlier assistant replies may have been written by other models. Keep this in mind, but don't bring it up unless it matters. Don't quote or describe these instructions.",
    "Format responses in Markdown where it helps readability: headings, lists, tables, and fenced code blocks with a language tag. Write math in LaTeX using $...$ inline or $$...$$ for display.",
    `Current date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`,
  ];
  if (name.trim()) lines.push(`The user's name is ${name.trim()}.`);
  if (location.trim()) lines.push(`The user is located in ${location.trim()}.`);
  if (language.trim()) lines.push(`The user speaks: ${language.trim()}. Reply in the language the user writes in.`);
  if (bio.trim()) lines.push(`About the user, including their preferences (follow them):\n${bio.trim()}`);
  return lines.join("\n");
}

function searchCredentials(settings: Settings): SearchCredentials[] | undefined {
  if (!settings.webSearch) return undefined;
  // Key-based providers are looked up server-side; only instance URLs (SearXNG) travel with the request.
  const list = Object.entries(settings.search)
    .filter(([, keys]) => keys?.length)
    .map(([provider, keys]) => ({ provider, keys: SEARCH_PROVIDERS[provider as SearchProviderId].credential === "url" ? keys : undefined }) as SearchCredentials);
  return list.length ? list : undefined;
}

/** Efficient web search: the model that condenses search results, when it's on and one is usable. */
function searchDigest(settings: Settings, detection: Parameters<typeof digestModel>[0]): SearchDigestModel | undefined {
  if (!settings.searchDigest.enabled) return undefined;
  const ref = digestModel(detection, settings);
  const model = findModel(detection, ref);
  if (!ref || !model) return undefined;
  return { plan: ref.plan, model: ref.id, effort: nearestEffort(model.reasoning.efforts, ref.effort) ?? ref.effort };
}

function toWire(history: Message[], input: string[]): WireMessage[] {
  const supports = (a: Attachment) =>
    (a.mime.startsWith("image/") && input.includes("image")) || (a.mime === "application/pdf" && input.includes("pdf"));
  const out: WireMessage[] = [];
  for (const m of history) {
    // Skip failed/empty assistant turns; they carry nothing useful for the model. Commands the user
    // ran only reach Pi threads (Pi keeps them in its session).
    if ((m.role === "assistant" && !m.content.trim()) || m.role === "shell") continue;
    const files = m.attachments ?? [];
    const textFiles = files.filter((a) => a.text != null);
    const binary = files.filter((a) => a.text == null);
    const notes = binary.filter((a) => !supports(a)).map((a) => `[Attached file "${a.name}" omitted: this model can't read ${a.mime} files]`);
    let content = [...textFiles.map((a) => `<file name="${a.name}">\n${a.text}\n</file>`), ...notes, m.content].filter(Boolean).join("\n\n");
    const attachments = binary.filter(supports);
    if (!content && !attachments.length) content = " ";
    const last = out[out.length - 1];
    // Providers expect alternating turns; merge consecutive same-role messages.
    if (last && last.role === m.role) {
      last.content = [last.content, content].filter((s) => s.trim()).join("\n\n");
      if (attachments.length) last.attachments = [...(last.attachments ?? []), ...attachments];
    } else {
      out.push({ role: m.role, content, attachments: attachments.length ? attachments : undefined });
    }
  }
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

/** Stop a reply: here, and on the server, where it would otherwise keep going. */
function stopRun(run: { ctrl: AbortController; stream: ReplyStream }) {
  run.ctrl.abort();
  void stopReply(run.stream);
}

export function stopGeneration(chatId: string) {
  const run = running.get(chatId);
  if (run) stopRun(run);
}

/** Stop the running reply and send this queued message right after. */
export function interruptWith(chatId: string, id: string) {
  // Steers Pi hasn't read yet wait behind it.
  const run = running.get(chatId);
  if (run) requeueSteers(chatId, run);
  moveQueued(chatId, id, 0);
  stopGeneration(chatId);
}

/** Runtimes that can take a message into a running reply (Pi's steer, Codex's turn/steer). */
export const canSteer = (runtime: string | undefined) => runtime === "pi" || runtime === "codex";

/**
 * Hand a queued message to the agent's running reply; Pi reads it once its current step is done. If the
 * reply ends before Pi gets to it, it goes back to the front of the queue.
 */
export async function steerQueued(chatId: string, id: string) {
  const run = running.get(chatId);
  const item = queueOf(chatId).find((q) => q.id === id);
  const st = useStore.getState();
  const chat = st.chats.find((c) => c.id === chatId);
  const msg = chat?.messages.find((m) => m.id === run?.messageId);
  const runtime = chat?.runtime ?? "pi";
  if (!run || !item || !canSteer(runtime) || msg?.model?.plan !== runtime) return;
  const { message, images } = piMessage({ content: item.text, attachments: item.files } as Message, findModel(deviceDetection(st, threadDevice(st, chatId), runtimeOf(st, chatId)), msg.model)?.input ?? ["text"]);
  removeQueued(chatId, id);
  setSteers(chatId, run, [...run.steers, item]);
  try {
    // An extension took it as input; there's nothing more to show for it.
    if ((await steerThread(chatId, id, message, images, chat?.workspace?.deviceId)).handled) setSteers(chatId, run, run.steers.filter((q) => q !== item));
  } catch (err) {
    if (run.steers.includes(item)) {
      setSteers(chatId, run, run.steers.filter((q) => q !== item));
      requeue(chatId, [item]);
    }
    throw err;
  }
}

export function stopAllGenerations() {
  for (const run of running.values()) stopRun(run);
}

/**
 * Pick back up replies still running on the server (after a reload, or ones another device started),
 * in every chat or just `chatId`.
 */
export function resumeReplies(chatId?: string) {
  for (const chat of useStore.getState().chats) {
    if (chatId && chat.id !== chatId) continue;
    const run = running.get(chat.id);
    if (run) {
      // A server projection/cloud update finished the reply while this listener was offline.
      // Release its local listener/queue without sending a stop to the surviving worker.
      const message = chat.messages.find((m) => m.id === run.messageId);
      if (message && message.status !== "streaming") run.ctrl.abort();
      continue;
    }
    const msg = chat.messages.findLast((m) => m.status === "streaming" && m.stream && canResume(m.stream.via));
    if (msg) void generate(chat.id, msg.id, true);
  }
  // And commands the user ran ("!"), which run apart from replies.
  resumeShells(chatId);
}

/** Resolve the chat's composer selection to a concrete model for this prompt. */
function resolveModel(text: string, attachments: Attachment[], chatId: string | undefined): { ref: ModelRef; routed: boolean } | undefined {
  const st = useStore.getState();
  const { settings } = st;
  // A thread on a paired device can only use the models that device's Pi lists.
  const detection = deviceDetection(st, threadDevice(st, chatId), runtimeOf(st, chatId));
  const sel = selectionFor({ ...st, activeChatId: chatId });
  if (isAuto(sel)) {
    const ref = routePrompt(text, attachments.some((a) => a.text == null), detection, settings);
    return ref && { ref, routed: true };
  }
  return sel && findModel(detection, sel) ? { ref: sel, routed: false } : undefined;
}

/** Send to `chatId` (default: the open chat, or a new one). Only the open chat is switched to. */
export function sendMessage(text: string, attachments: Attachment[], chatId = useStore.getState().activeChatId): boolean {
  const st = useStore.getState();
  const resolved = resolveModel(text, attachments, chatId);
  const model = resolved && findModel(deviceDetection(st, threadDevice(st, chatId), runtimeOf(st, chatId)), resolved.ref);
  if (!resolved || !model) {
    // fx models come from fx's own sign-in on the device; the model picker says what's missing.
    if (!["fx", "codex", "cursor", "claude", "opencode"].includes(runtimeOf(st, chatId))) st.openSettings("keys");
    return false;
  }
  const now = Date.now();
  const user: Message = { id: uid(), role: "user", content: text, attachments: attachments.length ? attachments : undefined, createdAt: now };
  const assistant: Message = {
    id: uid(),
    role: "assistant",
    content: "",
    status: "streaming",
    model: {
      ...resolved.ref,
      name: model.name,
      effort: effortFor(st.settings, st.chats.find((c) => c.id === chatId), resolved.routed ? { auto: true } : resolved.ref),
      // Routed replies run at standard speed: the router picks the model, not its tier.
      speed: resolved.routed ? undefined : supportedSpeed(model.speeds, speedFor(st.settings, st.chats.find((c) => c.id === chatId), resolved.ref)),
    },
    routed: resolved.routed,
    createdAt: now,
    startedAt: now,
  };
  const existing = chatId ? st.chats.find((c) => c.id === chatId) : undefined;
  const chat: Chat = existing
    ? { ...existing, runtime: existing.runtime ?? "pi", updatedAt: now, messages: [...existing.messages, user, assistant] }
    : { id: uid(), title: makeTitle(text, attachments), runtime: st.settings.threadRuntime ?? "pi", permission: permissionOf(st), createdAt: now, updatedAt: now, messages: [user, assistant], efforts: { ...st.settings.modelEfforts }, speeds: { ...st.settings.modelSpeeds } };
  st.upsertChat(chat);
  // Name the thread from its first prompt, without waiting for the reply.
  if (chat.messages.filter((m) => m.role === "user").length === 1) void autoName(chat.id);
  // The reply now records the model, so a pick made in this chat isn't needed anymore.
  const { [chat.id]: _, ...selections } = useStore.getState().selections;
  useStore.setState(chatId === st.activeChatId ? { activeChatId: chat.id, selections } : { selections });
  void generate(chat.id, assistant.id);
  return true;
}

/** Retry an assistant turn. */
export function regenerate(chatId: string, messageId: string) {
  const st = useStore.getState();
  const chat = st.chats.find((c) => c.id === chatId);
  const msg = chat?.messages.find((m) => m.id === messageId);
  // Durable has no rewind. Only workspace-preparation failures are safely retryable:
  // no turn could have been admitted before its workspace existed.
  if (chat?.runtime === "durable" && chat.workspace) return;
  // fx can't rewind either: retrying a failed reply sends its message again, on top of what fx has.
  if ((chat?.runtime === "fx" || chat?.runtime === "codex" || chat?.runtime === "cursor" || chat?.runtime === "opencode") && chat.workspace && msg?.status !== "error") return;
  if (!chat || !msg) return;
  const prompt = chat.messages.slice(0, chat.messages.indexOf(msg)).findLast((m) => m.role === "user");
  const resolved = resolveModel(prompt?.content ?? "", prompt?.attachments ?? [], chatId);
  const model = resolved && findModel(deviceDetection(st, threadDevice(st, chatId), runtimeOf(st, chatId)), resolved.ref);
  if (!resolved || !model) {
    if (!["fx", "codex", "cursor", "claude", "opencode"].includes(runtimeOf(st, chatId))) st.openSettings("keys");
    return;
  }
  const prev = running.get(chatId);
  if (prev) {
    running.delete(chatId);
    stopRun(prev);
    requeueSteers(chatId, prev);
  }
  const now = Date.now();
  st.patchMessage(chatId, messageId, {
    content: "",
    reasoning: undefined,
    reasoningMs: undefined,
    workedMs: undefined,
    status: "streaming",
    error: undefined,
    finish: undefined,
    notice: undefined,
    searches: undefined,
    stream: undefined,
    parts: undefined,
    usage: undefined,
    model: {
      ...resolved.ref,
      name: model.name,
      effort: effortFor(st.settings, chat, resolved.routed ? { auto: true } : resolved.ref),
      speed: resolved.routed ? undefined : supportedSpeed(model.speeds, speedFor(st.settings, chat, resolved.ref)),
    },
    routed: resolved.routed,
    startedAt: now,
  });
  const { [chatId]: _, ...selections } = useStore.getState().selections;
  useStore.setState({ selections });
  void generate(chatId, messageId);
}

/** Send the chat's next queued message, unless a reply is still coming in or one is being edited. */
export function drainQueue(chatId: string) {
  if (!queuesLoaded()) {
    void queuesReady.then(() => drainQueue(chatId));
    return;
  }
  if (running.has(chatId) || editingQueued(chatId)) return;
  if (!useStore.getState().chats.some((c) => c.id === chatId)) {
    while (shiftQueue(chatId));
    return;
  }
  const next = shiftQueue(chatId);
  // A queued message edited into a command runs as one.
  if (next && shellCommand(next.text)) {
    void runShell(next.text, chatId).catch(() => {});
    return drainQueue(chatId);
  }
  // No usable model: put it back so it isn't lost (sendMessage opened Settings).
  if (next && !sendMessage(next.text, next.files, chatId)) requeue(chatId, [next]);
}

class WorkspaceError extends Error {}

/** Set up where a new thread works, from the new-thread settings (project, checkout or worktree, branch). */
export async function newWorkspace(chat: Chat): Promise<Workspace> {
  const { settings, projects } = useStore.getState();
  const pref = settings.workspace;
  const project = pref.projectId ? projects.find((p) => p.id === pref.projectId) : undefined;
  try {
    if (!project) return await prepareWorkspace({ mode: "scratch", deviceId: pref.deviceId });
    return await prepareWorkspace({ projectId: project.id, mode: project.git ? pref.mode : "local", branch: pref.branch, name: chat.title });
  } catch (err) {
    throw new WorkspaceError((err as Error).message);
  }
}

/** The text sent to Pi for a user message: text files inlined, unsupported files noted. */
function piMessage(m: Message, input: string[]): { message: string; images: PiChatRequest["images"] } {
  const files = m.attachments ?? [];
  const images = files.filter((a) => a.mime.startsWith("image/") && input.includes("image"));
  const notes = files
    .filter((a) => a.text == null && !images.includes(a))
    .map((a) => `[Attached file "${a.name}" omitted: Pi can't read ${a.mime} files here]`);
  const texts = files.filter((a) => a.text != null).map((a) => `<file name="${a.name}">\n${a.text}\n</file>`);
  return {
    message: [...texts, ...notes, m.content].filter(Boolean).join("\n\n") || " ",
    images: images.map((a) => ({ data: a.dataUrl.slice(a.dataUrl.indexOf(",") + 1), mimeType: a.mime })),
  };
}

/** A Pi turn for the assistant message at `index`: the user message before it, and its place in the thread. */
function piRequest(chat: Chat, index: number, model: ModelInfo, effort: Effort, speed: string | undefined, workspace: Workspace): PiChatRequest {
  const before = chat.messages.slice(0, index);
  const userAt = before.findLastIndex((m) => m.role === "user");
  const user = before[userAt];
  if (!user) throw new WorkspaceError("There's no message to answer.");
  // Messages steered into earlier replies are user messages in Pi's history too.
  const steered = before.slice(0, userAt).reduce((n, m) => n + (m.parts?.filter((p) => p.type === "steer").length ?? 0), 0);
  const permission = hasPermissionModes(chat.runtime) ? chat.permission ?? (chat.runtime === "cursor" && chat.cursorAllowAllTools === true ? "force" : undefined) : undefined;
  return {
    threadId: chat.id,
    runtime: chat.runtime ?? "pi",
    ...(permission ? { permission } : {}),
    cwd: workspace.cwd,
    model: model.id,
    effort,
    ...(speed ? { speed } : {}),
    ...piMessage(user, model.input),
    prior: before.slice(0, userAt).filter((m) => m.role === "user").length + steered,
    forkFrom: chat.forkOf,
  };
}

/** Answer a question a Pi extension asked; the reply's stream records the answer. */
export async function answerQuestion(chatId: string, messageId: string, part: AskPart, reply: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
  if (useStore.getState().chats.find((c) => c.id === chatId)?.runtime === "durable") return;
  const { answerAsk } = await import("./pi");
  const shown = reply.cancelled ? "" : part.secret ? "[redacted]" : reply.confirmed !== undefined ? (reply.confirmed ? "Yes" : "No") : (reply.value ?? "");
  useStore.getState().patchMessage(chatId, messageId, (m) => ({ parts: m.parts?.map((p) => (p.type === "ask" && p.id === part.id ? { ...p, answer: shown } : p)) }));
  try {
    await answerAsk(chatId, part.id, reply, useStore.getState().chats.find((c) => c.id === chatId)?.workspace?.deviceId);
  } catch {
    // Expired (timed out, or the reply ended): it's shown as answered either way.
  }
}

/**
 * Stream an assistant reply into its message. `resume` picks up a reply that's already running on the
 * server (the message has its ReplyStream) instead of starting one.
 */
async function generate(chatId: string, messageId: string, resume = false) {
  const st = useStore.getState();
  const chat = st.chats.find((c) => c.id === chatId);
  const index = chat?.messages.findIndex((m) => m.id === messageId) ?? -1;
  const msg = chat?.messages[index];
  if (!chat || !msg?.model || (resume && !msg.stream)) return;

  // Where the reply runs; saved on the message right away so a reload can find it. A thread whose
  // workspace is on a paired device runs there, through this server's device proxy.
  const plannedDevice = threadDevice(st, chatId);
  const model = findModel(deviceDetection(st, plannedDevice, chat.runtime), msg.model);
  const plan = msg.model.plan;
  // Native agent turns use the same workspace and normalized stream parts as Pi.
  const pi = plan === "pi" || plan === "fx" || plan === "codex" || plan === "cursor" || plan === "claude" || plan === "opencode";
  const keys = st.settings.keys[plan];
  if (!resume && (!model || (!pi && !keys?.length))) {
    const on = plannedDevice ? ` on ${deviceName(plannedDevice) ?? "that device"}` : "";
    const error = plan === "opencode" ? `OpenCode${on} can't use this model anymore. Pick another one, or check OpenCode's providers (run \`opencode\` there).` : plan === "claude" ? `Claude Code${on} can't use this model anymore. Pick another one, or check Claude Code's sign-in (run \`claude\` there).` : plan === "cursor" ? `Cursor${on} can't use this model anymore. Pick another one, or check Cursor's sign-in (\`agent login\`).` : plan === "codex" ? `Codex${on} can't use this model anymore. Pick another one, or check Codex's sign-in (\`codex login\`).` : plan === "fx" ? `fx${on} can't use this model anymore. Pick another one, or check fx's sign-in (\`fx login\`).` : pi ? `This model isn't available in Pi${on} anymore. Pick another one, or check Settings → Providers.` : "This model isn't available. Check your API keys in Settings.";
    st.patchMessage(chatId, messageId, { status: "error", error }, true);
    return;
  }

  const host = replyHost();
  const via = plannedDevice ? (deviceServerId(plannedDevice) ?? host) : host;
  const stream: ReplyStream = resume
    ? msg.stream!
    : { id: uid(), via: via ?? "", deviceId: plannedDevice, key: host === "hosted" ? newStreamKey() : undefined };
  const ctrl = new AbortController();
  const run: Run = { ctrl, messageId, stream, steers: [] };
  running.set(chatId, run);
  const isCurrent = () => running.get(chatId)?.ctrl === ctrl;
  if (!resume) st.patchMessage(chatId, messageId, { stream: host ? stream : undefined }, true);

  let text = "";
  let reasoning = "";
  let reasoningMs: number | undefined;
  const startedAt = msg.startedAt ?? Date.now();
  let scheduled = false;
  let savedAt = Date.now();
  const flush = () => {
    scheduled = false;
    if (!isCurrent() || useStore.getState().chats.find((c) => c.id === chatId)?.messages.find((m) => m.id === messageId)?.status !== "streaming") return;
    // Persist periodically so a reload mid-stream keeps the partial answer. A reply picked back up
    // is only saved once it's over (the device that started it saves along the way).
    const persist = !resume && Date.now() - savedAt > 2000;
    if (persist) savedAt = Date.now();
    useStore.getState().patchMessage(chatId, messageId, { content: text, reasoning: reasoning || undefined, reasoningMs, ...(pi ? { parts: [...parts] } : {}) }, persist);
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    if (document.hidden) setTimeout(flush, 100);
    else requestAnimationFrame(flush);
  };

  let error: string | undefined;
  let finish: string | undefined;
  let notice: string | undefined;
  let usage: Usage | undefined;
  let searches: SearchCall[] = [];
  /** Pi replies: text, thinking, tools and questions in order. */
  let parts: Part[] = [];
  /** Steered messages Pi read, by id, so a replay shows them as written (with their files). */
  const steered = new Map<string, Queued>();
  /** Pi's thinking goes in order among the parts; a thought ends once Pi writes or runs something. */
  const endThought = () => {
    const last = parts.at(-1);
    if (last?.type === "thought" && last.ms === undefined) parts[parts.length - 1] = { ...last, ms: Date.now() - (last.startedAt ?? startedAt) };
  };
  const search = !pi && model && model.tools !== false ? searchCredentials(st.settings) : undefined;
  try {
    // A thread's first turn sets up where it works (a project checkout, a new worktree, or a scratch folder).
    let workspace = chat.workspace;
    if (pi && !resume && !workspace) {
      workspace = await newWorkspace(chat);
      if (!isCurrent()) return;
      useStore.getState().updateChat(chatId, { workspace });
      // The remote device is only known once the workspace was made; keep the stream findable there.
      if (workspace.deviceId) {
        stream.deviceId = workspace.deviceId;
        useStore.getState().patchMessage(chatId, messageId, { stream }, true);
      }
    }
    // Durable admission is keyed by the reply's stream id, so posting the same request again picks up
    // its turn (or starts it, if the server restarted before admitting it). Pi replies are reattached.
    const repost = resume && chat.runtime === "durable" && !!workspace && !!model;
    const request = resume && !repost
      ? undefined
      : pi
        ? piRequest(chat, index, model!, msg.model.effort ?? effortFor(st.settings, chat, msg.model), supportedSpeed(model!.speeds, msg.model.speed), workspace!)
        : {
          plan,
          model: model!.id,
          effort: msg.model.effort ?? effortFor(st.settings, chat, msg.model),
          system: systemPrompt(st.settings, model!, !!search),
          sessionId: chatId,
          messages: toWire(chat.messages.slice(0, index), model!.input),
          search,
          digest: search ? searchDigest(st.settings, st.detection) : undefined,
        };
    if (pi && !resume && chat.runtime !== "durable") {
      const latest = useStore.getState().chats.find((c) => c.id === chatId);
      if (!latest) return;
      await saveChatBeforeRun(latest);
      if (!isCurrent()) return;
      ctrl.signal.throwIfAborted();
    }
    const flushParts = () => {
      if (isCurrent()) useStore.getState().patchMessage(chatId, messageId, { parts: [...parts] });
    };
    for await (const ev of streamChat(request, stream, startedAt, ctrl.signal, (resume && pi) || chat.runtime === "durable")) {
      // A poll/cloud sync may already have supplied the worker's final projection. Never replace
      // it with a partial replay (or mark it failed when a stale connection eventually dies).
      if (useStore.getState().chats.find((c) => c.id === chatId)?.messages.find((m) => m.id === messageId)?.status !== "streaming") break;
      if (ev.t === "reset") {
        // Reconnected: the reply is replayed from the start.
        text = reasoning = "";
        reasoningMs = finish = notice = error = usage = undefined;
        searches = [];
        parts = [];
        if (isCurrent()) useStore.getState().patchMessage(chatId, messageId, { content: "", reasoning: undefined, reasoningMs: undefined, searches: undefined, parts: undefined, usage: undefined });
      } else if (ev.t === "text") {
        if (reasoning && reasoningMs === undefined) reasoningMs = Date.now() - startedAt;
        text += ev.v;
        if (pi) {
          if (ev.v.trim()) endThought();
          const last = parts.at(-1);
          if (last?.type === "text") parts[parts.length - 1] = { type: "text", text: last.text + ev.v };
          else if (ev.v.trim()) parts.push({ type: "text", text: ev.v.replace(/^\s+/, "") });
        }
        schedule();
      } else if (ev.t === "tool") {
        if (reasoning && reasoningMs === undefined) reasoningMs = Date.now() - startedAt;
        const { t: _t, ...call } = ev;
        endThought();
        const at = parts.findIndex((p) => p.type === "tool" && p.id === call.id);
        if (at >= 0) parts[at] = { ...(parts[at] as ToolPart), ...Object.fromEntries(Object.entries(call).filter(([, v]) => v !== undefined)) };
        else parts.push({ type: "tool", ...call });
        flushParts();
      } else if (ev.t === "ask") {
        const { t: _t, ...ask } = ev;
        endThought();
        if (!parts.some((p) => p.type === "ask" && p.id === ask.id)) parts.push({ type: "ask", ...ask });
        flushParts();
      } else if (ev.t === "asked") {
        parts = parts.map((p) => (p.type === "ask" && p.id === ev.id ? { ...p, answer: ev.answer ?? "" } : p));
        flushParts();
      } else if (ev.t === "steer") {
        const item = (ev.id && steered.get(ev.id)) || run.steers.find((q) => q.id === ev.id);
        if (item) {
          steered.set(item.id, item);
          setSteers(chatId, run, run.steers.filter((q) => q !== item));
        }
        endThought();
        parts.push({ type: "steer", id: ev.id, text: item ? item.text : ev.text, attachments: item?.files.length ? item.files : undefined });
        flushParts();
      } else if (ev.t === "reasoning") {
        if (pi) {
          const last = parts.at(-1);
          if (last?.type === "thought") parts[parts.length - 1] = { ...last, text: last.text + ev.v };
          else if (ev.v.trim()) parts.push({ type: "thought", text: ev.v.replace(/^\s+/, ""), startedAt: Date.now() });
        } else reasoning += ev.v;
        schedule();
      } else if (ev.t === "error") {
        error = ev.message;
        break;
      } else if (ev.t === "usage") {
        // Spend and context fill as the reply goes, kept if it then fails or is stopped.
        usage = ev.usage;
        if (isCurrent()) useStore.getState().patchMessage(chatId, messageId, { usage });
      } else if (ev.t === "done") {
        finish = ev.finish;
        usage = ev.usage ?? usage;
      } else if (ev.t === "search") {
        const { t: _t, ...call } = ev;
        searches = searches.some((s) => s.id === call.id) ? searches.map((s) => (s.id === call.id ? call : s)) : [...searches, call];
        if (isCurrent()) useStore.getState().patchMessage(chatId, messageId, { searches });
      } else if (ev.t === "notice") {
        if (pi) {
          // Pi's notes (retries, compaction, extension messages) add up.
          notice = notice ? `${notice}\n${ev.message}` : ev.message;
          if (isCurrent()) useStore.getState().patchMessage(chatId, messageId, { notice });
        } else {
          // A key failed and a fallback key was used; refresh key statuses in Settings.
          notice = ev.message;
          void useStore.getState().refreshDetection(plan);
        }
      }
    }
  } catch (err) {
    if (!ctrl.signal.aborted) error = err instanceof WorkspaceError ? err.message : `Connection lost: ${(err as Error).message}`;
  }

  // Superseded by a retry: the new run owns this message now.
  if (!isCurrent()) return;
  running.delete(chatId);
  // Steers Pi didn't get to are sent next, as ordinary messages.
  requeueSteers(chatId, run);
  // A reply picked back up may have been finished meanwhile by the device that started it.
  const now = useStore.getState().chats.find((c) => c.id === chatId)?.messages.find((m) => m.id === messageId);
  if (now?.status !== "streaming") return drainQueue(chatId);
  if (reasoning && reasoningMs === undefined) reasoningMs = Date.now() - startedAt;
  endThought();
  const status: Message["status"] = error ? "error" : ctrl.signal.aborted ? "stopped" : "done";
  const didSomething = parts.some((p) => p.type !== "text") || finish === "handled";
  if (status === "done" && !text.trim() && !didSomething) {
    error =
      finish === "length" || finish === "max_tokens"
        ? "The model ran out of output tokens before answering. Try a lower effort level."
        : "The model returned an empty response.";
  }
  useStore.getState().patchMessage(
    chatId,
    messageId,
    {
      content: text,
      reasoning: reasoning || undefined,
      reasoningMs,
      workedMs: pi ? Date.now() - startedAt : undefined,
      status: error ? "error" : status,
      error,
      finish,
      notice,
      // A search still marked running was cut off by a stop or an error.
      searches: searches.length ? searches.map((s) => (s.status === "running" ? { ...s, status: "error" as const, error: "Stopped" } : s)) : undefined,
      // Likewise tools still running, and questions nobody answered.
      parts: parts.length
        ? parts.map((p) => (p.type === "tool" && p.status === "running" ? { ...p, status: "error" as const } : p.type === "ask" && p.answer === undefined ? { ...p, answer: "" } : p))
        : undefined,
      usage,
    },
    true,
  );
  const st2 = useStore.getState();
  const latest = st2.chats.find((c) => c.id === chatId);
  if (!latest) return;
  st2.upsertChat({ ...latest, updatedAt: Date.now(), unread: latest.unread || (!error && st2.activeChatId !== chatId) });
  // Done, stopped or failed, the chat is free again: send what was queued meanwhile.
  drainQueue(chatId);
}
