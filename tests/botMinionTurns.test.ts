// A minion's turns in the real runner, against a fake Pi binary: the Pi it's given (a minion's tools
// and no others), the prompt its turn gets, and its owner being woken by what it says, by its silence,
// and never once it's closed. The service-level rules are in botMinions.test.ts.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unexpectedStderr } from "./botStderr";
import { spawnScript } from "./spawnScript";

/** Logs how it was started and each prompt; says "Reply" in plain text when the mode file says reply, nothing otherwise. */
const FAKE_PI = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const id = arg("--session-id");
const log = (entry) => appendFileSync(process.env.FAKE_LOG, JSON.stringify({ pid: process.pid, id, ...entry }) + "\\n");
if (id) log({ type: "start", tools: arg("--tools"), minion: process.env.OPENBOTS_MINION, preload: process.env.OPENBOTS_PRELOAD, bot: process.env.OPENBOTS_BOT });
const send = (record) => console.log(JSON.stringify(record));
const reply = (c, data) => send({ type: "response", id: c.id, success: true, data });
for await (const line of console) {
  const c = JSON.parse(line);
  if (c.type === "get_available_models") reply(c, { models: [{ provider: "fake", id: "big", contextWindow: 1000000 }] });
  else if (c.type === "get_available_thinking_levels") reply(c, { levels: [] });
  else if (c.type === "clear_queue") reply(c, { steering: [], followUp: [] });
  else if (c.type === "prompt") {
    const mode = existsSync(process.env.FAKE_MODE) ? readFileSync(process.env.FAKE_MODE, "utf8").trim() : "";
    log({ type: "prompt", message: c.message, mode });
    reply(c, { disposition: "started" });
    // What it says without a tool is the turn's reply: the runner posts it in the turn's chat.
    if (mode === "reply") send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Found 12 TODOs in 3 files." } });
    setTimeout(() => send({ type: "agent_settled" }), 10);
  } else reply(c, c.type === "get_state" ? {} : undefined);
}
`;

test("a minion runs on a Pi with a minion's tools, reports to its owner, and stops for good once closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "bot-minion-turns-"));
  try {
    writeFileSync(join(root, "pi"), FAKE_PI, { mode: 0o700 });
    const { code, stdout, stderr } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const { MINION_TOOLS } = await import('./shared/bots.ts');
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      svc.setHooks({ wake: runner.wake, stop: runner.stop, halt: runner.halt, forget: runner.forget });
      svc.updateSettings({ onboarding: 'done', user: { name: 'Gal' } });
      const { bot: owner, conversationId: direct } = svc.createBot({ name: 'Scout' });
      const events = () => existsSync(process.env.FAKE_LOG) ? readFileSync(process.env.FAKE_LOG, 'utf8').split('\\n').filter(Boolean).map(l => JSON.parse(l)) : [];
      const prompts = (id) => events().filter(e => e.type === 'prompt' && e.id === id);
      const starts = (id) => events().filter(e => e.type === 'start' && e.id === id);
      const until = async (ok, what) => { for (let i = 0; i < 1500 && !ok(); i++) await Bun.sleep(10); a.ok(ok(), what); };
      const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const mode = m => writeFileSync(process.env.FAKE_MODE, m);
      const idle = () => !runner.busy(owner.id) && !runner.busy(minion.id);
      const TASK = 'Count the TODOs in ~/app and list the files.';

      // The task wakes the minion: its turn runs on a Pi of its own, told it's a minion's.
      mode('reply');
      const { bot: minion, conversationId: chat } = svc.createMinion(owner.id, { task: TASK, name: 'Todo counter', from: direct });
      await until(() => prompts(minion.id).length === 1, "the minion's turn never started");
      const [started] = starts(minion.id);
      a.equal(started.bot, minion.id);
      a.equal(started.tools, MINION_TOOLS.join(','));
      a.equal(started.minion, MINION_TOOLS.join(','));
      // No usual tools of its own yet: it starts with the computer's.
      a.equal(started.preload, 'bash,read,write,edit');
      const first = prompts(minion.id)[0].message;
      a.match(first, /Your conversation with Scout, the bot you work for\\. Its first message is your task/);
      a.ok(first.includes('Scout: ' + TASK));
      a.ok(first.endsWith(runner.MINION_CLOSING));
      a.doesNotMatch(first, /\\[silent\\]/);

      // What it said is in its chat, and woke its owner in the chat the task came from, on the owner's own Pi.
      await until(() => prompts(owner.id).length === 1, 'the owner was never woken by the report');
      a.deepEqual(db.messages(chat).filter((r) => !r.message.event).map((r) => [r.message.author, r.message.text]), [[owner.id, TASK], [minion.id, 'Found 12 TODOs in 3 files.']]);
      const told = prompts(owner.id)[0].message;
      a.match(told, /Your minion Todo counter \\(\\w{8}\\) wrote, about the task you gave it \\(“Count the TODOs in ~\\/app and list the files\\.”\\):\\nFound 12 TODOs in 3 files\\./);
      a.ok(told.includes('Conversation ' + direct.slice(0, 8)));
      a.ok(told.endsWith(runner.CLOSING));
      // An ordinary bot's Pi has every tool, the minion one among them, and isn't told it's a minion.
      const [ownerPi] = starts(owner.id);
      a.ok(ownerPi.tools.split(',').includes('minion'));
      a.equal(ownerPi.minion, undefined);
      // The owner's plain reply went to its own chat, and didn't loop back to the minion.
      await until(idle, 'the turns never settled');
      a.equal(prompts(minion.id).length, 1);
      a.equal(db.messages(direct).filter((r) => !r.message.event).at(-1).message.text, 'Found 12 TODOs in 3 files.');

      // Asked for more, it says nothing this time: its owner is told that, so it never waits on silence.
      mode('quiet');
      svc.postMessage(chat, { id: crypto.randomUUID(), author: owner.id, at: Date.now(), text: 'Also count the FIXMEs.' }, { from: direct });
      await until(() => prompts(minion.id).length === 2, 'the follow-up never reached the minion');
      a.equal(starts(minion.id).length, 1, 'the same Pi took its second turn');
      await until(() => prompts(owner.id).length === 2, 'the owner was never told of the silence');
      a.match(prompts(owner.id)[1].message, /Your minion Todo counter \\(\\w{8}\\) ended its turn without reporting on the task you gave it/);
      await until(idle, 'the turns never settled');

      // Closed: its Pi is gone, and nothing wakes it, not even a wake that names it.
      svc.closeMinion(owner.id, minion.id);
      await until(() => !alive(started.pid), "the closed minion's Pi kept running");
      runner.wake(minion.id, { kind: 'messages', conversationId: chat });
      svc.wakeBot(minion.id, { kind: 'note', conversationId: chat, text: 'Wake up.' });
      await Bun.sleep(300);
      a.equal(prompts(minion.id).length, 2);
      a.equal(runner.busy(minion.id), false);

      // Reopened, its owner's next message runs it again, on a new Pi that picks its session up.
      mode('reply');
      svc.reopenMinion(owner.id, minion.id);
      svc.postMessage(chat, { id: crypto.randomUUID(), author: owner.id, at: Date.now(), text: 'One more pass.' }, { from: direct });
      await until(() => prompts(minion.id).length === 3, 'the reopened minion never ran');
      a.equal(starts(minion.id).length, 2);
      a.equal(starts(minion.id)[1].tools, MINION_TOOLS.join(','));
      await until(() => prompts(owner.id).length === 3 && idle(), 'the owner never heard from the reopened minion');

      // Deleted, it leaves nothing on disk: its Pi's folder goes with it.
      const folder = join(db.botsDir(), 'minds', minion.id);
      a.ok(existsSync(folder));
      svc.closeMinion(owner.id, minion.id);
      await svc.deleteBot(minion.id);
      a.equal(existsSync(folder), false);
      a.ok(existsSync(join(db.botsDir(), 'minds', owner.id)));
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: join(root, "data"), PI_BIN: join(root, "pi"), PI_CODING_AGENT_DIR: join(root, "agent"), FAKE_LOG: join(root, "log.jsonl"), FAKE_MODE: join(root, "mode"), OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(root, "secrets.json") });
    if (code !== 0) console.error(stdout, stderr);
    expect(unexpectedStderr(stderr)).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
