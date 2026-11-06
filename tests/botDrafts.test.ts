import { describe, expect, test } from "bun:test";
import { botDraftKey, draftListeners, draftRecord, draftsReady, getBotDraft, saveBotDraft, type StoredDraft } from "../src/lib/drafts";

const png = "data:image/png;base64,iVBORw0KGgo=";
const jpg = "data:image/jpeg;base64,/9j/4AAQ";

describe("OpenBots composer drafts", () => {
  test("keep text and images per conversation until cleared", async () => {
    await draftsReady;
    saveBotDraft("c1", "hello @Ada", [png]);
    saveBotDraft("c2", "other", []);
    expect(getBotDraft("c1")).toEqual({ text: "hello @Ada", images: [png] });
    expect(getBotDraft("c2")).toEqual({ text: "other", images: [] });
    saveBotDraft("c1", "", []);
    expect(getBotDraft("c1")).toBeUndefined();
    expect(getBotDraft("c2")?.text).toBe("other");
  });

  test("an image already in the draft isn't stored again as the text changes", async () => {
    await draftsReady;
    const changed: string[] = [];
    const fn = (record: string) => void changed.push(record);
    draftListeners.add(fn);
    try {
      saveBotDraft("c3", "a", [png]);
      const ids = (draftRecord(`draft:${botDraftKey("c3")}`) as StoredDraft).fileIds;
      saveBotDraft("c3", "ab", [png, jpg]);
      const next = (draftRecord(`draft:${botDraftKey("c3")}`) as StoredDraft).fileIds;
      expect(next[0]).toBe(ids[0]!);
      expect(changed.filter((r) => r.startsWith("draftfile:"))).toHaveLength(2);
      expect(getBotDraft("c3")?.images).toEqual([png, jpg]);
    } finally {
      draftListeners.delete(fn);
    }
  });
});
