/** Synced records for drafts: one per chat (text and attachment ids) and one per attachment. */
export const isDraftRecord = (key: string) => key.startsWith("draft:") || key.startsWith("draftfile:");
