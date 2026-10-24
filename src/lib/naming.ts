// Automatic thread titles: as soon as the first user prompt is sent, title the thread.
// Models picked in Settings are tried in order; with none picked, the thread's own model is used
// at the lowest reasoning it supports (no thinking when possible).
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
 * Models that may name threads, in order. Models picked in Settings override the default; with none
 * picked, the model this thread is using names it, at the lowest reasoning it supports.
 */
function candidates(chat: Chat): NamingModel[] {
  const { settings, detection } = useStore.getState();
  const usable = (m: NamingModel) => findModel(detection, m) && (m.plan === "pi" || settings.keys[m.plan]?.length);
  if (settings.naming.models.length) return settings.naming.models.filter(usable);
  const used = chat.messages.find((m) => m.role === "assistant" && m.model)?.model;
  const model = used ? findModel(detection, used) : undefined;
  return used && model ? [{ plan: used.plan, id: used.id, effort: lowestEffort(model.reasoning.efforts) }] : [];
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

  for (const cand of candidates(chat)) {
    const keys = useStore.getState().settings.keys[cand.plan];
    if (cand.plan !== "pi" && !keys?.length) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    let text = "";
    let failed = false;
    try {
      if (cand.plan === "pi") text = await completeOnce(cand.id, NAMING_SYSTEM, content, ctrl.signal);
      else {
        const stream = streamOnce(
          { plan: cand.plan, model: cand.id, effort: cand.effort, system: NAMING_SYSTEM, sessionId: `${chatId}-title`, messages: [{ role: "user", content }] },
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
    const title = cleanTitle(text);
    if (failed || !title) continue;
    // The user may have renamed it while we were waiting.
    const latest = useStore.getState().chats.find((c) => c.id === chatId);
    if (latest && latest.titleSource !== "user") useStore.getState().updateChat(chatId, { title, titleSource: "auto" });
    return;
  }
}
