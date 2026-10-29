import type { Effort } from "../../shared/types";
import type { Chat, Selection, Settings } from "./types";

/** Provider/plan is part of the identity; auto has its own preference. */
export function effortKey(selection: Selection): string {
  return "auto" in selection ? "auto" : JSON.stringify([selection.plan, selection.id]);
}

/** Existing threads never inherit changes made on the new-thread screen. */
export function effortFor(settings: Settings, chat: Chat | undefined, selection: Selection | undefined): Effort {
  if (!selection) return settings.effort;
  const saved = (chat ? chat.efforts : settings.modelEfforts)?.[effortKey(selection)];
  if (saved) return saved;
  if (chat && !("auto" in selection)) {
    const previous = chat.messages.findLast((m) => m.role === "assistant" && m.model?.plan === selection.plan && m.model.id === selection.id && m.model.effort);
    if (previous?.model?.effort) return previous.model.effort;
  }
  // Keep the old global value only as a migration/default, not as a live toggle.
  return settings.effort;
}

/**
 * The speed (service tier id) for a model; undefined = standard. Kept like effort: per model, on the
 * thread once it exists. An explicit "" records a pick of standard, so it beats the new-thread default.
 */
export function speedFor(settings: Settings, chat: Chat | undefined, selection: Selection | undefined): string | undefined {
  if (!selection || "auto" in selection) return undefined;
  const saved = (chat ? chat.speeds : settings.modelSpeeds)?.[effortKey(selection)];
  if (saved !== undefined) return saved || undefined;
  if (chat) {
    const previous = chat.messages.findLast((m) => m.role === "assistant" && m.model?.plan === selection.plan && m.model.id === selection.id);
    return previous?.model?.speed;
  }
  return undefined;
}

/** A speed the model offers, or undefined (standard). */
export const supportedSpeed = (speeds: { id: string }[] | undefined, speed: string | undefined) => (speed && speeds?.some((s) => s.id === speed) ? speed : undefined);
