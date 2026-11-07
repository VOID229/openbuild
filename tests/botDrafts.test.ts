import { describe, expect, test } from "bun:test";
import { botDraftKey, draftListeners, draftRecord, draftsReady, getBotDraft, getDraft, saveBotDraft, saveDraft, type StoredDraft } from "../src/lib/drafts";

const png = "data:image/png;base64,iVBORw0KGgo=";
const jpg = "data:image/jpeg;base64,/9j/4AAQ";

describe("OpenBots composer drafts", () => {
  test("are each workspace's own, and this server's older ones are found and moved by its workspace only", async () => {
    await draftsReady;
    saveBotDraft("host", "c9", "for the host", []);
    expect(getBotDraft("srv", "c9", true)).toBeUndefined();
    expect(getBotDraft("host", "c9")?.text).toBe("for the host");
    // A draft from before workspaces, under the bare conversation id.
    saveDraft("bot:c8", "older", []);
    expect(getBotDraft("host", "c8")).toBeUndefined();
    expect(getBotDraft("srv", "c8", true)?.text).toBe("older");
    saveBotDraft("srv", "c8", "older, edited", [], true);
    expect(getDraft("bot:c8")).toBeUndefined();
    expect(getBotDraft("srv", "c8")?.text).toBe("older, edited");
  });

  test("keep text and images per conversation until cleared", async () => {
    await draftsReady;
    saveBotDraft("srv", "c1", "hello @Ada", [png]);
    saveBotDraft("srv", "c2", "other", []);
    expect(getBotDraft("srv", "c1")).toEqual({ text: "hello @Ada", images: [png] });
    expect(getBotDraft("srv", "c2")).toEqual({ text: "other", images: [] });
    saveBotDraft("srv", "c1", "", []);
    expect(getBotDraft("srv", "c1")).toBeUndefined();
    expect(getBotDraft("srv", "c2")?.text).toBe("other");
  });

  test("an image already in the draft isn't stored again as the text changes", async () => {
    await draftsReady;
    const changed: string[] = [];
    const fn = (record: string) => void changed.push(record);
    draftListeners.add(fn);
    try {
      saveBotDraft("srv", "c3", "a", [png]);
      const ids = (draftRecord(`draft:${botDraftKey("srv", "c3")}`) as StoredDraft).fileIds;
      saveBotDraft("srv", "c3", "ab", [png, jpg]);
      const next = (draftRecord(`draft:${botDraftKey("srv", "c3")}`) as StoredDraft).fileIds;
      expect(next[0]).toBe(ids[0]!);
      expect(changed.filter((r) => r.startsWith("draftfile:"))).toHaveLength(2);
      expect(getBotDraft("srv", "c3")?.images).toEqual([png, jpg]);
    } finally {
      draftListeners.delete(fn);
    }
  });
});
