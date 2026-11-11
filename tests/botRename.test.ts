import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each script runs against its own data directory, in a process of its own.
async function run(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-rename-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SETUP = `
  import { strict as a } from 'node:assert';
  const db = await import('./server/bots/db.ts');
  const svc = await import('./server/bots/service.ts');
  svc.setHooks({ wake() {}, stop() {} });
  const boss = svc.createBot({ name: 'Boss' }).bot;
  const helper = svc.createBot({ name: 'Helper' }).bot;
  const other = svc.createBot({ name: 'Other' }).bot;
  const group = svc.createConversation({ kind: 'group', name: 'Crew', botIds: [boss.id, helper.id, other.id] });
  const events = (id, kind) => db.messages(id, 50).map((r) => r.message).filter((m) => m.event?.kind === kind);
`;

test("a rename is said in the chat it was made in, once, and leaves it read", async () => {
  await run(`${SETUP}
    svc.markRead(group.id);
    svc.updateBot(helper.id, { name: 'Atlas' }, { by: 'me', conversationId: group.id });
    const line = events(group.id, 'renamed');
    a.equal(line.length, 1);
    a.equal(line[0].event.text, 'Helper is now Atlas');
    a.equal(line[0].event.bot, helper.id);
    a.equal(line[0].author, 'me');
    a.notEqual(db.getConversation(group.id).unread, true);
    // Its own chat isn't told a second time of what the group was.
    a.equal(events(svc.directId(helper.id), 'renamed').length, 0);
    a.equal(events(svc.directId(helper.id), 'changed').length, 1);
    // Nothing else in the group's members' chats.
    a.equal(events(svc.directId(other.id), 'renamed').length, 0);
  `);
});

test("a rename from its own chat, or one naming a chat the bot isn't in, says it in the bot's chat as one line", async () => {
  await run(`${SETUP}
    const outside = svc.createConversation({ kind: 'group', name: 'Elsewhere', botIds: [boss.id, other.id] });
    svc.updateBot(helper.id, { name: 'Atlas' }, { by: 'me' });
    svc.updateBot(helper.id, { name: 'Zed' }, { by: 'me', conversationId: outside.id });
    const own = svc.directId(helper.id);
    a.deepEqual(events(own, 'renamed').map((m) => m.event.text), ['Helper is now Atlas', 'Atlas is now Zed']);
    // The name isn't also listed as a changed setting there.
    a.equal(events(own, 'changed').length, 0);
    a.equal(events(outside.id, 'renamed').length, 0);
  `);
});

test("a bot's own rename leaves the chat unread, as its other lines do", async () => {
  await run(`${SETUP}
    svc.markRead(group.id);
    svc.updateBot(helper.id, { name: 'Atlas' }, { conversationId: group.id });
    a.equal(events(group.id, 'renamed')[0].author, helper.id);
    a.equal(db.getConversation(group.id).unread, true);
  `);
});

test("the renamed bot is told once, on its next turn, whoever renamed it; a run of renames reads as one", async () => {
  await run(`${SETUP}
    svc.updateBot(helper.id, { name: 'Atlas' }, { by: 'me', conversationId: group.id });
    svc.updateBot(helper.id, { name: 'Zed' }, { by: 'me' });
    const notes = svc.pendingRenameNotes(helper.id);
    a.deepEqual(notes, [{ botId: helper.id, from: 'Helper', to: 'Zed' }]);
    a.match(svc.renameNoteText(notes), /renamed from Helper to Zed/);
    // The others aren't told: they read it in the chat.
    a.deepEqual(svc.pendingRenameNotes(other.id), []);
    // Renamed again while the turn ran: what it saw is what it knows.
    svc.updateBot(helper.id, { name: 'Nova' }, { by: 'me' });
    svc.settleRenameNotes(notes);
    a.deepEqual(svc.pendingRenameNotes(helper.id), [{ botId: helper.id, from: 'Zed', to: 'Nova' }]);
    svc.settleRenameNotes(svc.pendingRenameNotes(helper.id));
    a.deepEqual(svc.pendingRenameNotes(helper.id), []);
    // Back to the name it knew: nothing to say.
    svc.updateBot(boss.id, { name: 'Chief' }, { by: 'me' });
    svc.updateBot(boss.id, { name: 'Boss' }, { by: 'me' });
    a.deepEqual(svc.pendingRenameNotes(boss.id), []);
    // Not a change of name: no note, no line.
    svc.updateBot(other.id, { effort: 'high' }, { by: 'me', conversationId: group.id });
    a.deepEqual(svc.pendingRenameNotes(other.id), []);
    a.equal(events(group.id, 'renamed').length, 1);
  `);
});

test("the primary's rename of a bot, asked in a group, says so in that group", async () => {
  await run(`${SETUP}
    const { manage } = await import('./server/bots/agent.ts');
    await manage(boss.id, { action: 'update', bot: 'Helper', name: 'Atlas', conversation: group.id });
    a.equal(events(group.id, 'renamed')[0].event.text, 'Helper is now Atlas');
    a.equal(svc.pendingRenameNotes(helper.id).length, 1);
    process.exit(0);
  `);
});
