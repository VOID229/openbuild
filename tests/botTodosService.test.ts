// OpenBots' pages (html_render) and to-do lists (todo), on the server: what a bot's tools post and
// change, what they refuse, what's kept in the database and sent to the app, and what bots read back.
// Each runs in a child with its own data folder, so nothing touches the real one.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

async function run(name: string, script: string) {
  const dir = await mkdtemp(join(tmpdir(), `openbuild-bots-${name}-`));
  try {
    const { code, stderr: err } = await spawnScript(script, { OPENCHAT_DATA_DIR: dir });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("html_render posts a page with the message, checked like a thread's, and bots read it back by its title", () =>
  run("pages", `
    import { strict as a } from 'node:assert';
    import * as db from './server/bots/db.ts';
    import * as svc from './server/bots/service.ts';
    import { showPage, setFocus } from './server/bots/agent.ts';
    import { transcript, activityFor } from './server/bots/runner.ts';
    import { piFlags } from './server/bots/extensions.ts';
    svc.setHooks({ wake: () => {}, stop: () => {} });
    const pip = svc.createBot({ name: 'Pip' });
    const sal = svc.createBot({ name: 'Sal' });
    const group = svc.createConversation({ kind: 'group', name: 'Crew', botIds: [pip.bot.id, sal.bot.id] });
    const events = [];
    svc.subscribe((e) => events.push(e));
    setFocus(pip.bot.id, group.id);

    const html = '<!doctype html><html><body><div style="height:120px">Chart</div></body></html>';
    const out = showPage(pip.bot.id, { html, title: '  Weekly   signups ', height: 99999 });
    const stored = db.getMessage(out.id);
    a.equal(stored.conversationId, group.id);
    a.equal(stored.message.author, pip.bot.id);
    a.equal(stored.message.text, '');
    a.deepEqual(stored.message.html, { title: 'Weekly signups', html, height: 4000 });
    a.ok(events.some((e) => e.t === 'message' && e.message.id === out.id && e.message.html.html === html));
    // In the app's snapshot, with the conversation.
    a.equal(svc.snapshot().conversations.find((c) => c.id === group.id).messages.at(-1).html.title, 'Weekly signups');
    // Other bots read it as a page, by its title; search finds it too.
    a.match(transcript(group.id, db.listBots(), 'Sam', sal.bot.id), /Pip: \\(showed a page: “Weekly signups”\\)/);
    a.equal(db.searchMessages('signups', [group.id]).length, 1);
    a.equal(activityFor('html_render', { title: 'Weekly signups' }), 'Drawing Weekly signups');

    // The same checks as a thread's page.
    a.throws(() => showPage(pip.bot.id, { html: '   ', title: 'Empty' }), /empty/);
    a.throws(() => showPage(pip.bot.id, { html: '<div style="height:100vh">x</div>', title: 'Tall' }), /viewport height/);
    a.throws(() => showPage(pip.bot.id, { html: 'x'.repeat(600_000), title: 'Big' }), /over 512 KB/);
    a.equal(showPage(pip.bot.id, { html, title: '' }) && db.messages(group.id, 1)[0].message.html.title, 'Page');
    // Only bots show pages, and only in chats they're in.
    a.throws(() => svc.postMessage(group.id, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: '', html: { title: 'Mine', html } }), /shown by bots/);
    a.throws(() => svc.postMessage(group.id, { id: crypto.randomUUID(), author: pip.bot.id, at: Date.now(), text: '', html: { title: 'Bad' } }), /needs its HTML/);
    const other = svc.createConversation({ kind: 'group', name: 'Other', botIds: [sal.bot.id, svc.createBot({ name: 'Kit' }).bot.id] });
    a.throws(() => showPage(pip.bot.id, { html, title: 'Elsewhere', conversation: other.id.slice(0, 8) }), /aren't in that conversation|No such conversation/);

    // Every bot engine runs on Pi, which gets both new tools in its list.
    const tools = piFlags()[piFlags().indexOf('--tools') + 1].split(',');
    a.ok(tools.includes('html_render') && tools.includes('todo'));
    process.exit(0);
  `));

test("todo keeps a conversation's list in its own table, for its bots and the user, and the app and bots see it", () =>
  run("todos", `
    import { strict as a } from 'node:assert';
    import * as db from './server/bots/db.ts';
    import * as svc from './server/bots/service.ts';
    import { todo, setFocus } from './server/bots/agent.ts';
    import { transcript, activityFor } from './server/bots/runner.ts';
    svc.setHooks({ wake: () => {}, stop: () => {} });
    const pip = svc.createBot({ name: 'Pip' });
    const sal = svc.createBot({ name: 'Sal' });
    const kit = svc.createBot({ name: 'Kit' });
    const group = svc.createConversation({ kind: 'group', name: 'Crew', botIds: [pip.bot.id, sal.bot.id] });
    const events = [];
    svc.subscribe((e) => events.push(e));
    setFocus(pip.bot.id, group.id);
    setFocus(sal.bot.id, group.id);

    a.equal(todo(pip.bot.id, { action: 'list' }), 'The to-do list is empty.');
    const listed = todo(pip.bot.id, { action: 'add', items: ['Write the copy', '  Draw   the hero ', '', 'Deploy'] });
    a.match(listed, /To-do list, 0\\/3 done:\\n1\\. \\[\\w{6}\\] \\[ \\] Write the copy\\n2\\. \\[\\w{6}\\] \\[ \\] Draw the hero\\n3\\./);
    let list = db.todos(group.id);
    a.deepEqual(list.map((t) => [t.text, t.status, t.by]), [['Write the copy', 'todo', pip.bot.id], ['Draw the hero', 'todo', pip.bot.id], ['Deploy', 'todo', pip.bot.id]]);
    // The app hears of it with the conversation, and gets it in the snapshot.
    a.deepEqual(events.filter((e) => e.t === 'conversation').at(-1).conversation.todos.map((t) => t.text), ['Write the copy', 'Draw the hero', 'Deploy']);
    a.equal(svc.snapshot().conversations.find((c) => c.id === group.id).todos.length, 3);

    // By number or short id; whoever starts an item is on it.
    todo(pip.bot.id, { action: 'update', item: '1', state: 'doing' });
    todo(sal.bot.id, { action: 'update', item: list[1].id.slice(0, 6), state: 'doing' });
    todo(pip.bot.id, { action: 'done', item: '#1' });
    list = db.todos(group.id);
    a.deepEqual(list.map((t) => [t.status, t.bot]), [['done', pip.bot.id], ['doing', sal.bot.id], ['todo', undefined]]);
    // The others read the list with the chat, and who's on what.
    const seen = transcript(group.id, db.listBots(), 'Sam', pip.bot.id);
    a.match(seen, /To-do list, 1\\/3 done:\\n1\\. \\[\\w{6}\\] \\[x\\] Write the copy \\(you\\)\\n2\\. \\[\\w{6}\\] \\[doing\\] Draw the hero \\(Sal\\)\\n3\\. \\[\\w{6}\\] \\[ \\] Deploy/);
    a.equal(activityFor('todo', {}), 'Updating the to-do list');

    // What it refuses.
    a.throws(() => todo(pip.bot.id, { action: 'update', item: '9', state: 'done' }), /No such item/);
    a.throws(() => todo(pip.bot.id, { action: 'update', item: '2', state: 'finished' }), /todo, doing or done/);
    a.throws(() => todo(pip.bot.id, { action: 'add', items: [] }), /Write the item/);
    a.throws(() => todo(pip.bot.id, { action: 'shuffle' }), /add, update, remove, clear or list/);
    // Room made by dropping done items still isn't enough: two open items and 49 new ones.
    a.throws(() => todo(pip.bot.id, { action: 'add', items: Array.from({ length: 49 }, (_, i) => 'Step ' + i) }), /up to 50/);
    a.equal(db.todos(group.id).length, 3);
    a.throws(() => svc.editTodos(group.id, { action: 'add', items: ['Sneak in'] }, kit.bot.id), /isn't in this conversation/);
    const side = svc.createConversation({ kind: 'side', botIds: [pip.bot.id, sal.bot.id] });
    a.throws(() => svc.editTodos(side.id, { action: 'add', items: ['Nope'] }, pip.bot.id), /Side chats don't have/);

    // The user's side: their own ids, ticking off, removing.
    const mine = crypto.randomUUID();
    svc.editTodos(group.id, { action: 'add', items: ['Book the call'], ids: [mine] }, 'me');
    svc.editTodos(group.id, { action: 'update', id: list[1].id, status: 'done' }, 'me');
    list = db.todos(group.id);
    a.deepEqual(list.at(-1), { id: mine, text: 'Book the call', status: 'todo', by: 'me', at: list.at(-1).at });
    // The user ticking an item off leaves the bot that was on it.
    a.equal(list[1].bot, sal.bot.id);
    svc.editTodos(group.id, { action: 'remove', id: mine }, 'me');
    a.equal(todo(pip.bot.id, { action: 'clear', which: 'done' }), 'To-do list, 0/1 done:\\n1. [' + list[2].id.slice(0, 6) + '] [ ] Deploy');

    // A record read before a change can't put an old list back: the list isn't in it.
    const before = db.getConversation(group.id);
    a.equal('todos' in before, false);
    todo(pip.bot.id, { action: 'add', items: ['Later'] });
    db.putConversation({ ...before, todos: [] });
    a.equal(db.todos(group.id).length, 2);
    a.equal(JSON.parse(db.db.query('SELECT data FROM conversations WHERE id = ?').get(group.id).data).todos, undefined);

    // A 1:1 has one too; clearing it all empties the row; deleting the chat takes it.
    setFocus(pip.bot.id, pip.conversationId);
    todo(pip.bot.id, { action: 'add', items: ['Only here'] });
    a.equal(db.todos(pip.conversationId).length, 1);
    a.equal(db.todos(group.id).length, 2);
    todo(pip.bot.id, { action: 'clear' });
    a.equal(db.db.query('SELECT COUNT(*) AS n FROM todos WHERE conversation_id = ?').get(pip.conversationId).n, 0);
    svc.deleteConversation(group.id);
    a.equal(db.todos(group.id).length, 0);
    process.exit(0);
  `));

test("a to-do list is temporary: new work after a finished list starts over, and old lists clear by themselves", () =>
  run("todos-expire", `
    import { strict as a } from 'node:assert';
    import * as db from './server/bots/db.ts';
    import * as svc from './server/bots/service.ts';
    import { todo, setFocus } from './server/bots/agent.ts';
    import { TODO_DONE_KEEP_MS, TODO_STALE_MS, todoExpired } from './shared/bots.ts';
    svc.setHooks({ wake: () => {}, stop: () => {} });
    const pip = svc.createBot({ name: 'Pip' });
    const sal = svc.createBot({ name: 'Sal' });
    const group = svc.createConversation({ kind: 'group', name: 'Crew', botIds: [pip.bot.id, sal.bot.id] });
    const events = [];
    svc.subscribe((e) => events.push(e));
    setFocus(pip.bot.id, group.id);

    // Adding to an unfinished list keeps it.
    todo(pip.bot.id, { action: 'add', items: ['Write the copy', 'Deploy'] });
    todo(pip.bot.id, { action: 'done', item: '1' });
    todo(pip.bot.id, { action: 'add', items: ['Tell the team'] });
    a.deepEqual(db.todos(group.id).map((t) => t.text), ['Write the copy', 'Deploy', 'Tell the team']);
    // Once it's all done, the next steps are a new list.
    todo(pip.bot.id, { action: 'done', item: '2' });
    todo(pip.bot.id, { action: 'done', item: '3' });
    todo(pip.bot.id, { action: 'add', items: ['Plan the launch'] });
    a.deepEqual(db.todos(group.id).map((t) => [t.text, t.status]), [['Plan the launch', 'todo']]);

    // When a list has had its time.
    const done = [{ id: 'a', text: 'x', status: 'done', by: pip.bot.id, at: 0 }];
    const open = [{ id: 'b', text: 'y', status: 'doing', by: pip.bot.id, at: 0 }];
    a.equal(todoExpired([], 0, TODO_STALE_MS * 2), false);
    a.equal(todoExpired(done, 0, TODO_DONE_KEEP_MS - 1), false);
    a.equal(todoExpired(done, 0, TODO_DONE_KEEP_MS), true);
    a.equal(todoExpired(open, 0, TODO_DONE_KEEP_MS * 4), false);
    a.equal(todoExpired(open, 0, TODO_STALE_MS), true);

    // The scheduler clears a finished list after a while, and tells the app; an unfinished one stays.
    const direct = svc.directId(sal.bot.id);
    setFocus(sal.bot.id, direct);
    todo(sal.bot.id, { action: 'add', items: ['Still going'] });
    todo(pip.bot.id, { action: 'done', item: '1' });
    svc.clearOldTodos(Date.now() + TODO_DONE_KEEP_MS - 60_000);
    a.equal(db.todos(group.id).length, 1);
    events.length = 0;
    svc.clearOldTodos(Date.now() + TODO_DONE_KEEP_MS + 1000);
    a.deepEqual(db.todos(group.id), []);
    a.equal(db.todos(direct).length, 1);
    const sent = events.filter((e) => e.t === 'conversation');
    a.equal(sent.length, 1);
    a.equal(sent[0].conversation.id, group.id);
    a.equal(sent[0].conversation.todos, undefined);
    // And any list nobody has touched in hours.
    svc.clearOldTodos(Date.now() + TODO_STALE_MS + 1000);
    a.deepEqual(db.todos(direct), []);
    process.exit(0);
  `));

test("done items don't pile up: a list still going drops the ones finished a while ago, and bots are told to clear them", () =>
  run("todos-tidy", `
    import { strict as a } from 'node:assert';
    import * as db from './server/bots/db.ts';
    import * as svc from './server/bots/service.ts';
    import { todo, setFocus, contextFor } from './server/bots/agent.ts';
    import { TODO_DONE_ITEM_MS, TODO_DONE_KEEP_MS, TODO_DONE_RECENT, TODO_LIMIT, todoTidy } from './shared/bots.ts';
    svc.setHooks({ wake: () => {}, stop: () => {} });
    // Timings a user would call a short while, and a few kept for context.
    a.ok(TODO_DONE_KEEP_MS <= 10 * 60_000 && TODO_DONE_ITEM_MS <= 15 * 60_000 && TODO_DONE_RECENT >= 1);

    // The rule itself: done items go once finished long enough ago, bar the last few; open ones stay.
    const item = (id, status, doneAt) => ({ id, text: id, status, by: 'me', at: 0, ...(doneAt === undefined ? {} : { doneAt }) });
    const now = 10 * TODO_DONE_ITEM_MS;
    const old = now - TODO_DONE_ITEM_MS;
    const going = [item('d1', 'done', old - 4), item('d2', 'done', old - 3), item('d3', 'done', old - 2), item('d4', 'done', old - 1), item('d5', 'done', old), item('o', 'doing'), item('t', 'todo')];
    a.deepEqual(todoTidy(going, now, now).map((t) => t.id), ['d3', 'd4', 'd5', 'o', 't'].slice(3 - TODO_DONE_RECENT));
    // Not yet: the same list back, unchanged.
    a.equal(todoTidy(going, now, old + 1), going);
    // A few done items are no pile: they stay however old.
    const few = [item('d1', 'done', 0), item('o', 'todo')];
    a.equal(todoTidy(few, now, now), few);
    // Items from before doneAt count from when they were added.
    a.equal(todoTidy([...going.slice(0, 4).map((t) => ({ ...t, doneAt: undefined })), going[5]], now, now).length, TODO_DONE_RECENT + 1);
    // A finished list goes whole, a short while after its last change.
    const finished = going.filter((t) => t.status === 'done');
    a.equal(todoTidy(finished, now, now + TODO_DONE_KEEP_MS - 1), finished);
    a.deepEqual(todoTidy(finished, now, now + TODO_DONE_KEEP_MS), []);

    // Through the tool: done stamps when it was finished, and going back unstamps it.
    const pip = svc.createBot({ name: 'Pip' });
    setFocus(pip.bot.id, pip.conversationId);
    const steps = Array.from({ length: 8 }, (_, i) => 'Step ' + (i + 1));
    todo(pip.bot.id, { action: 'add', items: steps });
    let list = db.todos(pip.conversationId);
    todo(pip.bot.id, { action: 'done', item: list[0].id.slice(0, 6) });
    a.ok(Math.abs(db.todos(pip.conversationId)[0].doneAt - Date.now()) < 5000);
    todo(pip.bot.id, { action: 'update', item: list[0].id.slice(0, 6), state: 'doing' });
    a.equal('doneAt' in db.todos(pip.conversationId)[0], false);
    for (const t of list.slice(0, 6)) todo(pip.bot.id, { action: 'done', item: t.id.slice(0, 6) });
    // Re-marking a done item keeps when it was finished.
    const first = db.todos(pip.conversationId)[0].doneAt;
    todo(pip.bot.id, { action: 'update', item: list[0].id.slice(0, 6), state: 'done', text: 'Step one' });
    a.equal(db.todos(pip.conversationId)[0].doneAt, first);

    // The scheduler drops the done items finished a while ago from the list still going, and the app
    // hears; the list keeps its clock, so it isn't kept alive by being tidied.
    const events = [];
    svc.subscribe((e) => events.push(e));
    const stamp = () => db.db.query('SELECT updated_at AS t FROM todos WHERE conversation_id = ?').get(pip.conversationId).t;
    const before = stamp();
    svc.clearOldTodos(Date.now() + TODO_DONE_ITEM_MS - 60_000);
    a.equal(db.todos(pip.conversationId).length, 8);
    a.equal(events.length, 0);
    svc.clearOldTodos(Date.now() + TODO_DONE_ITEM_MS + 1000);
    list = db.todos(pip.conversationId);
    a.deepEqual(list.map((t) => t.text), ['Step 4', 'Step 5', 'Step 6', 'Step 7', 'Step 8'].slice(3 - TODO_DONE_RECENT));
    a.equal(stamp(), before);
    a.deepEqual(events.filter((e) => e.t === 'conversation').at(-1).conversation.todos.map((t) => t.text), list.map((t) => t.text));
    // Finishing the rest makes a finished list, which clears a short while after.
    for (const t of list.filter((t) => t.status !== 'done')) todo(pip.bot.id, { action: 'done', item: t.id.slice(0, 6) });
    svc.clearOldTodos(Date.now() + TODO_DONE_KEEP_MS - 60_000);
    a.ok(db.todos(pip.conversationId).length > 0);
    svc.clearOldTodos(Date.now() + TODO_DONE_KEEP_MS + 1000);
    a.deepEqual(db.todos(pip.conversationId), []);

    // A full list makes room for new steps by dropping the items finished first.
    todo(pip.bot.id, { action: 'add', items: Array.from({ length: TODO_LIMIT }, (_, i) => 'Item ' + (i + 1)) });
    list = db.todos(pip.conversationId);
    todo(pip.bot.id, { action: 'done', item: list[1].id.slice(0, 6) });
    todo(pip.bot.id, { action: 'done', item: list[0].id.slice(0, 6) });
    todo(pip.bot.id, { action: 'add', items: ['One more'] });
    list = db.todos(pip.conversationId);
    a.equal(list.length, TODO_LIMIT);
    a.deepEqual([list[0].text, list.at(-1).text], ['Item 1', 'One more']);

    // Bots are told to clear done items themselves, and what happens if they don't.
    const prompt = contextFor(pip.bot.id);
    a.match(prompt, /once the work is finished and you've said so, todo clear in that turn; in a long list still going, todo clear which done/);
    a.doesNotMatch(prompt, /clears by itself after a while/);
    const src = await Bun.file('./server/bots/extension.ts').text();
    a.match(src, /don't leave done items on it: clear it once the last item is done and you've said so, clear which done when several are done/);
    process.exit(0);
  `));
