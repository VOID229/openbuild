import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

async function run(dir: string, script: string) {
  const { code, stdout: out, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: dir });
  if (code !== 0) throw new Error(`${out}\n${err}`);
  return out.trim();
}

// Activity lines in a one-to-one chat ("Opened a thread", "Set a routine") are history, not something
// to come back for: only a bot's actual message leaves the chat unread. Groups keep their policy.
// Isolated: the server's data lives in a temporary directory and is only touched in a subprocess.
test("activity in a one-to-one chat doesn't mark it unread, on the server and after a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-unread-"));
  try {
    const ids = await run(dir, `
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      import * as svc from './server/bots/service.ts';
      svc.setHooks({ wake() {}, stop() {} });
      const made = svc.createBot({ name: 'Solo' });
      const other = svc.createBot({ name: 'Other' });
      for (const id of [made.bot.id, other.bot.id]) svc.updateBot(id, { proactivity: 'off' });
      const bot = made.bot.id, chat = made.conversationId;
      svc.markRead(chat);
      const events = [];
      svc.subscribe((e) => { if (e.t === 'conversation' && e.conversation.id === chat) events.push(e.conversation.unread); });
      let at = Date.now();
      const say = (conversationId, author, text) => svc.postMessage(conversationId, { id: crypto.randomUUID(), author, at: ++at, text });
      const act = (conversationId, author, text) => svc.postMessage(conversationId, { id: crypto.randomUUID(), author, at: ++at, text: '', event: { kind: 'thread', text } });
      const unread = (id) => !!db.getConversation(id).unread;
      const viewed = (id) => !!svc.snapshot().conversations.find((c) => c.id === id).unread;

      // Activity only: kept in history, still read, and the streamed record says so.
      act(chat, bot, 'Opened a thread');
      a.equal(unread(chat), false);
      a.equal(viewed(chat), false);
      a.deepEqual(events, [undefined]);
      a.equal(svc.conversationView(chat).messages.at(-1).event.text, 'Opened a thread');

      // A real message, then activity: the message's unread survives the activity.
      say(chat, bot, 'Here is what I found');
      a.equal(unread(chat), true);
      act(chat, bot, 'Closed a thread');
      a.equal(unread(chat), true);
      a.equal(viewed(chat), true);
      a.deepEqual(events, [undefined, true, true]);

      // Read, then new activity: stays read.
      svc.markRead(chat);
      act(chat, bot, 'Set a routine');
      a.equal(unread(chat), false);
      a.equal(viewed(chat), false);

      // Paging history doesn't change it either way.
      for (let i = 0; i < 205; i++) act(chat, bot, 'Ran a routine');
      a.equal(svc.conversationView(chat).more, true);
      svc.messagePage(chat, svc.conversationView(chat).messages[0].id);
      a.equal(viewed(chat), false);
      say(chat, bot, 'Done');
      svc.messagePage(chat, svc.conversationView(chat).messages[0].id);
      a.equal(viewed(chat), true);

      // Groups are unchanged: a bot's activity there still marks it unread.
      const group = svc.createConversation({ kind: 'group', name: 'Team', botIds: [bot, other.bot.id] });
      svc.markRead(group.id);
      act(group.id, bot, 'Opened a thread');
      a.equal(unread(group.id), true);
      // The user's own messages never do.
      svc.markRead(group.id);
      say(group.id, 'me', 'thanks');
      a.equal(unread(group.id), false);
      act(group.id, other.bot.id, 'Set a routine');
      a.equal(unread(group.id), true);
      console.log(JSON.stringify({ chat, bot, group: group.id }));
      process.exit(0);
    `);
    const { chat, bot, group } = JSON.parse(ids.split("\n").at(-1)!);

    // A restart reads the stored flags back: the real message is still unread, the group too, and
    // activity after a restart still leaves a read chat read.
    expect(await run(dir, `
      import { strict as a } from 'node:assert';
      import * as svc from './server/bots/service.ts';
      svc.setHooks({ wake() {}, stop() {} });
      const view = (id) => svc.snapshot().conversations.find((c) => c.id === id);
      a.equal(view('${chat}').unread, true);
      a.equal(view('${group}').unread, true);
      svc.markRead('${chat}');
      svc.postMessage('${chat}', { id: crypto.randomUUID(), author: '${bot}', at: Date.now() + 10_000, text: '', event: { kind: 'thread', text: 'Opened a thread' } });
      a.equal(view('${chat}').unread, undefined);
      console.log('ok');
      process.exit(0);
    `)).toBe("ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The client keeps its own unread flags between server records: a streamed activity line must not set
// one in a one-to-one chat, nor clear one a real message set, and a later snapshot is the server's word.
test("streamed activity in a one-to-one chat doesn't mark it unread in the sidebar", async () => {
  const script = `
    import { mock } from "bun:test";
    import { resolve } from "node:path";
    import assert from "node:assert/strict";
    mock.module(resolve("src/lib/store.ts"), () => ({ useStore: { getState: () => ({ settings: { profile: {} } }) } }));
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const page = new EventTarget();
    page.visibilityState = "visible";
    globalThis.document = page;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    const { useBots, enterWorkspace } = await import(resolve("src/lib/bots/store.ts"));
    const { useWorkspace } = await import(resolve("src/lib/bots/workspace.ts"));
    useWorkspace.setState({ localId: "srv", localName: "Studio" });
    enterWorkspace("srv");
    const chat = (id, kind, botIds, over = {}) => ({ id, kind, botIds, createdAt: 1, updatedAt: 1, messages: [], ...over });
    const conversations = [chat("open", "direct", ["c"]), chat("dm", "direct", ["a"]), chat("team", "group", ["a", "b"])];
    const snapshot = (list) => ({ t: "snapshot", bots: [], conversations: list, settings: { sections: [] }, typing: {}, drafts: [], status: {} });
    const enc = new TextEncoder();
    const streams = [];
    globalThis.fetch = async (path, init) => {
      if (path !== "/api/workspace/to/srv/api/bots/stream") return Response.json({ ok: true });
      let controller;
      const body = new ReadableStream({ start(c) { controller = c; } });
      const s = { send: (e) => controller.enqueue(enc.encode(JSON.stringify(e) + "\\n")) };
      streams.push(s);
      s.send({ t: "hello", workspace: "srv" });
      s.send(snapshot(conversations));
      return new Response(body);
    };
    useBots.getState().ensureSeeded();
    useBots.getState().select("open");
    await wait(10);
    const stream = streams.at(-1);
    let at = 10;
    const say = (conversationId, author, text) => stream.send({ t: "message", conversationId, message: { id: "m" + at, author, at: ++at, text } });
    const act = (conversationId, author, text) => stream.send({ t: "message", conversationId, message: { id: "m" + at, author, at: ++at, text: "", event: { kind: "thread", text } } });
    const flag = (id) => !!useBots.getState().conversations.find((c) => c.id === id).unread;
    const count = () => useBots.getState().conversations.filter((c) => c.unread && c.id !== "open" && !c.hidden).length;

    // Activity only: it's in the chat's history, and no dot or count.
    act("dm", "a", "Opened a thread");
    await wait(5);
    assert.equal(flag("dm"), false);
    assert.equal(count(), 0);
    assert.equal(useBots.getState().conversations.find((c) => c.id === "dm").messages.at(-1).event.text, "Opened a thread");

    // A real message, then activity: still unread.
    say("dm", "a", "Found it");
    act("dm", "a", "Closed a thread");
    await wait(5);
    assert.equal(flag("dm"), true);
    assert.equal(count(), 1);

    // Read, then new activity: stays read.
    useBots.getState().select("dm");
    useBots.getState().select("open");
    act("dm", "a", "Set a routine");
    await wait(5);
    assert.equal(flag("dm"), false);

    // Groups are unchanged: activity there still counts.
    act("team", "a", "Opened a thread");
    await wait(5);
    assert.equal(flag("team"), true);
    assert.equal(count(), 1);

    // A reload's snapshot is the server's word: a real message's unread comes back as it was stored.
    stream.send(snapshot([chat("open", "direct", ["c"]), chat("dm", "direct", ["a"], { unread: true }), chat("team", "group", ["a", "b"])]));
    await wait(5);
    assert.equal(flag("dm"), true);
    act("dm", "a", "Ran a routine");
    await wait(5);
    assert.equal(flag("dm"), true);
    assert.equal(flag("team"), false);
    console.log("ok");
    process.exit(0);
  `;
  const { code, stdout, stderr } = await spawnScript(script);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(stdout.trim()).toBe("ok");
});
