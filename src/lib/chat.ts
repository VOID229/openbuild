import { SEARCH_PROVIDERS, type Attachment, type ModelInfo, type SearchCredentials, type SearchProviderId, type WireMessage } from "../../shared/types";
import { streamChat } from "./api";
import { autoName } from "./naming";
import { findModel, isAuto, routePrompt } from "./models";
import { useStore } from "./store";
import type { Chat, Message, ModelRef, SearchCall, Settings } from "./types";

export const uid = () => crypto.randomUUID();

/** Active generation per chat. Replacing an entry orphans the old stream (its updates are dropped). */
const running = new Map<string, { ctrl: AbortController; messageId: string }>();

function makeTitle(text: string, attachments: Attachment[]) {
  const line = text.trim().split("\n").find((l) => l.trim()) ?? attachments[0]?.name ?? "New chat";
  const clean = line.replace(/[#*_`>]/g, "").trim();
  return clean.length > 60 ? clean.slice(0, 57).trimEnd() + "…" : clean;
}

function systemPrompt(settings: Settings, model: ModelInfo) {
  const { name, bio, location, language } = settings.profile;
  const lines = [
    `You are ${model.name} (model ID: ${model.id}), a helpful assistant. You are running inside OpenChat, a chat app that lets the user switch between AI models from different providers.`,
    `If asked who or what you are, say you are ${model.name}, used through OpenChat. Don't claim to be OpenChat itself or a different model. Earlier assistant replies in this conversation may have been written by other models.`,
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

function toWire(history: Message[], input: string[]): WireMessage[] {
  const supports = (a: Attachment) =>
    (a.mime.startsWith("image/") && input.includes("image")) || (a.mime === "application/pdf" && input.includes("pdf"));
  const out: WireMessage[] = [];
  for (const m of history) {
    // Skip failed/empty assistant turns; they carry nothing useful for the model.
    if (m.role === "assistant" && !m.content.trim()) continue;
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

export function stopGeneration(chatId: string) {
  running.get(chatId)?.ctrl.abort();
}

export function stopAllGenerations() {
  for (const { ctrl } of running.values()) ctrl.abort();
}

/** Resolve the composer selection to a concrete model for this prompt. */
function resolveModel(text: string, attachments: Attachment[]): { ref: ModelRef; routed: boolean } | undefined {
  const { settings, detection } = useStore.getState();
  const sel = settings.selection;
  if (isAuto(sel)) {
    const ref = routePrompt(text, attachments.some((a) => a.text == null), detection, settings);
    return ref && { ref, routed: true };
  }
  return sel && findModel(detection, sel) ? { ref: sel, routed: false } : undefined;
}

export function sendMessage(text: string, attachments: Attachment[]): boolean {
  const st = useStore.getState();
  const resolved = resolveModel(text, attachments);
  const model = resolved && findModel(st.detection, resolved.ref);
  if (!resolved || !model) {
    st.openSettings("keys");
    return false;
  }
  const now = Date.now();
  const user: Message = { id: uid(), role: "user", content: text, attachments: attachments.length ? attachments : undefined, createdAt: now };
  const assistant: Message = {
    id: uid(),
    role: "assistant",
    content: "",
    status: "streaming",
    model: { ...resolved.ref, name: model.name },
    routed: resolved.routed,
    createdAt: now,
    startedAt: now,
  };
  const existing = st.chats.find((c) => c.id === st.activeChatId);
  const chat: Chat = existing
    ? { ...existing, updatedAt: now, messages: [...existing.messages, user, assistant] }
    : { id: uid(), title: makeTitle(text, attachments), createdAt: now, updatedAt: now, messages: [user, assistant] };
  st.upsertChat(chat);
  useStore.setState({ activeChatId: chat.id });
  void generate(chat.id, assistant.id);
  return true;
}

/**
 * "2nd": copy the conversation up to (not including) an assistant reply into a new chat and
 * answer that same user turn with another model. The original chat is left untouched.
 */
export function forkWithModel(chatId: string, messageId: string, ref: ModelRef) {
  const st = useStore.getState();
  const chat = st.chats.find((c) => c.id === chatId);
  const index = chat?.messages.findIndex((m) => m.id === messageId) ?? -1;
  const model = findModel(st.detection, ref);
  if (!chat || index < 1) return;
  if (!model) {
    st.openSettings("keys");
    return;
  }
  const now = Date.now();
  const history = chat.messages.slice(0, index).map((m) => ({ ...m, id: uid(), status: m.status === "streaming" ? ("stopped" as const) : m.status }));
  const assistant: Message = {
    id: uid(),
    role: "assistant",
    content: "",
    status: "streaming",
    model: { ...ref, name: model.name },
    createdAt: now,
    startedAt: now,
  };
  const fork: Chat = {
    id: uid(),
    // Same title as the original; the "2nd" badge and banner mark it as a fork.
    title: chat.title,
    titleSource: "auto",
    forkOf: chat.id,
    forkMessageId: messageId,
    createdAt: now,
    updatedAt: now,
    messages: [...history, assistant],
  };
  st.upsertChat(fork);
  st.selectChat(fork.id);
  void generate(fork.id, assistant.id);
}

/** Re-run an assistant turn, optionally on a different model (think harder / think faster / retry). */
export function regenerate(chatId: string, messageId: string, ref?: ModelRef) {
  const st = useStore.getState();
  const msg = st.chats.find((c) => c.id === chatId)?.messages.find((m) => m.id === messageId);
  const target = ref ?? msg?.model;
  const model = findModel(st.detection, target);
  if (!msg || !target || !model) {
    st.openSettings("keys");
    return;
  }
  const prev = running.get(chatId);
  if (prev) {
    running.delete(chatId);
    prev.ctrl.abort();
  }
  const now = Date.now();
  st.patchMessage(chatId, messageId, {
    content: "",
    reasoning: undefined,
    reasoningMs: undefined,
    status: "streaming",
    error: undefined,
    finish: undefined,
    notice: undefined,
    searches: undefined,
    model: { plan: target.plan, id: target.id, name: model.name },
    routed: ref ? false : msg.routed,
    startedAt: now,
  });
  void generate(chatId, messageId);
}

async function generate(chatId: string, messageId: string) {
  const st = useStore.getState();
  const chat = st.chats.find((c) => c.id === chatId);
  const index = chat?.messages.findIndex((m) => m.id === messageId) ?? -1;
  const msg = chat?.messages[index];
  if (!chat || !msg?.model) return;

  const model = findModel(st.detection, msg.model);
  const plan = msg.model.plan;
  const keys = st.settings.keys[plan];
  if (!model || !keys?.length) {
    st.patchMessage(chatId, messageId, { status: "error", error: "This model isn't available. Check your API keys in Settings." }, true);
    return;
  }

  const ctrl = new AbortController();
  running.set(chatId, { ctrl, messageId });
  const isCurrent = () => running.get(chatId)?.ctrl === ctrl;

  let text = "";
  let reasoning = "";
  let reasoningMs: number | undefined;
  const startedAt = msg.startedAt ?? Date.now();
  let scheduled = false;
  let savedAt = Date.now();
  const flush = () => {
    scheduled = false;
    if (!isCurrent()) return;
    // Persist periodically so a reload mid-stream keeps the partial answer.
    const persist = Date.now() - savedAt > 2000;
    if (persist) savedAt = Date.now();
    useStore.getState().patchMessage(chatId, messageId, { content: text, reasoning: reasoning || undefined, reasoningMs }, persist);
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
  let searches: SearchCall[] = [];
  try {
    const stream = streamChat(
      {
        plan,
        model: model.id,
        effort: st.settings.effort,
        system: systemPrompt(st.settings, model),
        sessionId: chatId,
        messages: toWire(chat.messages.slice(0, index), model.input),
        search: model.tools !== false ? searchCredentials(st.settings) : undefined,
      },
      ctrl.signal,
    );
    for await (const ev of stream) {
      if (ev.t === "text") {
        if (reasoning && reasoningMs === undefined) reasoningMs = Date.now() - startedAt;
        text += ev.v;
        schedule();
      } else if (ev.t === "reasoning") {
        reasoning += ev.v;
        schedule();
      } else if (ev.t === "error") {
        error = ev.message;
        break;
      } else if (ev.t === "done") {
        finish = ev.finish;
      } else if (ev.t === "search") {
        const { t: _t, ...call } = ev;
        searches = searches.some((s) => s.id === call.id) ? searches.map((s) => (s.id === call.id ? call : s)) : [...searches, call];
        if (isCurrent()) useStore.getState().patchMessage(chatId, messageId, { searches });
      } else if (ev.t === "notice") {
        // A key failed and a fallback key was used; refresh key statuses in Settings.
        notice = ev.message;
        void useStore.getState().refreshDetection(plan);
      }
    }
  } catch (err) {
    if (!ctrl.signal.aborted) error = `Connection lost: ${(err as Error).message}`;
  }

  // Superseded by think faster / regenerate: the new run owns this message now.
  if (!isCurrent()) return;
  running.delete(chatId);
  if (reasoning && reasoningMs === undefined) reasoningMs = Date.now() - startedAt;
  const status: Message["status"] = error ? "error" : ctrl.signal.aborted ? "stopped" : "done";
  if (status === "done" && !text.trim()) {
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
      status: error ? "error" : status,
      error,
      finish,
      notice,
      // A search still marked running was cut off by a stop or an error.
      searches: searches.length ? searches.map((s) => (s.status === "running" ? { ...s, status: "error" as const, error: "Stopped" } : s)) : undefined,
    },
    true,
  );
  const st2 = useStore.getState();
  const latest = st2.chats.find((c) => c.id === chatId);
  if (!latest) return;
  st2.upsertChat({ ...latest, updatedAt: Date.now(), unread: latest.unread || (!error && st2.activeChatId !== chatId) });
  // Name the chat after its first successful exchange.
  const replies = latest.messages.filter((m) => m.role === "assistant" && m.content.trim()).length;
  if (!error && replies === 1 && !latest.titleSource) void autoName(chatId);
}
