import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("in a chat shared with a friend, two servers' bots can't answer each other forever: a person writing starts them again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-friend-run-"));
  try {
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      const svc = await import('./server/bots/service.ts');
      const { friendAuthor, OWNER } = await import('./shared/friends.ts');
      const juniper = svc.createBot({ name: 'Juniper' }).bot.id;
      const friend = 'a'.repeat(24);
      const shared = svc.createConversation({ kind: 'group', name: 'Shared', botIds: [juniper], friend: { friend, friendName: 'Sam', chat: 'c'.repeat(24), members: [{ id: 'theirbot', name: 'Pip' }] } });
      const wakes = [];
      svc.setHooks({ wake: id => wakes.push(id), stop() {} });
      // As without the old bot-loop pause (#202 removes it, and ignores this then): this backstop alone.
      svc.updateSettings({ botLoop: { enabled: false, limit: 8 } });
      const post = (author, text) => svc.postMessage(shared.id, { id: crypto.randomUUID(), author, at: Date.now(), text });
      const pip = friendAuthor(friend, 'theirbot');
      // Their bot and ours, back and forth: ours is woken until it has written FRIEND_RUN times with no person writing.
      for (let i = 0; i < svc.FRIEND_RUN; i++) { post(pip, '@Juniper ' + i); post(juniper, 'reply ' + i); }
      a.equal(wakes.length, svc.FRIEND_RUN);
      post(pip, '@Juniper once more');
      a.equal(wakes.length, svc.FRIEND_RUN);
      // A person, the friend or the user, always gets through, and starts the count again.
      post(friendAuthor(friend, OWNER), '@Juniper hi from Sam');
      a.equal(wakes.length, svc.FRIEND_RUN + 1);
      post(pip, '@Juniper and again');
      a.equal(wakes.length, svc.FRIEND_RUN + 2);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
