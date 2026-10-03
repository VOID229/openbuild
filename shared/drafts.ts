/** Unsent composer drafts are dropped this long after their last edit, on every device and on the sync server. */
export const DRAFT_TTL = 5 * 60_000;

/** Synced records for drafts: one per chat (text and attachment ids) and one per attachment. */
export const isDraftRecord = (key: string) => key.startsWith("draft:") || key.startsWith("draftfile:");
