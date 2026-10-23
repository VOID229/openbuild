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
