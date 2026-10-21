// Automatic chat titles: after the first reply, ask the configured naming models (in order,
// falling back on failure) for a short title.
import { streamOnce } from "./api";
import { fastTarget, findModel } from "./models";
import { completeOnce } from "./pi";
import { useStore } from "./store";
import type { NamingModel } from "./types";

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

/** Configured naming models that are currently usable, else the fastest available model, else the thread's own. */
function candidates(own?: NamingModel): NamingModel[] {
  const { settings, detection } = useStore.getState();
  const usable = settings.naming.models.filter((m) => findModel(detection, m) && (m.plan === "pi" || settings.keys[m.plan]?.length));
  if (usable.length) return usable;
  const fast = fastTarget(detection, settings);
  return [...(fast ? [{ ...fast, effort: "low" as const }] : []), ...(own && own.id !== fast?.id ? [own] : [])];
}

export async function autoName(chatId: string) {
  const { settings, chats } = useStore.getState();
  if (!settings.naming.enabled) return;
  const chat = chats.find((c) => c.id === chatId);
  const question = chat?.messages.find((m) => m.role === "user");
  const answer = chat?.messages.find((m) => m.role === "assistant" && m.content.trim());
  if (!chat || chat.titleSource || !question || !answer) return;

  const asked = question.content.trim() || (question.attachments ?? []).map((a) => a.name).join(", ");
  const content = `Conversation to title:\n\nUser: ${clip(asked, 1500)}\n\nAssistant: ${clip(answer.content, 1500)}`;

  const own = answer.model && { plan: answer.model.plan, id: answer.model.id, effort: "off" as const };
  for (const cand of candidates(own)) {
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
