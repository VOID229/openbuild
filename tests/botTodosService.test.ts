// OpenBots' pages (html_render) and to-do lists (todo), on the server: what a bot's tools post and
// change, what they refuse, what's kept in the database and sent to the app, and what bots read back.
// Each runs in a child with its own data folder, so nothing touches the real one.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(name: string, script: string) {
  const dir = await mkdtemp(join(tmpdir(), `openbuild-bots-${name}-`));
  try {
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
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
    a.throws(() => todo(pip.bot.id, { action: 'add', items: Array.from({ length: 48 }, (_, i) => 'Step ' + i) }), /up to 50/);
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
