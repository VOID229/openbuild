// Sending from the OpenBots composer, in a real Chrome against a fake workspace on the page
// (tests/fixtures/botSend): the box empties and the message shows in the very next frame, without
// waiting for the workspace; a send the workspace doesn't take comes back to the box, ahead of what
// was typed since; and sending it again, or twice in a row, never makes a second message.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { browser, launchChrome, Page } from "./chromePage";

const FIELD = ".bots-composer-textarea";

class SendPage extends Page {
  async type(text: string) {
    await this.eval(`document.querySelector('${FIELD}').focus()`);
    await this.send("Input.insertText", { text });
    await this.settle();
  }
  /** A real Enter, with what the first frame after it shows: the box, and the rows it holds. */
  async enter() {
    await this.eval(`(() => {
      window.firstFrame = undefined;
      document.addEventListener("keydown", (e) => {
        if (e.key === "Enter") requestAnimationFrame(() => (window.firstFrame = { value: document.querySelector('${FIELD}').value, rows: rows() }));
      }, { capture: true, once: true });
      return true;
    })()`);
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await this.until("window.firstFrame !== undefined");
    return this.eval<{ value: string; rows: Row[] }>("window.firstFrame");
  }
  value() {
    return this.eval<string>(`document.querySelector('${FIELD}').value`);
  }
  rows() {
    return this.eval<Row[]>("rows()");
  }
  posts() {
    return this.eval<{ id: string; text: string; images?: string[]; files?: { id: string; name: string; mime: string; size: number }[] }[]>("workspace.posts");
  }
  set(mode: "ok" | "refuse" | "lost", hold = false) {
    return this.eval(`(workspace.mode = ${JSON.stringify(mode)}, workspace.hold = ${hold}, true)`);
  }
  release() {
    return this.eval("(workspace.release(), true)");
  }
  notice() {
    return this.eval<string | null>("document.querySelector('.bots-composer-notice')?.textContent ?? null");
  }
}
type Row = { id: string; text: string; sending: boolean };

let chrome: Awaited<ReturnType<typeof launchChrome>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
  if (!browser) return;
  const page = (await import("./fixtures/botSend/index.html")).default;
  server = Bun.serve({ port: 0, development: false, routes: { "/": page } });
  chrome = await launchChrome();
}, 60_000);

afterAll(async () => {
  await chrome?.close();
  server?.stop(true);
});

for (const kind of ["direct", "group"] as const) {
  describe.skipIf(!browser)(`sending in a ${kind} chat`, () => {
    const open = async () => {
      const page = await SendPage.open(chrome!.ws, `${server!.url}?kind=${kind}`, 1000, 700, `!!document.querySelector('${FIELD}') && !!document.querySelector('.bm-row')`);
      // The user's own messages, newest last, each with whether it's still on its way.
      await page.eval(`window.rows = () => [...document.querySelectorAll('.bm-mine .bm-row')].map((r) => ({ id: r.dataset.id, text: r.querySelector('.bm-text')?.textContent ?? "", sending: r.getAttribute('aria-busy') === 'true' }))`);
      return page;
    };

    test("the box empties and the message shows in the first frame, before the workspace answers", async () => {
      const page = await open();
      await page.set("ok", true);
      await page.type("hello there");
      const first = await page.enter();
      expect(first.value).toBe("");
      expect(first.rows.at(-1)).toMatchObject({ text: "hello there", sending: true });
      // Still unanswered: the box is free for the next one, with the caret in it.
      expect(await page.eval<boolean>("document.activeElement === document.querySelector('.bots-composer-textarea') && !document.querySelector('.bots-composer-textarea').disabled")).toBe(true);
      await page.type("typed meanwhile");
      // Until the workspace has it, the saved draft keeps it too, so a reload now can't lose it.
      await page.until(`workspace.draft() === "hello there\\ntyped meanwhile"`);
      await page.release();
      await page.until("!rows().at(-1).sending");
      expect((await page.rows()).at(-1)).toMatchObject({ text: "hello there", sending: false });
      expect(await page.value()).toBe("typed meanwhile");
      await page.until(`workspace.draft() === "typed meanwhile"`);
      expect((await page.posts()).map((p) => p.text)).toEqual(["hello there"]);
    }, 60_000);

    test("a dropped video goes up in pieces, waits as a chip, and is sent as a file the message links to", async () => {
      const page = await open();
      await page.set("ok", true);
      // 9 MB: three pieces. A picture in the same drop still goes inside the message.
      await page.eval(`(() => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(9 * 1024 * 1024)], "talk.mp4", { type: "video/mp4" }));
        document.querySelector(".bots-composer").dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
        return true;
      })()`);
      await page.until("!!document.querySelector('.bots-composer-uploading')");
      expect(await page.eval<string>("document.querySelector('.bots-composer-uploading .attachment-meta').textContent")).toContain("Uploading");
      // Not sent while it's still going up.
      await page.type("see this");
      await page.eval(`(document.querySelector(".bots-composer").requestSubmit(), true)`);
      await page.until("!!document.querySelector('.bots-composer-notice')");
      expect(await page.notice()).toContain("Still uploading");
      expect(await page.posts()).toEqual([]);
      for (let i = 0; i < 3; i++) {
        await page.until("workspace.held.length > 0");
        await page.release();
      }
      await page.until("!document.querySelector('.bots-composer-uploading') && !!document.querySelector('.bots-composer-file')");
      const pieces = await page.eval<{ id: string; name: string; offset: number; bytes: number }[]>("workspace.pieces");
      expect(pieces.map((p) => [p.offset, p.bytes])).toEqual([[0, 4 * 1024 * 1024], [4 * 1024 * 1024, 4 * 1024 * 1024], [8 * 1024 * 1024, 1024 * 1024]]);
      expect(await page.eval<string>("document.querySelector('.bots-composer-file .attachment-meta').textContent")).toBe("9.0 MB");
      await page.set("ok", false);
      await page.eval(`(document.querySelector(".bots-composer").requestSubmit(), true)`);
      await page.until("workspace.posts.length === 1 && !document.querySelector('.bots-composer-file')");
      const [post] = await page.posts();
      expect(post).toMatchObject({ text: "see this", files: [{ id: pieces[0]!.id, name: "talk.mp4", mime: "video/mp4", size: 9 * 1024 * 1024 }] });
      expect(post!.images).toBeUndefined();
      // In the conversation it's a chip that opens the file from the workspace.
      await page.until("!!document.querySelector('.bm-mine .bm-file')");
      expect(await page.eval<string>("document.querySelector('.bm-mine .bm-file').getAttribute('href')")).toBe(`/api/workspace/to/srv/api/bots/conversations/chat/files/${pieces[0]!.id}`);
      expect(await page.eval<string>("document.querySelector('.bm-mine .bm-file .attachment-name').textContent")).toBe("talk.mp4");
    }, 60_000);

    test("a refused send comes back ahead of what was typed since, with the caret where it was", async () => {
      const page = await open();
      await page.set("refuse", true);
      await page.type("first try");
      const first = await page.enter();
      expect(first.value).toBe("");
      expect(first.rows.at(-1)?.text).toBe("first try");
      await page.type("and more");
      await page.release();
      await page.until(`document.querySelector('${FIELD}').value.includes("first try")`);
      expect(await page.value()).toBe("first try\nand more");
      // Still typing where it was, after "and more".
      expect(await page.eval<number>(`document.querySelector('${FIELD}').selectionStart`)).toBe("first try\nand more".length);
      expect(await page.notice()).toContain("Not sent");
      // The workspace's own view again: the message isn't in the conversation.
      await page.until(`!rows().some((r) => r.text === "first try")`);
    }, 60_000);

    test("a message sent again after failing keeps its id, so it can't land twice", async () => {
      const page = await open();
      await page.set("refuse");
      await page.type("once only");
      await page.enter();
      await page.until(`document.querySelector('${FIELD}').value === "once only"`);
      await page.set("ok");
      const again = await page.enter();
      expect(again.value).toBe("");
      await page.until(`rows().some((r) => r.text === "once only" && !r.sending)`);
      const posts = await page.posts();
      expect(posts.map((p) => p.text)).toEqual(["once only", "once only"]);
      expect(posts[1]!.id).toBe(posts[0]!.id);
      expect((await page.rows()).filter((r) => r.text === "once only")).toHaveLength(1);
    }, 60_000);

    test("an answer lost on the way doesn't put back a message that landed", async () => {
      const page = await open();
      await page.set("lost");
      await page.type("did it land");
      await page.enter();
      // The workspace's snapshot shows it arrived, so the box stays empty and nothing is sent again.
      await page.until(`rows().some((r) => r.text === "did it land" && !r.sending)`);
      await Bun.sleep(200);
      expect(await page.value()).toBe("");
      expect(await page.notice()).toBeNull();
      expect((await page.posts()).map((p) => p.text)).toEqual(["did it land"]);
      expect(await page.eval<number>("workspace.stored().length")).toBe(31);
    }, 60_000);

    test("Enter twice in a row sends once", async () => {
      const page = await open();
      await page.set("ok", true);
      await page.type("just once");
      await page.eval(`(() => {
        const el = document.querySelector('${FIELD}');
        for (let i = 0; i < 2; i++) el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        return true;
      })()`);
      await page.release();
      await page.until(`rows().some((r) => r.text === "just once" && !r.sending)`);
      expect((await page.posts()).map((p) => p.text)).toEqual(["just once"]);
      expect(await page.value()).toBe("");
    }, 60_000);
  });
}
