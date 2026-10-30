// Short texts written by a model on the side: thread titles (as soon as the first user prompt is
// sent, or on request from the thread menu) and commit messages. The text generation models picked in Settings are tried in order;
// with none picked, the thread's own model is used at the lowest reasoning it supports (no
// thinking when possible).
import { streamOnce } from "./api";
import { findModel } from "./models";
import { completeOnce } from "./pi";
import { useStore } from "./store";
import { lowestEffort } from "../../shared/types";
import type { Chat, NamingModel } from "./types";

const NAMING_SYSTEM =
  "You name coding threads and conversations. Reply with only a short, specific title of 2 to 6 words in Title Case that captures the topic. " +
  "No quotes, no trailing punctuation, no emojis, no explanation.";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

const REGENERATE_SYSTEM = `${NAMING_SYSTEM} You are given a transcript to title, not a request to answer. Favor what the latest messages are about.`;

export function cleanTitle(raw: string) {
  let t = raw
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";
  t = t
    .replace(/^(chat\s+)?title\s*[:\-–]\s*/i, "")
    .replace(/^[#*_"'`“”‘’\s]+|[#*_"'`“”‘’\s]+$/g, "")
    .replace(/[.!?:;,]+$/, "")
    .trim();
  return t.length > 60 ? t.slice(0, 57).trimEnd() + "…" : t;
}

/**
 * Models that may write side texts, in order. Models picked in Settings override the default; with
 * none picked, the model this thread is using, at the lowest reasoning it supports.
 */
function candidates(chat?: Chat): NamingModel[] {
  const { settings, detection } = useStore.getState();
  const usable = (m: NamingModel) => findModel(detection, m) && (m.plan === "pi" || settings.keys[m.plan]?.length);
  if (settings.naming.models.length) return settings.naming.models.filter(usable);
  const used = chat?.messages.findLast((m) => m.role === "assistant" && m.model)?.model;
  const model = used ? findModel(detection, used) : undefined;
  return used && model ? [{ plan: used.plan, id: used.id, effort: lowestEffort(model.reasoning.efforts) }] : [];
}

/**
 * Ask the text generation models, in order, until one answers with something `clean` keeps. Empty
 * when none could (none chosen and the thread has no model, or they all failed).
 */
export async function generateText(opts: { system: string; content: string; sessionId: string; chat?: Chat; clean: (raw: string) => string; timeoutMs?: number }): Promise<string> {
  for (const cand of candidates(opts.chat)) {
    const keys = useStore.getState().settings.keys[cand.plan];
    if (cand.plan !== "pi" && !keys?.length) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
    let text = "";
    let failed = false;
    try {
      if (cand.plan === "pi") text = await completeOnce(cand.id, opts.system, opts.content, ctrl.signal);
      else {
        const stream = streamOnce(
          { plan: cand.plan, model: cand.id, effort: cand.effort, system: opts.system, sessionId: opts.sessionId, messages: [{ role: "user", content: opts.content }] },
          ctrl.signal,
        );
        for await (const ev of stream) {
          if (ev.t === "text") text += ev.v;
          else if (ev.t === "error") {
            failed = true;
            break;
          }
        }
      }
    } catch {
      failed = true;
    } finally {
      clearTimeout(timer);
    }
    const out = opts.clean(text);
    if (!failed && out) return out;
  }
  return "";
}

/** The opening prompt and as many of the latest messages as fit in `budget` characters, oldest first. */
export function threadTranscript(chat: Pick<Chat, "messages">, budget = 6000) {
  const blocks = chat.messages.flatMap((m) => {
    const text = (m.role === "shell" ? `$ ${m.content}` : m.content).trim() || (m.attachments ?? []).map((a) => a.name).join(", ");
    return text ? [`${m.role === "assistant" ? "Assistant" : "User"}: ${clip(text, 1500)}`] : [];
  });
  const [first, ...rest] = blocks;
  if (!first) return "";
  const latest: string[] = [];
  let left = budget - first.length;
  for (const block of rest.reverse()) {
    if (block.length > left) break;
    left -= block.length;
    latest.unshift(block);
  }
  return [first, ...(latest.length < rest.length ? ["[…]"] : []), ...latest].join("\n\n");
}

/**
 * Retitle a thread from where it is now. False when no model gave a title. Whoever asks for this
 * owns the result, so it counts as the user's title: it replaces a manual one and outlives a name
 * Pi gave the session.
 */
export async function regenerateTitle(chatId: string) {
  const chat = useStore.getState().chats.find((c) => c.id === chatId);
  const transcript = chat && threadTranscript(chat);
  if (!transcript) return false;
  const content = `Transcript to title:\n\n${transcript}`;
  const title = await generateText({ system: REGENERATE_SYSTEM, content, sessionId: `${chatId}-title`, chat, clean: cleanTitle });
  if (!title) return false;
  // The user may have renamed it while we were waiting.
  const latest = useStore.getState().chats.find((c) => c.id === chatId);
  if (latest?.title === chat.title) useStore.getState().updateChat(chatId, { title, titleSource: "user" });
  return true;
}

export async function autoName(chatId: string) {
  const { settings, chats } = useStore.getState();
  if (!settings.naming.enabled) return;
  const chat = chats.find((c) => c.id === chatId);
  const question = chat?.messages.find((m) => m.role === "user");
  if (!chat || chat.titleSource || !question) return;

  const asked = question.content.trim() || (question.attachments ?? []).map((a) => a.name).join(", ");
  if (!asked) return;
  const content = `User prompt to title:\n\n${clip(asked, 1500)}`;
  const title = await generateText({ system: NAMING_SYSTEM, content, sessionId: `${chatId}-title`, chat, clean: cleanTitle });
  if (!title) return;
  // The user may have renamed it while we were waiting.
  const latest = useStore.getState().chats.find((c) => c.id === chatId);
  if (latest && latest.titleSource !== "user") useStore.getState().updateChat(chatId, { title, titleSource: "auto" });
}
