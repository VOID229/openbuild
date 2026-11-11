import "fake-indexeddb/auto";
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageItem } from "../src/components/MessageItem";
import { botStash, botStashOf, imageFiles, pasteBotStash, pasteStash, stashAction, threadStash, type Stashed } from "../src/lib/stash";
import type { Attachment } from "../shared/types";
import { spawnScript } from "./spawnScript";

const file = (id: string, patch: Partial<Attachment> = {}) => ({ id, name: `${id}.txt`, mime: "text/plain", size: 1, dataUrl: "data:,", ...patch }) as Attachment;
const stashed = (text: string, files: Attachment[] = []): Stashed => ({ id: "s", text, files, createdAt: 0 });

describe("the stash shortcut", () => {
  test("stashes whatever is in the composer, however many stashes there are", () => {
    expect(stashAction(true, 0)).toBe("stash");
    expect(stashAction(true, 1)).toBe("stash");
    expect(stashAction(true, 3)).toBe("stash");
  });
  test("an empty composer takes the only stash, or opens the menu for several", () => {
    expect(stashAction(false, 1)).toBe("use");
    expect(stashAction(false, 2)).toBe("open");
  });
  test("does nothing with no draft and no stash", () => {
    expect(stashAction(false, 0)).toBeUndefined();
  });
});

describe("pasting a stash", () => {
  test("fills an empty composer as it was stashed", () => {
    const f = file("a");
    expect(pasteStash({ text: "", files: [] }, stashed("hello\n", [f]))).toEqual({ text: "hello\n", files: [f] });
    expect(pasteStash({ text: "  \n", files: [] }, stashed("hello"))).toEqual({ text: "hello", files: [] });
  });
  test("keeps what's already written, on its own line", () => {
    const a = file("a");
    const b = file("b");
    expect(pasteStash({ text: "first", files: [a] }, stashed("second", [b]))).toEqual({ text: "first\nsecond", files: [a, b] });
    expect(pasteStash({ text: "first\n", files: [] }, stashed("second")).text).toBe("first\nsecond");
  });
  test("doesn't attach a file mentioned in both twice", () => {
    const mine = file("a", { name: "src/x.ts", mention: true });
    const theirs = file("b", { name: "src/x.ts", mention: true });
    expect(pasteStash({ text: "@src/x.ts", files: [mine] }, stashed("@src/x.ts", [theirs])).files).toEqual([mine]);
  });
});

describe("the OpenBots stash", () => {
  const image = (n: number) => `data:image/jpeg;base64,${n}`;
  test("is its own unless cross-stashing shares OpenBuild's", () => {
    expect(botStashOf(false)).toBe(botStash);
    expect(botStashOf(undefined)).toBe(botStash);
    expect(botStashOf(true)).toBe(threadStash);
    expect(botStash).not.toBe(threadStash);
  });
  test("keeps a message's images as image attachments", () => {
    const [f] = imageFiles(["data:image/png;base64,AAAA"]);
    expect(f).toMatchObject({ mime: "image/png", dataUrl: "data:image/png;base64,AAAA", name: "Image" });
  });
  test("pastes text and images after what's there, up to four images", () => {
    const item = stashed("second", imageFiles([image(2), image(3), image(4)]));
    expect(pasteBotStash({ text: "first", images: [image(1)] }, item)).toEqual({ text: "first\nsecond", images: [image(1), image(2), image(3), image(4)], left: 0 });
    expect(pasteBotStash({ text: "", images: [image(0), image(1)] }, item)).toMatchObject({ images: [image(0), image(1), image(2), image(3)], left: 1 });
  });
  test("counts the files a shared OpenBuild stash carries that a bot can't take", () => {
    const item = stashed("look @src/x.ts", [file("doc", { mime: "application/pdf" }), file("m", { mention: true }), ...imageFiles([image(1)])]);
    expect(pasteBotStash({ text: "", images: [] }, item)).toEqual({ text: "look @src/x.ts", images: [image(1)], left: 1 });
  });
});

describe("stashing a sent message", () => {
  const sent = (content: string, attachments?: Attachment[]) => renderToStaticMarkup(createElement(MessageItem, { message: { id: "m", role: "user", content, attachments, createdAt: 0 }, chatId: "c", isLast: false }));
  test("puts the button to the left of copy", () => {
    const html = sent("hello");
    expect(html).toContain('aria-label="Stash"');
    expect(html.indexOf('aria-label="Stash"')).toBeLessThan(html.indexOf('aria-label="Copy"'));
  });
  test("offers it for a message that's only attachments, not for an empty one", () => {
    expect(sent("", [file("a")])).toContain('aria-label="Stash"');
    const empty = sent("  ", []);
    expect(empty).not.toContain('aria-label="Stash"');
    expect(empty).not.toContain(">0<");
  });
});

// Keep the browser storage shim out of other tests' module caches.
test("stashes survive fresh module loads with attachments, newest first, until removed", async () => {
  const script = `
    import "fake-indexeddb/auto";
    import { expect } from "bun:test";
    const load = (n) => import("./src/lib/stash.ts?stash-persistence=" + n);
    const items = (m) => m.useStash.getState().items;
    const first = await load(1);
    await first.stashReady;
    const file = { id: "f", name: "shot.png", mime: "image/png", size: 1, dataUrl: "data:image/png;base64,AA==" };
    const a = first.addStash("older", [file]);
    await Bun.sleep(2);
    const b = first.addStash("newer", []);
    const second = await load(2);
    await second.stashReady;
    expect(items(second).map((s) => s.text)).toEqual(["newer", "older"]);
    expect(items(second)[1].files).toEqual([file]);
    second.removeStash(b.id);
    const third = await load(3);
    await third.stashReady;
    expect(items(third).map((s) => s.id)).toEqual([a.id]);
    // Changes made while the saved stash is loading win over it.
    const fourth = await load(4);
    fourth.removeStash(a.id);
    const c = fourth.addStash("during load", []);
    await fourth.stashReady;
    expect(items(fourth).map((s) => s.id)).toEqual([c.id]);
    const fifth = await load(5);
    await fifth.stashReady;
    expect(items(fifth).map((s) => s.id)).toEqual([c.id]);
  `;
  const { code, stdout: out, stderr: err } = await spawnScript(script);
  if (code !== 0) throw new Error(`${out}\n${err}`);
  expect(code).toBe(0);
});
