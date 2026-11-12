import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";
import { botModelChain, castVote, fallbackMode, findMentions, findTags, isSilent, makePoll, matchMentionBots, mentionBroadcastAt, pollVotesVisible, pollWaitingOn, replyBubbles } from "../shared/bots";

test("[silent] never becomes a bubble", () => {
  expect(isSilent(" [SILENT]\n")).toBe(true);
  expect(isSilent("[silent] but not really")).toBe(false);
  expect(replyBubbles("[silent]")).toEqual([]);
  expect(replyBubbles("Sure!\n\n[silent]")).toEqual(["Sure!"]);
  expect(replyBubbles("One\n\nTwo")).toEqual(["One", "Two"]);
});

test("@mentions match a bot's whole name, spaces and all", () => {
  const bots = [{ name: "Dr Eggbot" }, { name: "Dr" }, { name: "helper · notes" }];
  const found = (text: string) => findMentions(text, bots).map((m) => [text.slice(m.start, m.end), m.bot.name]);
  expect(found("hey @dr eggbot, and @helper")).toEqual([["@dr eggbot", "Dr Eggbot"], ["@helper", "helper · notes"]]);
  expect(found("@Dr hi")).toEqual([["@Dr", "Dr"]]);
  expect(found("me@helper.com @helpers")).toEqual([]);
});

test("a half-typed name doesn't tag a bot whose name has a space", () => {
  const found = (text: string) => findMentions(text, [{ name: "Dr Eggbot" }]).map((m) => text.slice(m.start, m.end));
  expect(found("@Dr")).toEqual([]);
  expect(found("@Dr Egg")).toEqual([]);
  expect(found("@Dr Eggbot hi")).toEqual(["@Dr Eggbot"]);
});

test("@all and @everyone tag the whole conversation, among the bots' own mentions", () => {
  const bots = [{ name: "Dr Eggbot" }, { name: "All" }, { name: "All Stars" }];
  const found = (text: string) => findTags(text, bots).map((t) => [text.slice(t.start, t.end), t.bot?.name]);
  expect(found("@Dr Eggbot and @ALL, @everyone")).toEqual([["@Dr Eggbot", "Dr Eggbot"], ["@ALL", undefined], ["@everyone", undefined]]);
  expect(found("@all")).toEqual([["@all", undefined]]);
  expect(found("@all stars")).toEqual([["@all stars", "All Stars"]]);
  expect(found("me@all.com @allison @all-hands")).toEqual([]);
});

test("polls letter their options and keep one vote per voter", () => {
  const poll = makePoll(" Lunch? ", ["Pizza", " pizza ", "", "Tacos", "Soup"]);
  expect(poll.question).toBe("Lunch?");
  expect(poll.options).toEqual([{ key: "A", label: "Pizza" }, { key: "B", label: "Tacos" }, { key: "C", label: "Soup" }]);
  const once = castVote(poll, "me", ["A", "B"]);
  expect(once.votes[0]!.keys).toEqual(["A"]);
  expect(castVote(once, "me", ["C"]).votes.map((v) => v.keys)).toEqual([["C"]]);
  expect(castVote(once, "me", []).votes).toEqual([]);
  expect(castVote(makePoll("Lunch?", ["Pizza", "Tacos"], { multiple: true }), "me", ["B", "A", "Z"]).votes[0]!.keys).toEqual(["A", "B"]);
});

test("a poll waits on the other bots, and on the user if a bot asked", () => {
  const poll = castVote(makePoll("Lunch?", ["Pizza", "Tacos"]), "b", ["A"]);
  expect(pollWaitingOn(poll, "me", ["a", "b"])).toEqual(["a"]);
  expect(pollWaitingOn(poll, "a", ["a", "b"])).toEqual(["me"]);
  expect(pollWaitingOn(castVote(poll, "a", ["B"]), "me", ["a", "b"])).toEqual([]);
  const blind = castVote(makePoll("Lunch?", ["Pizza", "Tacos"], { blind: true }), "a", ["A"]);
  expect(pollVotesVisible(blind, "b")).toBe(false);
  expect(pollVotesVisible(blind, "a")).toBe(true);
  expect(pollVotesVisible({ ...blind, closedAt: 1 }, "b")).toBe(true);
  expect(pollVotesVisible(poll, "c")).toBe(true);
});

test("polls ask the whole group, from the user or a bot, and only in groups", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-poll-"));
  try {
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      import * as svc from './server/bots/service.ts';
      import { startPoll, votePoll, setFocus } from './server/bots/agent.ts';
      import { transcript, successfulMessageTool, activityFor } from './server/bots/runner.ts';

      const woken = [];
      svc.setHooks({ wake: (id, w) => woken.push({ id, ...w }), stop: () => {} });
      const pip = svc.createBot({ name: 'Pip' });
      const sal = svc.createBot({ name: 'Sal' });
      const kit = svc.createBot({ name: 'Kit' });
      const group = svc.createConversation({ kind: 'group', name: 'Crew', botIds: [pip.bot.id, sal.bot.id, kit.bot.id] });
      const bots = db.listBots();
      const poll = (extra = {}) => ({ question: 'Lunch?', options: [{ key: 'A', label: 'Pizza' }, { key: 'B', label: 'Tacos' }], votes: [], ...extra });

      // The user's poll wakes every bot, and whatever votes it arrived with are dropped.
      woken.length = 0;
      const mine = { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: '', poll: poll({ votes: [{ by: 'me', keys: ['A'], at: 1 }] }) };
      const posted = svc.postMessage(group.id, mine);
      a.equal(posted.text, 'Lunch?');
      a.deepEqual(posted.poll.votes, []);
      a.deepEqual(woken.map((w) => w.id).sort(), [pip.bot.id, sal.bot.id, kit.bot.id].sort());

      // Each bot sees it owed a vote until it has voted, by letter, in any case.
      const short = mine.id.slice(0, 8);
      a.match(transcript(group.id, bots, 'Sam', pip.bot.id), /Poll, pick one: “Lunch\\?”[\\s\\S]*A\\) Pizza[\\s\\S]*You haven't voted/);
      setFocus(pip.bot.id, group.id);
      votePoll(pip.bot.id, { message: short, choices: ['b'] });
      const seen = transcript(group.id, bots, 'Sam', pip.bot.id);
      a.match(seen, /B\\) Tacos \\(you\\)/);
      a.doesNotMatch(seen, /You haven't voted/);
      a.throws(() => votePoll(pip.bot.id, { message: short, choices: ['A', 'B'] }), /takes one answer/);
      a.throws(() => votePoll(pip.bot.id, { message: short, choices: ['Z'] }), /no option Z/);
      a.throws(() => votePoll(pip.bot.id, { message: short, choices: [] }), /at least one/);
      votePoll(pip.bot.id, { message: short, choices: ['A'] });
      a.deepEqual(db.getMessage(mine.id).message.poll.votes.map((v) => [v.by, v.keys]), [[pip.bot.id, ['A']]]);

      // The user's poll closes when every bot has answered, whether or not the user has.
      setFocus(sal.bot.id, group.id);
      setFocus(kit.bot.id, group.id);
      votePoll(sal.bot.id, { message: short, choices: ['A'] });
      a.equal(db.getMessage(mine.id).message.poll.closedAt, undefined);
      woken.length = 0;
      votePoll(kit.bot.id, { message: short, choices: ['B'] });
      a.ok(db.getMessage(mine.id).message.poll.closedAt);
      a.equal(woken.length, 0);
      const events = () => db.messages(group.id, 50).filter((r) => r.message.event?.kind === 'poll').map((r) => r.message.event);
      a.equal(events().at(-1).text, 'Poll closed');
      a.match(transcript(group.id, bots, 'Sam', sal.bot.id), /Poll \\(closed\\), pick one/);

      // A changed answer stays quiet until it has lasted; going back drops it.
      const realNow = Date.now;
      let clock = realNow();
      Date.now = () => clock;
      const later = (ms) => { clock += ms; svc.tick(() => true); };
      votePoll(kit.bot.id, { message: short, choices: ['A'] });
      votePoll(kit.bot.id, { message: short, choices: ['B'] });
      later(svc.POLL_CHANGE_SETTLE + 1);
      a.equal(events().length, 1);
      votePoll(kit.bot.id, { message: short, choices: ['A'] });
      later(svc.POLL_CHANGE_SETTLE - 1);
      a.equal(events().length, 1);
      later(1);
      a.equal(events().length, 2);
      a.equal(events().at(-1).text, 'Kit changed their answer');
      a.match(events().at(-1).detail, /Tacos → Pizza/);
      later(svc.POLL_CHANGE_SETTLE + 1);
      a.equal(events().length, 2);
      // The user changing their own poll's answer tells nobody; a closed poll can't lose an answer.
      svc.votePoll(group.id, mine.id, 'me', ['A']);
      svc.votePoll(group.id, mine.id, 'me', ['B']);
      later(svc.POLL_CHANGE_SETTLE + 1);
      a.equal(events().length, 2);
      a.throws(() => svc.votePoll(group.id, mine.id, 'me', []), /closed/);
      a.throws(() => votePoll(kit.bot.id, { message: short, choices: ['Z'] }), /no option/);

      // A bot's poll is blind by default, and waits on the other bots and the user.
      woken.length = 0;
      const started = startPoll(pip.bot.id, { question: 'Tea or coffee?', options: ['Tea', 'Coffee', 'Tea'], multiple: true });
      const startedShort = started.id.slice(0, 8);
      const stored = () => db.getMessage(started.id).message.poll;
      a.equal(stored().options.length, 2);
      a.equal(stored().blind, true);
      a.deepEqual(woken.map((w) => w.id).sort(), [sal.bot.id, kit.bot.id].sort());
      woken.length = 0;
      votePoll(sal.bot.id, { message: startedShort, choices: ['A', 'B'] });
      // Kit can't see Sal's answer before voting; Sal can see their own.
      const blindFor = (id) => transcript(group.id, bots, 'Sam', id).split('Tea or coffee?')[1];
      a.doesNotMatch(blindFor(kit.bot.id), /Sal/);
      a.match(blindFor(kit.bot.id), /Answers stay hidden[\\s\\S]*You haven't voted/);
      a.match(blindFor(sal.bot.id), /Tea \\(you\\)/);
      a.doesNotMatch(blindFor(pip.bot.id), /Sal/);
      votePoll(kit.bot.id, { message: startedShort, choices: ['B'] });
      a.equal(stored().closedAt, undefined);
      a.equal(woken.length, 0);
      svc.votePoll(group.id, started.id, 'me', ['A']);
      a.ok(stored().closedAt);
      a.equal(woken.length, 1);
      a.equal(woken[0].id, pip.bot.id);
      a.match(woken[0].text, /Everyone has answered[\\s\\S]*B\\) Coffee: Sal, Kit/);
      a.match(blindFor(pip.bot.id), /Tea \\(Sal, Sam\\)/);

      // A changed answer that lasts reaches the bot that asked, not the chat.
      woken.length = 0;
      const eventCount = events().length;
      votePoll(sal.bot.id, { message: startedShort, choices: ['B'] });
      a.equal(woken.length, 0);
      later(svc.POLL_CHANGE_SETTLE + 1);
      a.equal(woken.length, 1);
      a.equal(woken[0].id, pip.bot.id);
      a.equal(woken[0].kind, 'note');
      a.match(woken[0].text, /Sal changed their answer[\\s\\S]*Tea, Coffee → Coffee/);
      a.equal(events().length, eventCount);
      Date.now = realNow;

      // Answers can be shown from the start, and someone leaving can finish a poll.
      const open = startPoll(pip.bot.id, { question: 'Open?', options: ['Yes', 'No'], hide_votes: false });
      a.equal(db.getMessage(open.id).message.poll.blind, undefined);
      svc.votePoll(group.id, open.id, 'me', ['A']);
      votePoll(sal.bot.id, { message: open.id.slice(0, 8), choices: ['A'] });
      a.equal(db.getMessage(open.id).message.poll.closedAt, undefined);
      woken.length = 0;
      svc.updateConversation(group.id, { botIds: [pip.bot.id, sal.bot.id] });
      a.ok(db.getMessage(open.id).message.poll.closedAt);
      a.equal(woken[0].id, pip.bot.id);

      // Bad polls and other kinds of chat are turned away.
      setFocus(pip.bot.id, group.id);
      a.throws(() => startPoll(pip.bot.id, { question: 'Hm?', options: ['Only', 'only'] }), /two different options/);
      a.throws(() => startPoll(pip.bot.id, { question: '', options: ['A', 'B'] }), /question/);
      a.throws(() => svc.postMessage(pip.conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: '', poll: poll() }), /group chats/);
      a.throws(() => svc.votePoll(group.id, group.messages[0].id, 'me', ['A']), /isn't a poll/);

      const event = { type: 'tool_execution_end', toolName: 'poll', result: { details: { id: 'posted' } } };
      a.equal(successfulMessageTool(event), true);
      a.equal(successfulMessageTool({ ...event, toolName: 'vote_poll', result: { details: { ok: true } } }), false);
      a.equal(activityFor('vote_poll', {}), 'Voting in the poll');
      // A status the bot wrote wins over the canned one, cleaned up to one short line.
      a.equal(activityFor('edit', { path: 'notes/school.md', status: 'updating your school.md' }), 'Updating your school.md');
      a.equal(activityFor('bash', { command: 'ls', status: '  Restoring that previous layout...\\nand more' }), 'Restoring that previous layout');
      a.equal(activityFor('bash', { command: 'ls', status: 'x'.repeat(80) }), 'X' + 'x'.repeat(48) + '…');
      a.equal(activityFor('bash', { command: 'ls', status: '  ' }), 'Running a command');
      a.equal(activityFor('bash', { command: 'ls', status: 42 }), 'Running a command');
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("computer tools never silently fall back to unrestricted host access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-computer-"));
  try {
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { mock } from 'bun:test';
      let engines = [];
      const calls = [];
      mock.module('./server/computers/index.ts', () => ({ capabilities: async () => ({ engines }), engines: async () => engines, procListeners: new Set() }));
      mock.module('./server/computers/api.ts', () => ({ computerApi: (device) => ({ call: async (id, op, body) => { calls.push({ device, id, op, body }); return {}; } }), computerTargets: async () => [] }));
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const { sendMessage, setFocus } = await import('./server/bots/agent.ts');
      const { bot, conversationId } = svc.createBot({ name: 'Sandbox' });
      setFocus(bot.id, conversationId);
      // This server's isolation is a container until the user chooses otherwise; with no engine, nothing runs.
      await a.rejects(sendMessage(bot.id, { text: 'Screenshot', attach_screenshot: true }), /no container engine .* choose Host for .* in Settings → Devices. Nothing ran/);
      a.equal(calls.length, 0);
      engines = ['podman'];
      await sendMessage(bot.id, { text: 'Screenshot', attach_screenshot: true });
      a.deepEqual([calls[0].device, calls[0].op, calls[0].body.kind], ['local', 'ensure', 'container']);
      // A host computer saved for the bot by an earlier build is kept, and changes nothing.
      db.putBot({ ...db.getBot(bot.id), computer: { device: 'local', kind: 'host' } });
      engines = [];
      calls.length = 0;
      await a.rejects(sendMessage(bot.id, { text: 'Screenshot', attach_screenshot: true }), /no container engine/);
      a.equal(calls.length, 0);
      a.deepEqual(db.getBot(bot.id).computer, { device: 'local', kind: 'host' });
      // Host on this server is the user's choice for the machine, in Settings → Devices.
      svc.updateSettings({ isolation: { local: 'host' } });
      await sendMessage(bot.id, { text: 'Explicit host screenshot', attach_screenshot: true });
      a.equal(calls[0].body.kind, 'host');
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("web search uses the user's providers and keeps their keys from the bot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-search-"));
  try {
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { mock } from 'bun:test';
      mock.module('./server/computers/index.ts', () => ({ capabilities: async () => ({ engines: [] }), engines: async () => [], procListeners: new Set() }));
      mock.module('./server/computers/api.ts', () => ({ computerApi: () => ({ call: async () => ({}) }), computerTargets: async () => [] }));
      const svc = await import('./server/bots/service.ts');
      const vault = await import('./server/vault.ts');
      const { webSearch, webSearchNote } = await import('./server/bots/agent.ts');
      const { activityFor } = await import('./server/bots/runner.ts');
      const { bot } = svc.createBot({ name: 'Scout' });
      a.equal(activityFor('bot_web_search', { query: 'x' }), 'Searching the web');

      // Nothing set up: the bot is told where the user adds a provider.
      a.match(await webSearchNote(), /Settings → Bots → Web search/);
      await a.rejects(webSearch(bot.id, { query: 'tea' }), /isn't set up/);
      await a.rejects(webSearch(bot.id, { query: ' ' }), /what to search for/);

      await vault.setKeys('brave', [{ secret: 'BRAVE-SECRET' }]);
      await vault.setKeys('youtube', [{ secret: 'YT-SECRET' }]);
      svc.updateSettings({ searxng: [' http://searx.test:8080 ', 'http://searx.test:8080', 5] });
      a.deepEqual(svc.getSettings().searxng, ['http://searx.test:8080']);

      const note = await webSearchNote();
      a.match(note, /- brave:/);
      a.match(note, /- searxng:/);
      a.doesNotMatch(note, /- exa:/);
      a.doesNotMatch(note, /SECRET/);

      const seen = [];
      globalThis.fetch = async (url, init) => {
        seen.push({ url: String(url), token: new Headers(init.headers).get('x-subscription-token') });
        if (String(url).includes('googleapis')) throw new Error('failed: ' + url);
        const results = [{ title: 'Green tea', url: 'https://tea.test/green', description: 'About tea', content: 'About tea' }];
        return Response.json(String(url).includes('brave') ? { web: { results } } : { results });
      };

      const brave = await webSearch(bot.id, { query: 'tea', provider: 'brave', count: 2 });
      a.equal(seen.at(-1).token, 'BRAVE-SECRET');
      a.match(seen.at(-1).url, /count=2/);
      a.match(brave, /https:\\/\\/tea.test\\/green/);
      a.doesNotMatch(brave, /SECRET/);

      // No provider named: the cheapest one.
      await webSearch(bot.id, { query: 'tea' });
      a.match(seen.at(-1).url, /^http:\\/\\/searx.test:8080\\/search/);

      // Only providers the user set up, and never the server-side page reader.
      const before = seen.length;
      await a.rejects(webSearch(bot.id, { query: 'tea', provider: 'exa' }), /exa isn't set up/);
      await a.rejects(webSearch(bot.id, { query: 'tea', provider: 'fetch_url', url: 'http://localhost/' }), /isn't set up/);
      a.equal(seen.length, before);

      // A key in a failure doesn't reach the bot.
      await a.rejects(webSearch(bot.id, { query: 'tea', provider: 'youtube' }), (err) => {
        a.doesNotMatch(err.message, /YT-SECRET/);
        a.match(err.message, /YouTube/);
        return true;
      });

      // Resetting OpenBots keeps how the user searches and their default model, with its fallbacks.
      svc.updateSettings({ defaultModel: 'anthropic/shared', defaultFallbackModels: ['openai-codex-2/gpt-6.1-sol'] });
      await svc.resetAll();
      a.deepEqual(svc.getSettings().searxng, ['http://searx.test:8080']);
      a.equal(svc.getSettings().defaultModel, 'anthropic/shared');
      a.deepEqual(svc.getSettings().defaultFallbackModels, ['openai-codex-2/gpt-6.1-sol']);
      a.deepEqual(await vault.secrets('brave'), ['BRAVE-SECRET']);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir, OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Dr Eggbot introduces itself on first open, asks whether the user codes, and offers the starter team only to developers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-welcome-"));
  try {
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      import * as svc from './server/bots/service.ts';
      import { askUser, contextFor, setFocus } from './server/bots/agent.ts';
      const woken = [];
      svc.setHooks({ wake: (botId, wake) => woken.push({ botId, wake }), stop() {} });
      svc.ensureStarted();
      const bot = db.listBots()[0];
      const conversationId = svc.directId(bot.id);
      a.equal(bot.primary, true);
      a.equal(bot.name, 'Dr Eggbot');
      a.deepEqual(bot.look, { shape: 'cloud', color: 'white' });
      a.match(bot.instructions, /primary bot/);
      a.equal(svc.getSettings().onboarding, 'active');
      a.equal(db.messages(conversationId, 10).length, 0);

      // Nothing is written for it: the bot is woken to write its own welcome.
      await svc.greetOnFirstOpen();
      a.equal(db.messages(conversationId, 10).length, 0);
      a.equal(woken.length, 1);
      a.equal(woken[0].botId, bot.id);
      a.equal(woken[0].wake.kind, 'note');
      a.equal(woken[0].wake.conversationId, conversationId);
      a.match(woken[0].wake.text, /Introduce yourself/);
      a.match(woken[0].wake.text, /offer "developer"/);
      a.match(woken[0].wake.text, /If they say they do, offer them a starter team .*offer "team"/);
      a.match(woken[0].wake.text, /If they say they don't: There's no developer starter team to offer them.*don't offer it or bring it up again/);
      a.match(woken[0].wake.text, /they can still make their own bots and teams whenever they like, or ask you to make them/);
      a.match(woken[0].wake.text, /Never say they have no team/);
      a.equal(svc.getSettings().onboarding, 'done');

      // Opening it again is just opening it.
      await svc.greetOnFirstOpen();
      a.equal(woken.length, 1);

      // It asks whether the user codes first, with the app's choices, whatever it wrote.
      setFocus(bot.id, conversationId);
      const ask = (id, chat, p) => { askUser(id, p); return db.messages(chat, 20).map(r => r.message).filter(m => m.question).at(-1); };
      const dev = ask(bot.id, conversationId, { title: 'Do you write code?', options: ['Sure', 'Nope'], offer: 'developer' });
      a.equal(dev.question.offer, 'developer');
      a.deepEqual(dev.question.options.map(o => o.label), ['Yes, I write code', 'No, not really']);
      a.doesNotMatch(contextFor(bot.id), /starter team/, 'no team before they answer');

      // Yes: the bot is told to offer the team, with what each does.
      svc.answerQuestion(conversationId, dev.id, 'A');
      a.equal(db.listBots().length, 1, 'saying yes makes nothing by itself');
      a.match(contextFor(bot.id), /they write code. Now offer them a starter team .*offer "team": Manager, Tracer, Researcher.*Tracer reviews and tests/);

      // The bot's offer gets the app's choices, whatever it wrote.
      const offer = ask(bot.id, conversationId, { title: 'Want a team?', options: ['Sure', 'Maybe', 'No'], offer: 'team' });
      a.equal(offer.author, bot.id);
      a.equal(offer.question.offer, 'team');
      a.deepEqual(offer.question.options.map(o => o.label), ['Set up the team', 'Not now']);
      a.match(contextFor(bot.id), /You offered the user a starter team/);
      a.doesNotMatch(contextFor(bot.id), /Now offer them/, 'offered once');
      woken.length = 0;

      // Taking the offer makes the team, with a group, once.
      svc.answerQuestion(conversationId, offer.id, 'A');
      svc.answerQuestion(conversationId, offer.id, 'A');
      const team = db.listBots().filter(b => !b.primary);
      a.deepEqual(team.map(b => b.name).sort(), ['Manager', 'Researcher', 'Tracer']);
      a.ok(team.every(b => b.by === bot.id && b.instructions));
      const byName = Object.fromEntries(team.map(b => [b.name, b]));
      a.equal(byName.Manager.threads.enabled, true);
      a.equal(byName.Manager.threads.merge, true);
      a.equal(byName.Tracer.threads.enabled, true);
      a.equal(byName.Tracer.threads.merge, false);
      a.equal(byName.Researcher.threads, undefined);
      // The team's looks: Manager a yellow house, Tracer a blue tablet, Researcher a green blob.
      a.deepEqual(byName.Manager.look, { shape: 'house', color: 'amber' });
      a.deepEqual(byName.Tracer.look, { shape: 'tablet', color: 'blue' });
      a.deepEqual(byName.Researcher.look, { shape: 'blob', color: 'green' });
      a.deepEqual(db.listBots().find(b => b.primary).look, { shape: 'cloud', color: 'white' });
      const group = db.listConversations().find(c => c.kind === 'group');
      a.equal(group.name, 'Team');
      a.deepEqual([...group.botIds].sort(), [bot.id, ...team.map(b => b.id)].sort());
      a.equal(db.messages(conversationId, 20).filter(r => r.message.event?.kind === 'created').length, 3);
      a.equal(woken.length, 0, 'the new bots wait to be spoken to');

      // Saying no to the team makes nothing.
      await svc.resetAll();
      let again = db.listBots()[0];
      let chat = svc.directId(again.id);
      a.equal(woken.at(-1).botId, again.id, 'a reset welcomes again');
      a.match(woken.at(-1).wake.text, /offer "developer"/);
      setFocus(again.id, chat);
      svc.answerQuestion(chat, ask(again.id, chat, { title: 'Code?', offer: 'developer' }).id, 'A');
      svc.answerQuestion(chat, ask(again.id, chat, { title: 'Want a team?', offer: 'team' }).id, 'B');
      a.equal(db.listBots().length, 1);

      // Not a developer: no team offer, now or later, and no team.
      await svc.resetAll();
      again = db.listBots()[0];
      chat = svc.directId(again.id);
      setFocus(again.id, chat);
      const no = ask(again.id, chat, { title: 'Do you write code?', offer: 'developer' });
      svc.answerQuestion(chat, no.id, 'B');
      svc.answerQuestion(chat, no.id, 'A');
      const told = contextFor(again.id);
      a.match(told, /don't really write code. There's no developer starter team to offer them.*don't offer it or bring it up again/);
      a.match(told, /what you can still help with yourself/);
      a.match(told, /they can still make their own bots and teams whenever they like, or ask you to make them, which you can do with manage_bot/);
      a.match(told, /Never say they have no team, or suggest teams aren't available/);
      a.doesNotMatch(told, /offer "team"/);
      a.throws(() => askUser(again.id, { title: 'Want a team?', offer: 'team' }), /isn't for them/);
      a.equal(db.messages(chat, 20).filter(r => r.message.question?.offer === 'team').length, 0);
      a.equal(db.listBots().length, 1);
      a.equal(db.listConversations().filter(c => c.kind === 'group').length, 0);

      // Their own words: the bot judges them, and may still offer the team.
      await svc.resetAll();
      again = db.listBots()[0];
      chat = svc.directId(again.id);
      setFocus(again.id, chat);
      svc.answerQuestion(chat, ask(again.id, chat, { title: 'Do you write code?', offer: 'developer' }).id, 'A bit of Python at work');
      a.match(contextFor(again.id), /in their own words: “A bit of Python at work”. If that means they write code, offer them a starter team .*If it doesn't: There's no developer starter team to offer them.*make their own bots and teams whenever they like/);
      const typed = ask(again.id, chat, { title: 'Want a team?', offer: 'team' });
      a.equal(typed.question.offer, 'team');
      svc.answerQuestion(chat, typed.id, 'A');
      a.equal(db.listBots().length, 4);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("send_message, models and check-ins against a real bots database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-"));
  try {
    await Bun.write(join(dir, "pi", "settings.json"), JSON.stringify({ defaultProvider: "openrouter", defaultModel: "deepseek/flash" }));
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      import * as svc from './server/bots/service.ts';
      import { sendMessage, setFocus, routine } from './server/bots/agent.ts';
      import { applyModel, applyEffort, successfulMessageTool, transcript, onRecord, activityFor, modelError } from './server/bots/runner.ts';

      const { bot, conversationId } = svc.createBot({ name: 'Egg' });
      setFocus(bot.id, conversationId);
      const count = () => db.messages(conversationId, 50).length;
      const { forwardedImages } = await import('./server/bots/threads.ts');
      const imageId = crypto.randomUUID();
      svc.postMessage(conversationId, { id: imageId, author: 'me', at: Date.now(), text: 'Screenshot', images: ['data:image/png;base64,aGVsbG8='] });
      a.deepEqual(forwardedImages(bot.id, [imageId.slice(0, 8)]), [{ mimeType: 'image/png', data: 'aGVsbG8=' }]);
      a.deepEqual(forwardedImages(bot.id, [imageId, imageId]), [{ mimeType: 'image/png', data: 'aGVsbG8=' }]);
      a.deepEqual(forwardedImages(bot.id, undefined), []);
      a.throws(() => forwardedImages(bot.id, 'latest'), /array/);
      a.throws(() => forwardedImages('not-a-member', [imageId]), /No such image message/);


      // [silent] through send_message posts nothing; real text still does.
      const before = count();
      const skipped = await sendMessage(bot.id, { text: ' [silent] ' });
      a.equal(skipped.id, undefined);
      a.match(skipped.note, /Nothing was sent/);
      a.equal(count(), before);
      await sendMessage(bot.id, { text: 'hello' });
      a.equal(count(), before + 1);

      // While the chat shows it typing, a bubble waits until it could have been typed; otherwise it goes at once.
      svc.setTyping(conversationId, bot.id, true);
      let t = Date.now();
      await sendMessage(bot.id, { text: 'one' });
      a.ok(Date.now() - t >= 450, 'a typed bubble takes a moment');
      svc.setTyping(conversationId, bot.id, false);
      t = Date.now();
      await sendMessage(bot.id, { text: 'two' });
      a.ok(Date.now() - t < 200, 'an untyped bubble is immediate');
      a.equal(count(), before + 3);

      // A session resumes on its last model, so "default" has to switch back; matching models don't re-send.
      const fake = (provider, id) => {
        const sent = [];
        return { sent, send: async (cmd) => { sent.push(cmd); return cmd.type === 'get_state' ? { model: { provider, id } } : {}; } };
      };
      let proc = fake('anthropic', 'old');
      await applyModel(proc, bot.id);
      a.deepEqual(proc.sent.at(-1), { type: 'set_model', provider: 'openrouter', modelId: 'deepseek/flash' });
      proc = fake('openrouter', 'deepseek/flash');
      await applyModel(proc, bot.id);
      a.equal(proc.sent.length, 1);

      svc.updateBot(bot.id, { model: 'anthropic/picked' });
      proc = fake('openrouter', 'deepseek/flash');
      await applyModel(proc, bot.id);
      a.deepEqual(proc.sent.at(-1), { type: 'set_model', provider: 'anthropic', modelId: 'picked' });
      svc.updateBot(bot.id, { model: '' });
      a.equal(db.getBot(bot.id).model, undefined);

      // A bot on Default follows the default for all bots; one with its own model keeps it.
      svc.updateSettings({ defaultModel: 'anthropic/shared' });
      proc = fake('openrouter', 'deepseek/flash');
      await applyModel(proc, bot.id);
      a.deepEqual(proc.sent.at(-1), { type: 'set_model', provider: 'anthropic', modelId: 'shared' });
      svc.updateBot(bot.id, { model: 'anthropic/picked' });
      proc = fake('anthropic', 'shared');
      await applyModel(proc, bot.id);
      a.deepEqual(proc.sent.at(-1), { type: 'set_model', provider: 'anthropic', modelId: 'picked' });
      svc.updateBot(bot.id, { model: '' });

      // Clearing the default for all bots goes back to Pi's.
      svc.updateSettings({ defaultModel: '' });
      a.equal(svc.getSettings().defaultModel, undefined);
      proc = fake('anthropic', 'shared');
      await applyModel(proc, bot.id);
      a.deepEqual(proc.sent.at(-1), { type: 'set_model', provider: 'openrouter', modelId: 'deepseek/flash' });

      // A model Pi refuses fails the run rather than falling back quietly.
      svc.updateBot(bot.id, { model: 'anthropic/gone' });
      await a.rejects(applyModel({ send: async (cmd) => { if (cmd.type === 'set_model') throw new Error('Model not found'); return {}; } }, bot.id), /Model not found/);
      // One Pi doesn't list at all, its extension switched off say, says so rather than Pi's bare refusal.
      const refusing = (models) => ({ send: async (cmd) => { if (cmd.type === 'set_model') throw new Error('Model not found'); return cmd.type === 'get_available_models' ? { models } : {}; } });
      await a.rejects(applyModel(refusing([{ provider: 'mock', id: 'm' }]), bot.id), /anthropic\\/gone isn't available to bots\\. Its extension may be switched off in Settings → Bots\\.$/);
      // Listed but refused (no key, say) keeps Pi's reason.
      await a.rejects(applyModel(refusing([{ provider: 'anthropic', id: 'gone' }]), bot.id), /Model not found/);

      // Effort uses Pi's supported levels, after the model has been selected.
      svc.updateBot(bot.id, { effort: 'high' });
      const effortCommands = [];
      await applyEffort({ send: async (cmd) => { effortCommands.push(cmd); return { levels: ['off', 'low', 'medium'] }; } }, bot.id);
      a.deepEqual(effortCommands, [{ type: 'get_available_thinking_levels' }, { type: 'set_thinking_level', level: 'medium' }]);
      svc.updateBot(bot.id, { effort: 'low' });
      effortCommands.length = 0;
      await applyEffort({ send: async (cmd) => { effortCommands.push(cmd); return { levels: ['low', 'high'] }; } }, bot.id);
      a.deepEqual(effortCommands.at(-1), { type: 'set_thinking_level', level: 'low' });
      effortCommands.length = 0;
      await applyEffort({ send: async (cmd) => { effortCommands.push(cmd); return { levels: [] }; } }, bot.id);
      a.equal(effortCommands.length, 1);

      // Starting, failing, or skipping a messaging tool must not suppress final-text fallback.
      const event = { type: 'tool_execution_end', toolName: 'send_message', isError: false, result: { details: { id: 'posted' } } };
      a.equal(successfulMessageTool({ ...event, type: 'tool_execution_start' }), false);
      a.equal(successfulMessageTool({ ...event, isError: true }), false);
      a.equal(successfulMessageTool({ ...event, result: { isError: true, details: { id: 'posted' } } }), false);
      a.equal(successfulMessageTool({ ...event, result: { details: { note: 'Nothing was sent' } } }), false);
      a.equal(successfulMessageTool(event), true);
      a.equal(successfulMessageTool({ ...event, toolName: 'question' }), true);
      a.equal(successfulMessageTool({ ...event, toolName: 'memory' }), false);

      // A missing selector used to match the first routine via startsWith('').
      const makeRoutine = (id, title) => svc.saveRoutine(bot.id, { id, title, schedule: 'every hour', enabled: true });
      const first = makeRoutine('routine-one', 'Same');
      const second = makeRoutine('routine-two', 'Same');
      for (const action of ['pause', 'resume', 'remove']) {
        a.throws(() => routine(bot.id, { action }), /Name the routine/);
        a.throws(() => routine(bot.id, { action, id: 'routine-' }), /ambiguous/);
        a.throws(() => routine(bot.id, { action, title: 'Same' }), /ambiguous/);
      }
      a.equal(db.routines(bot.id).length, 2);
      a.equal(db.routines(bot.id).find(r => r.id === first.id).enabled, true);
      routine(bot.id, { action: 'pause', id: first.id });
      a.equal(db.routines(bot.id).find(r => r.id === first.id).enabled, false);
      const other = svc.createBot({ name: 'Other' });
      svc.updateBot(other.bot.id, { proactivity: 'off' });
      a.throws(() => routine(other.bot.id, { action: 'remove', id: second.id }), /No such routine/);
      a.throws(() => svc.saveRoutine(other.bot.id, { ...second, title: 'stolen' }), /routine/i);
      a.equal(db.routineOwner(second.id), bot.id);

      // The chat shows typing only while a message is being written; other work shows as an activity.
      const mind = { proc: { send: async () => ({}) }, token: '', busy: true, sent: false, draft: '', typing: false, quiet: false, activity: 'Working on it' };
      const typingNow = () => (svc.snapshot().typing[conversationId] ?? []).includes(bot.id);
      onRecord(bot.id, mind, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } });
      a.equal(typingNow(), false);
      onRecord(bot.id, mind, { type: 'tool_execution_start', toolName: 'browser', args: { action: 'open', url: 'https://www.example.com/x' } });
      a.equal(svc.snapshot().status[bot.id].activity, 'Opening example.com');
      a.equal(typingNow(), false);
      // The step is over the moment its tool ends: its line doesn't stay up while the model works out the next one.
      onRecord(bot.id, mind, { type: 'tool_execution_end', toolName: 'browser', result: {} });
      a.equal(svc.snapshot().status[bot.id].activity, 'Getting it done');
      onRecord(bot.id, mind, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', toolName: 'send_message', contentIndex: 0 } });
      a.equal(typingNow(), true);
      onRecord(bot.id, mind, { type: 'tool_execution_end', toolName: 'send_message', result: {} });
      a.equal(typingNow(), false);
      a.equal(svc.snapshot().status[bot.id].quiet, true);
      onRecord(bot.id, mind, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '[sil' } });
      a.equal(typingNow(), false);
      // Work after the message shows in the chat again, and keeps up as it moves from tool to tool.
      onRecord(bot.id, mind, { type: 'tool_execution_start', toolName: 'openbuild', args: { action: 'list' } });
      a.equal(svc.snapshot().status[bot.id].quiet, undefined);
      a.equal(svc.snapshot().status[bot.id].activity, 'Checking on threads');
      a.equal(svc.snapshot().status[bot.id].thread, undefined);
      onRecord(bot.id, mind, { type: 'tool_execution_end', toolName: 'openbuild', result: {} });
      // A call about one thread names it in the status while it runs, so that thread's mascot wakes; then it dozes again.
      onRecord(bot.id, mind, { type: 'tool_execution_start', toolName: 'openbuild', args: { action: 'send', thread: ' 1a2b3c4d ', text: 'go on' } });
      a.equal(svc.snapshot().status[bot.id].thread, '1a2b3c4d');
      onRecord(bot.id, mind, { type: 'tool_execution_end', toolName: 'openbuild', result: {} });
      a.equal(svc.snapshot().status[bot.id].state, 'working');
      a.equal(svc.snapshot().status[bot.id].thread, undefined);
      onRecord(bot.id, mind, { type: 'tool_execution_start', toolName: 'bash', args: { command: 'gh pr checks', status: 'Watching CI on #115' } });
      a.equal(svc.snapshot().status[bot.id].quiet, undefined);
      a.equal(svc.snapshot().status[bot.id].activity, 'Watching CI on #115');
      onRecord(bot.id, mind, { type: 'tool_execution_end', toolName: 'bash', result: {} });
      a.notEqual(svc.snapshot().status[bot.id].activity, 'Watching CI on #115');
      onRecord(bot.id, mind, { type: 'tool_execution_start', toolName: 'send_message', args: {} });
      a.equal(typingNow(), true);
      onRecord(bot.id, mind, { type: 'tool_execution_end', toolName: 'send_message', result: {} });
      a.equal(svc.snapshot().status[bot.id].quiet, true);
      // A reaction is no work to show.
      onRecord(bot.id, mind, { type: 'tool_execution_start', toolName: 'react', args: {} });
      a.equal(svc.snapshot().status[bot.id].quiet, true);
      // Nor is a turn for a reaction, until it writes.
      mind.quiet = 'reaction';
      onRecord(bot.id, mind, { type: 'tool_execution_start', toolName: 'read', args: { path: '/home/x/notes.md' } });
      a.equal(svc.snapshot().status[bot.id].quiet, true);
      mind.quiet = false;
      a.equal(activityFor('read', { path: '/home/x/notes.md' }), 'Reading notes.md');

      // Thinking aloud between tool calls never shows as a bubble: it would flash up and vanish when the tool starts.
      const draftNow = () => svc.snapshot().drafts.find(d => d.conversationId === conversationId && d.botId === bot.id)?.text;
      onRecord(bot.id, mind, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Green. Verify head…' } });
      a.equal(draftNow(), undefined);
      a.equal(typingNow(), false);
      onRecord(bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'Green. Verify head…' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: {} }] } });
      a.equal(draftNow(), undefined);
      onRecord(bot.id, mind, { type: 'tool_execution_start', toolName: 'bash', args: { command: 'git rev-parse HEAD' } });
      a.equal(draftNow(), undefined);
      a.equal(svc.snapshot().status[bot.id].activity, 'Running a command');
      onRecord(bot.id, mind, { type: 'tool_execution_end', toolName: 'bash', result: {} });
      // A message that ends without a tool call is the reply, shown while the turn settles.
      onRecord(bot.id, mind, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'All green, merged.' } });
      a.equal(draftNow(), undefined);
      onRecord(bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'All green, merged.' }] } });
      a.equal(draftNow(), 'All green, merged.');
      a.equal(typingNow(), true);
      svc.setDraft(undefined, { conversationId, botId: bot.id });
      svc.setTyping(conversationId, bot.id, false);
      mind.typing = false;
      // Nor does a final [silent], or anything once a message went out with send_message.
      mind.draft = '';
      onRecord(bot.id, mind, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '[silent]' } });
      onRecord(bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '[silent]' }] } });
      a.equal(draftNow(), undefined);
      mind.draft = '';
      mind.sent = true;
      onRecord(bot.id, mind, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Done.' } });
      onRecord(bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done.' }] } });
      a.equal(draftNow(), undefined);
      mind.sent = false;
      mind.draft = '';

      // A failed model call (an xAI refresh rejected with invalid_grant) is kept, so the run can show it instead of nothing.
      onRecord(bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'OAuth token refresh failed: invalid_grant' } });
      a.equal(mind.error, 'The sign-in for this model has expired. Sign in again in Settings → Providers.\\nOAuth token refresh failed: invalid_grant');
      onRecord(bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } });
      a.ok(mind.error, 'a stop after the failure keeps it');
      onRecord(bot.id, mind, { type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
      a.equal(mind.error, undefined, 'a later good reply clears it');
      a.equal(modelError('Rate limit exceeded'), 'Rate limit exceeded');
      a.equal(modelError(''), 'The model returned an error.');
      svc.setStatus(bot.id, { state: 'idle' });

      // Group instructions are included in the actual bot transcript.
      const group = svc.createConversation({ kind: 'group', name: 'Garden', botIds: [bot.id, other.bot.id], instructions: 'Only discuss the garden.' });
      a.match(transcript(group.id, db.listBots(), 'User', bot.id), /Group instructions: Only discuss the garden/);

      // Replies and reactions reach the bot, not just the UI.
      const quoted = await sendMessage(bot.id, { text: 'what are you working on?', conversation: conversationId.slice(0, 8) });
      svc.toggleReaction(conversationId, quoted.id, '😢', 'me');
      svc.postMessage(conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: 'say that again', replyTo: quoted.id });
      const seen = transcript(conversationId, db.listBots(), 'User', bot.id);
      a.match(seen, /reactions: #1 😢 from User/);
      a.ok(seen.includes('(replying to [' + quoted.id.slice(0, 8) + '] you: “what are you working on?”): say that again'), seen);

      // A bot's reply_to only shows when it points past the newest message.
      const latest = db.messages(conversationId, 1)[0]!.message;
      const plain = await sendMessage(bot.id, { text: 'sure', conversation: conversationId.slice(0, 8), reply_to: latest.id.slice(0, 8) });
      a.equal(db.getMessage(plain.id)!.message.replyTo, undefined);
      const back = await sendMessage(bot.id, { text: 'about that', conversation: conversationId.slice(0, 8), reply_to: quoted.id.slice(0, 8) });
      a.equal(db.getMessage(back.id)!.message.replyTo, quoted.id);

      // Changing the pace restarts the clock, and off stays off.
      db.setValue('hb:' + bot.id, 1);
      svc.updateBot(bot.id, { proactivity: 'low' });
      a.ok(db.getValue('hb:' + bot.id) > Date.now() + 7 * 3600 * 1000);
      svc.updateBot(bot.id, { proactivity: 'off' });
      a.equal(db.getBot(bot.id).proactivity, 'off');
      svc.updateSettings({ quietHours: { from: 0, to: 0 } });
      db.setValue('hb:' + bot.id, 1);
      const woken = [];
      svc.setHooks({ wake: (id, w) => woken.push(w), stop() {} });
      svc.tick(() => false);
      a.deepEqual(woken.filter((w) => w.kind === 'heartbeat'), []);
      svc.updateBot(bot.id, { proactivity: 'high' });
      db.setValue('hb:' + bot.id, 1);
      svc.tick(() => false);
      a.equal(woken.filter((w) => w.kind === 'heartbeat').length, 1);

      // A reaction on a bot's message wakes that bot; taking it back or reacting to your own doesn't.
      const reacted = () => woken.filter((w) => w.kind === 'reaction');
      svc.toggleReaction(conversationId, quoted.id, '👍', 'me');
      a.equal(reacted().length, 1);
      a.equal(reacted()[0].reaction.messageId, quoted.id);
      a.match(reacted()[0].text, /reacted 👍 to your message/);
      // The user should see it was noticed: the bot is asked to react back, not told it can let it be.
      a.match(reacted()[0].text, /That's reaction #2 there\\. React back to it with react's to_reaction so they know you saw it/);
      a.doesNotMatch(reacted()[0].text, /doesn't need an answer/);
      svc.toggleReaction(conversationId, quoted.id, '👍', 'me');
      const own = svc.postMessage(conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: 'mine' });
      svc.toggleReaction(conversationId, own.id, '👍', 'me');
      a.equal(reacted().length, 1);

      // Reactions can answer reactions. Bots hear about the user's answers to theirs, but a bot's
      // reaction is where it leaves things: it never wakes another bot, to its message or its reaction.
      const chat = svc.createConversation({ kind: 'group', name: 'Chain', botIds: [bot.id, other.bot.id] });
      const post = svc.postMessage(chat.id, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: 'look' });
      const theirs = svc.postMessage(chat.id, { id: crypto.randomUUID(), author: other.bot.id, at: Date.now(), text: 'done' });
      const start = reacted().length;
      svc.toggleReaction(chat.id, theirs.id, '👍', bot.id);
      a.equal(reacted().length, start);
      const fire = svc.toggleReaction(chat.id, post.id, '🔥', other.bot.id).reactions[0];
      a.equal(reacted().length, start);
      const thanks = svc.toggleReaction(chat.id, post.id, '🙏', bot.id, fire.id).reactions[1];
      a.equal(thanks.to, fire.id);
      a.equal(reacted().length, start);
      const laugh = svc.toggleReaction(chat.id, post.id, '😂', other.bot.id, thanks.id).reactions[2];
      a.equal(reacted().length, start);
      svc.toggleReaction(chat.id, post.id, '❤️', 'me', laugh.id);
      a.equal(reacted().length, start + 1);
      a.equal(reacted().at(-1).reaction.to, laugh.id);
      a.match(reacted().at(-1).text, /to your 😂 reaction/);
      a.ok(reacted().at(-1).text.endsWith("That's reaction #4 there. " + svc.REACT_BACK));
      a.match(transcript(chat.id, db.listBots(), 'User', bot.id), /#2 🙏 from you → #1, #3 😂 from Other → #2, #4 ❤️ from User → #3/);
      // Taking one back takes the answers with it.
      a.equal(svc.toggleReaction(chat.id, post.id, '🙏', bot.id, fire.id).reactions.length, 1);

      // A relative one-shot is consumed instead of being moved forward at each tick.
      const createdAt = Date.now() - 2 * 3600_000;
      const followUp = svc.saveRoutine(bot.id, { id: 'relative-follow-up', title: 'Later', schedule: 'in 1 hour', enabled: true, followUp: true, conversationId });
      db.putRoutine(bot.id, { ...followUp, createdAt, nextRunAt: createdAt + 3600_000 });
      svc.tick(() => false);
      a.equal(db.routines(bot.id).some(r => r.id === followUp.id), false);
      const onceCount = woken.filter(w => w.kind === 'routine').length;
      svc.tick(() => false);
      a.equal(woken.filter(w => w.kind === 'routine').length, onceCount);

      // Typed answers survive whole.
      const q = { id: crypto.randomUUID(), author: bot.id, at: Date.now(), text: 'Name?', question: { title: 'Name?', options: [{ key: 'A', label: 'Pip' }] } };
      svc.postMessage(conversationId, q);
      const long = 'x'.repeat(300);
      svc.answerQuestion(conversationId, q.id, long);
      a.equal(db.getMessage(q.id).message.question.answer, long);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("any number of routines stay active at once, each bot's separate, each in its own turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-routines-"));
  try {
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const { getFocus } = await import('./server/bots/agent.ts');
      const { wake, stop } = await import('./server/bots/runner.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
      svc.setHooks({ wake, stop });
      svc.updateSettings({ onboarding: 'done' });

      const prompts = [], steers = [];
      const fakeMind = (botId) => {
        const mind = { token: 't', busy: false, sent: false, draft: '', proc: { exited: false, lastUsed: Date.now(), close() {}, send: async (cmd) => {
          if (cmd.type === 'steer') steers.push({ botId, message: cmd.message });
          if (cmd.type === 'prompt') {
            prompts.push({ botId, focus: getFocus(botId), message: cmd.message });
            setTimeout(() => mind.onSettled?.(), 1);
          }
          return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
        } } };
        mind.loaded = JSON.stringify(piFlags());
        Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(botId) });
        minds.set(botId, mind);
      };
      const first = svc.createBot({ name: 'First' });
      const second = svc.createBot({ name: 'Second' });
      for (const { bot } of [first, second]) {
        svc.updateBot(bot.id, { proactivity: 'off' });
        fakeMind(bot.id);
      }
      const group = svc.createConversation({ kind: 'group', name: 'Both', botIds: [first.bot.id, second.bot.id] });
      const add = (botId, task, conversationId, enabled = true) => {
        const r = svc.saveRoutine(botId, { id: crypto.randomUUID(), title: task, schedule: 'every hour', enabled, task, conversationId });
        db.putRoutine(botId, { ...r, nextRunAt: Date.now() - 1000 });
        return r;
      };
      const expected = new Map();
      const addMany = (botId, prefix, count, conversationId, home) => {
        for (let i = 0; i < count; i++) {
          const task = prefix + '<' + i + '>';
          add(botId, task, conversationId);
          expected.set(task, { botId, conversationId: home });
        }
      };
      addMany(first.bot.id, 'first-dm', 25, undefined, first.conversationId);
      addMany(first.bot.id, 'first-group', 5, group.id, group.id);
      addMany(second.bot.id, 'second-dm', 10, undefined, second.conversationId);
      const paused = add(first.bot.id, 'paused<0>', undefined, false);
      a.equal(db.routines(first.bot.id).length, 31);
      a.equal(db.routines(second.bot.id).length, 10);

      svc.tick(() => false);
      for (let i = 0; i < 500 && prompts.length < expected.size; i++) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 20));

      // Every due routine ran exactly once, alone, as the right bot, reporting to its own conversation.
      a.equal(steers.length, 0);
      a.equal(prompts.length, expected.size);
      const ran = new Set();
      for (const p of prompts) {
        const tasks = [...new Set([...p.message.matchAll(/[a-z-]+<[0-9]+>/g)].map((m) => m[0]))];
        const own = tasks.filter((t) => p.message.includes('Routine “' + t + '”'));
        a.equal(own.length, 1, p.message);
        const want = expected.get(own[0]);
        a.equal(p.botId, want.botId);
        a.equal(p.focus, want.conversationId);
        ran.add(own[0]);
      }
      a.equal(ran.size, expected.size);
      a.ok(!prompts.some((p) => p.message.includes('Routine “paused')));

      // They all stay on, scheduled for their next run; pausing one leaves its neighbours alone.
      for (const r of db.routines(second.bot.id)) a.ok(r.enabled && r.nextRunAt > Date.now());
      const [one, two] = db.routines(second.bot.id);
      svc.updateRoutine(second.bot.id, one.id, { enabled: false });
      a.equal(db.routines(second.bot.id).filter((r) => r.enabled).length, 9);
      a.equal(db.routines(second.bot.id).find((r) => r.id === two.id).enabled, true);
      a.equal(db.routines(first.bot.id).filter((r) => r.enabled).length, 30);
      svc.updateRoutine(first.bot.id, paused.id, { enabled: true });
      a.ok(db.routines(first.bot.id).find((r) => r.id === paused.id).nextRunAt > Date.now());

      // A message in the chat a bot is working in still joins the turn; one elsewhere waits for its own.
      prompts.length = 0;
      let release;
      minds.get(first.bot.id).proc.send = async (cmd) => {
        if (cmd.type === 'steer') steers.push({ botId: first.bot.id, message: cmd.message });
        if (cmd.type === 'prompt') {
          prompts.push({ botId: first.bot.id, focus: getFocus(first.bot.id), message: cmd.message });
          if (prompts.length === 1) release = () => minds.get(first.bot.id).onSettled?.();
          else setTimeout(() => minds.get(first.bot.id).onSettled?.(), 1);
        }
        return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
      };
      wake(first.bot.id, { kind: 'messages', conversationId: first.conversationId });
      for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setTimeout(r, 5));
      wake(first.bot.id, { kind: 'messages', conversationId: first.conversationId });
      wake(first.bot.id, { kind: 'messages', conversationId: group.id });
      await new Promise((r) => setTimeout(r, 10));
      a.equal(steers.length, 1);
      // The group isn't left blank meanwhile: the bot shows there as holding on, still working in its DM.
      const held = svc.snapshot().status[first.bot.id];
      a.equal(held.conversationId, first.conversationId);
      a.deepEqual(held.waiting, [group.id]);
      release();
      for (let i = 0; i < 200 && prompts.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
      a.deepEqual(prompts.map((p) => p.focus), [first.conversationId, group.id]);
      // Its turn came, so the group no longer waits.
      a.equal(svc.snapshot().status[first.bot.id]?.waiting, undefined);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a screenshot sent while a bot is replying reaches it, by steering or in the next turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-images-"));
  try {
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const { wake, stop } = await import('./server/bots/runner.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
      svc.setHooks({ wake, stop });
      svc.updateSettings({ onboarding: 'done' });
      const { bot, conversationId } = svc.createBot({ name: 'Shot' });

      const sent = [];
      let release, steerFails = false;
      const mind = { token: 't', busy: false, sent: false, draft: '', loaded: JSON.stringify(piFlags()), proc: { exited: false, lastUsed: Date.now(), close() {}, send: async (cmd) => {
        if (cmd.type === 'steer' || cmd.type === 'prompt') sent.push({ type: cmd.type, message: cmd.message, images: (cmd.images ?? []).map((i) => i.data) });
        if (cmd.type === 'steer' && steerFails) throw new Error('Pi is gone');
        if (cmd.type === 'prompt') release = () => mind.onSettled?.();
        return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
      } } };
      Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(bot.id) });
        minds.set(bot.id, mind);
      const until = async (ok) => { for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); a.ok(ok()); };
      const post = (text, data) => svc.postMessage(conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text, images: data ? ['data:image/png;base64,' + data] : undefined });

      post('first', 'AAAA');
      await until(() => sent.length === 1 && release);
      a.deepEqual(sent[0].images, ['AAAA']);

      // Mid-reply: steered in with its image, and the first prompt's image isn't sent again.
      post('look at this', 'BBBB');
      await until(() => sent.length === 2);
      a.equal(sent[1].type, 'steer');
      a.deepEqual(sent[1].images, ['BBBB']);

      // A steer that doesn't land waits for the next turn, which still has the image and the text.
      steerFails = true;
      post('and this', 'CCCC');
      await until(() => sent.length === 3);
      await new Promise((r) => setTimeout(r, 10));
      steerFails = false;
      const r1 = release; release = undefined;
      r1();
      await until(() => sent.length === 4 && release);
      a.equal(sent[3].type, 'prompt');
      a.deepEqual(sent[3].images, ['CCCC']);
      // Still unread in that turn's transcript.
      const line = sent[3].message.split('\\n').find((l) => l.endsWith(': and this'));
      a.ok(line && !line.includes('[already seen]'), sent[3].message);
      release();
      await until(() => db.cursor(bot.id, conversationId) === db.latestSeq(conversationId));
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("bots write their own instructions, and only a blank slate is open to a non-primary bot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-instructions-"));
  try {
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      import * as svc from './server/bots/service.ts';
      import { manage, contextFor, memory, setFocus } from './server/bots/agent.ts';
      svc.setHooks({ wake() {}, stop() {} });
      const primary = svc.createBot({ name: 'Boss' }).bot;
      const blank = svc.createBot({ name: 'Blank' }).bot;
      a.equal(primary.primary, true);

      // The primary is told to write its own, and when to give other bots theirs. Done writing, the nudge goes.
      a.match(contextFor(primary.id), /You don't have instructions yet/);
      a.match(contextFor(primary.id), /When you make a bot, decide whether/);
      manage(primary.id, { action: 'update', instructions: 'Help Outis plan.' });
      a.equal(db.getBot(primary.id).instructions, 'Help Outis plan.');
      a.doesNotMatch(contextFor(primary.id), /You don't have instructions yet/);
      a.match(contextFor(primary.id), /Help Outis plan/);

      // Giving a new bot instructions is optional, either way works.
      const withJob = manage(primary.id, { action: 'create', name: 'Coach', instructions: 'Track runs.' });
      const without = manage(primary.id, { action: 'create', name: 'Later' });
      a.equal(db.getBot(withJob.id).instructions, 'Track runs.');
      a.equal(db.getBot(without.id).instructions, '');

      // Remembering goes to the bot's memory without saying anything in the chat.
      const blankChat = svc.directId(blank.id);
      setFocus(blank.id, blankChat);
      memory(blank.id, { action: 'write', text: 'Likes tea.' });
      a.equal(db.messages(blankChat, 10).length, 0);
      a.match(contextFor(blank.id), /Likes tea/);
      setFocus(blank.id, undefined);

      // Every bot hears that its memory and routines are its own to run, and doesn't get the primary's guidance.
      a.match(contextFor(blank.id), /any number of routines active at once/);
      a.doesNotMatch(contextFor(blank.id), /When you make a bot/);

      // A non-primary bot can fill in its own blank, not overwrite what's there or touch anyone else.
      manage(blank.id, { action: 'update', instructions: 'First draft.' });
      a.equal(db.getBot(blank.id).instructions, 'First draft.');
      a.throws(() => manage(blank.id, { action: 'update', instructions: 'Rewritten.' }), /Say what to change/);
      a.equal(db.getBot(blank.id).instructions, 'First draft.');
      a.throws(() => manage(blank.id, { action: 'update', bot: without.id, instructions: 'Nope.' }), /only change yourself/);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only the primary bot adds bots to its groups or removes them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-groups-"));
  try {
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db.ts';
      import * as svc from './server/bots/service.ts';
      import { manage, setFocus } from './server/bots/agent.ts';
      svc.setHooks({ wake() {}, stop() {} });
      const primary = svc.createBot({ name: 'Boss' }).bot;
      const helper = svc.createBot({ name: 'Helper' }).bot;
      const coach = manage(primary.id, { action: 'create', name: 'Coach' });
      const group = svc.createConversation({ kind: 'group', name: 'Plans', botIds: [primary.id, helper.id] });
      const short = group.id.slice(0, 8);

      // Other bots can't change who's in a group, in either direction.
      setFocus(helper.id, group.id);
      a.throws(() => manage(helper.id, { action: 'add_to_group', bot: coach.id }), /Only the primary bot/);
      a.throws(() => manage(helper.id, { action: 'remove_from_group', bot: primary.id }), /Only the primary bot/);
      a.deepEqual(db.getConversation(group.id).botIds, [primary.id, helper.id]);

      // The primary adds the bot it made, by name, to the group it names, with a note in the chat.
      a.equal(manage(primary.id, { action: 'add_to_group', bot: 'Coach', conversation: short }).members, 3);
      a.deepEqual(db.getConversation(group.id).botIds, [primary.id, helper.id, coach.id]);
      const joined = db.messages(group.id, 10).map((m) => m.message).find((m) => m.event?.kind === 'joined');
      a.equal(joined.author, primary.id);
      a.equal(joined.event.bot, coach.id);
      a.throws(() => manage(primary.id, { action: 'add_to_group', bot: 'Coach', conversation: short }), /already in the group/);

      // It needs a group it's in, and a bot to move.
      a.throws(() => manage(primary.id, { action: 'add_to_group', bot: 'Coach', conversation: svc.directId(primary.id).slice(0, 8) }), /Only group chats/);
      a.throws(() => manage(primary.id, { action: 'add_to_group', conversation: short }), /Say which bot/);

      // Removing, from the group it's focused on, keeps at least two bots.
      setFocus(primary.id, group.id);
      manage(primary.id, { action: 'remove_from_group', bot: helper.id });
      a.deepEqual(db.getConversation(group.id).botIds, [primary.id, coach.id]);
      a.ok(db.messages(group.id, 10).some((m) => m.message.event?.kind === 'left' && m.message.event.bot === helper.id));
      a.throws(() => manage(primary.id, { action: 'remove_from_group', bot: coach.id }), /at least two bots/);
      a.throws(() => manage(primary.id, { action: 'remove_from_group', bot: helper.id }), /isn't in the group/);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the primary sets bots' models and fallbacks with manage_bot, checked against the real list first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-manage-models-"));
  try {
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { mock } from 'bun:test';
      let listing = { models: [
        { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Opus 5.5', reasoning: true },
        { provider: 'openai-codex', id: 'gpt-6', name: 'GPT-6' },
        { provider: 'openai-codex-2', id: 'gpt-6', name: 'GPT-6' },
        { provider: 'google', id: 'gemini-4', name: 'Gemini 4' },
      ], defaultModel: 'anthropic/claude-opus-5-5', checkedAt: 0 };
      let asked = 0;
      mock.module('./server/bots/extensions.ts', () => ({ botModels: async () => { asked++; if (!listing) throw new Error('pi: secret-token-123 failed'); return listing; } }));
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const { manage, contextFor } = await import('./server/bots/agent.ts');
      svc.setHooks({ wake() {}, stop() {} });
      const primary = svc.createBot({ name: 'Boss' }).bot;
      const helper = svc.createBot({ name: 'Helper' }).bot;
      const fields = (id) => { const b = db.getBot(id); return { model: b.model, effort: b.effort, fallbackModels: b.fallbackModels, noFallbacks: b.noFallbacks, name: b.name, instructions: b.instructions, threads: b.threads, computer: b.computer, primary: b.primary }; };

      // Discoverable for the primary, and clearly the primary's alone.
      a.match(contextFor(primary.id), /Only you can set a bot's model, effort and fallbacks/);
      a.match(contextFor(helper.id), /anyone's model/);

      // Create with a model, effort and an own list, deduped in order. Account variants are entries of their own.
      const made = await manage(primary.id, { action: 'create', name: 'Coach', model: 'google/gemini-4', effort: 'High', fallback: 'own', fallback_models: ['openai-codex/gpt-6', ' openai-codex-2/gpt-6', 'openai-codex/gpt-6'] });
      a.deepEqual(made, { id: made.id, name: 'Coach', model: 'google/gemini-4', effort: 'high', fallback: 'own', fallback_models: ['openai-codex/gpt-6', 'openai-codex-2/gpt-6'] });
      a.deepEqual(db.getBot(made.id).fallbackModels, ['openai-codex/gpt-6', 'openai-codex-2/gpt-6']);
      // Nothing beyond the model came with it: no projects, no computer, not primary.
      a.equal(db.getBot(made.id).threads, undefined);
      a.equal(db.getBot(made.id).computer, undefined);
      a.equal(db.getBot(made.id).primary, undefined);

      // Three-state roundtrip: own -> none -> inherit -> own, then a list alone means own.
      a.equal((await manage(primary.id, { action: 'update', bot: 'Coach', fallback: 'none' })).fallback, 'none');
      a.equal(db.getBot(made.id).noFallbacks, true);
      a.equal((await manage(primary.id, { action: 'update', bot: 'Coach', fallback: 'inherit' })).fallback, 'inherit');
      a.equal(db.getBot(made.id).fallbackModels, undefined);
      a.equal(db.getBot(made.id).noFallbacks, undefined);
      a.equal((await manage(primary.id, { action: 'update', bot: 'Coach', fallback: 'none' })).fallback, 'none');
      const own = await manage(primary.id, { action: 'update', bot: 'Coach', fallback_models: ['anthropic/claude-opus-5-5'] });
      a.deepEqual([own.fallback, own.fallback_models, db.getBot(made.id).noFallbacks], ['own', ['anthropic/claude-opus-5-5'], undefined]);
      // Back to the default model and effort, along with a rename, in one write.
      const reset = await manage(primary.id, { action: 'update', bot: 'Coach', name: 'Trainer', model: 'default', effort: 'default' });
      a.deepEqual([reset.name, reset.model, reset.effort, db.getBot(made.id).model], ['Trainer', 'default', 'default', undefined]);
      // The primary can set its own model too.
      a.equal((await manage(primary.id, { action: 'update', model: 'openai-codex-2/gpt-6' })).model, 'openai-codex-2/gpt-6');

      // Validation failures change nothing, including the other fields of the same call.
      const before = fields(made.id);
      const count = db.listBots().length;
      const refuse = async (params, pattern) => {
        await a.rejects(async () => manage(primary.id, params), pattern);
        a.deepEqual(fields(made.id), before);
        a.equal(db.listBots().length, count);
      };
      await refuse({ action: 'update', bot: made.id, name: 'Nope', model: 'google/gemini-9' }, /Not available to bots: "google\\/gemini-9".*Nothing changed/);
      await refuse({ action: 'update', bot: made.id, instructions: 'Nope', fallback: 'own', fallback_models: ['google/gemini-4', 'anthropic-2/claude-opus-5-5'] }, /Not available to bots: "anthropic-2\\/claude-opus-5-5"/);
      await refuse({ action: 'update', bot: made.id, name: 'Nope', model: 'gemini-4' }, /isn't a model id/);
      await refuse({ action: 'update', bot: made.id, fallback_models: ['google/gemini-4', 'bad id/x'] }, /fallback_models\\[1\\] .* isn't a model id/);
      await refuse({ action: 'update', bot: made.id, fallback_models: [42] }, /isn't a model id/);
      await refuse({ action: 'update', bot: made.id, fallback_models: 'google/gemini-4' }, /is a list/);
      await refuse({ action: 'update', bot: made.id, fallback: 'sometimes' }, /inherit, own or none/);
      await refuse({ action: 'update', bot: made.id, fallback: 'own' }, /needs fallback_models/);
      await refuse({ action: 'update', bot: made.id, fallback: 'none', fallback_models: ['google/gemini-4'] }, /only goes with fallback own/);
      await refuse({ action: 'update', bot: made.id, name: 'Nope', effort: 'turbo' }, /effort is off, minimal/);
      await refuse({ action: 'update', bot: made.id, model: 42 }, /model is a provider\\/model id/);
      const nine = Array.from({ length: 9 }, (_, i) => 'p' + i + '/m');
      await refuse({ action: 'update', bot: made.id, fallback_models: nine }, /up to 8 fallback models, not 9/);
      await refuse({ action: 'update', bot: made.id, fallback_models: Array(100).fill('google/gemini-4') }, /up to 8 fallback models/);
      await refuse({ action: 'create', name: 'Ghost', model: 'google/gemini-9' }, /Not available to bots/);
      // Dupes count once against the bound.
      a.deepEqual((await manage(primary.id, { action: 'update', bot: made.id, fallback_models: Array(10).fill('google/gemini-4') })).fallback_models, ['google/gemini-4']);
      // A listing that can't be read refuses without leaking what Pi said.
      const settled = fields(made.id);
      listing = undefined;
      await a.rejects(async () => manage(primary.id, { action: 'update', bot: made.id, model: 'google/gemini-4' }), (err) => /Couldn't check/.test(err.message) && !/secret-token/.test(err.message));
      a.deepEqual(fields(made.id), settled);
      await a.rejects(async () => manage(primary.id, { action: 'models' }), (err) => !/secret-token/.test(err.message));
      a.equal(db.listBots().length, count);

      // A non-primary bot can never set any bot's model, its own included, and asks nothing of Pi.
      const seen = asked;
      const helperBefore = fields(helper.id);
      a.throws(() => manage(helper.id, { action: 'update', model: 'google/gemini-4' }), /Only the primary bot can change a bot's model/);
      a.throws(() => manage(helper.id, { action: 'update', name: 'Sneaky', fallback: 'none' }), /Only the primary bot/);
      a.throws(() => manage(helper.id, { action: 'update', effort: 'high' }), /Only the primary bot/);
      a.throws(() => manage(helper.id, { action: 'update', bot: made.id, model: 'google/gemini-4' }), /only change yourself/);
      a.throws(() => manage(helper.id, { action: 'create', name: 'X', model: 'google/gemini-4' }), /Only the primary bot can make bots/);
      a.throws(() => manage(helper.id, { action: 'models' }), /Only the primary bot/);
      a.equal(asked, seen);
      a.deepEqual(fields(helper.id), helperBefore);
      // Its self-serve rules are unchanged.
      a.equal(manage(helper.id, { action: 'update', name: 'Helpy' }).name, 'Helpy');

      // models lists ids, names and efforts only, narrowed by a query.
      listing = { models: [{ provider: 'anthropic', id: 'claude-opus-5-5', name: 'Opus 5.5', reasoning: true, apiKey: 'sk-should-not-show' }, { provider: 'google', id: 'gemini-4', name: 'Gemini 4' }], defaultModel: 'anthropic/claude-opus-5-5', checkedAt: 0 };
      const models = await manage(primary.id, { action: 'models', query: 'opus' });
      a.deepEqual(models.models.map((m) => m.id), ['anthropic/claude-opus-5-5']);
      a.ok(models.models[0].efforts.includes('high'));
      a.equal(models.default, 'anthropic/claude-opus-5-5');
      a.doesNotMatch(JSON.stringify(models), /sk-should-not-show/);
      // Models bots are set to that the listing lacks, an extension's switched off say, are named with who's on them.
      a.deepEqual(models.unavailable, [{ id: 'openai-codex-2/gpt-6', used_by: ['Boss'] }]);

      // defaults reads and sets the global default model and fallbacks, primary only, checked whole first.
      listing = { models: [
        { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Opus 5.5' },
        { provider: 'openai-codex', id: 'gpt-6', name: 'GPT-6' },
        { provider: 'openai-codex-2', id: 'gpt-6', name: 'GPT-6' },
        { provider: 'google', id: 'gemini-4', name: 'Gemini 4', apiKey: 'sk-should-not-show' },
      ], defaultModel: 'anthropic/claude-opus-5-5', checkedAt: 0 };
      svc.updateSettings({ quietHours: { from: 22, to: 6 }, searxng: ['https://search.example'] });
      const globals = () => { const s = svc.getSettings(); return { defaultModel: s.defaultModel, defaultFallbackModels: s.defaultFallbackModels }; };
      const others = () => { const { defaultModel, defaultFallbackModels, ...rest } = svc.getSettings(); return rest; };
      const otherSettings = others();
      const bots = () => db.listBots().map((b) => fields(b.id));
      const botsBefore = bots();
      a.deepEqual(await manage(primary.id, { action: 'defaults' }), { default_model: 'default', default_fallbacks: [] });
      const set = await manage(primary.id, { action: 'defaults', default_model: ' google/gemini-4 ', default_fallbacks: ['openai-codex/gpt-6', 'openai-codex-2/gpt-6', 'openai-codex/gpt-6'] });
      a.deepEqual(set, { default_model: 'google/gemini-4', default_fallbacks: ['openai-codex/gpt-6', 'openai-codex-2/gpt-6'] });
      a.deepEqual(globals(), { defaultModel: 'google/gemini-4', defaultFallbackModels: ['openai-codex/gpt-6', 'openai-codex-2/gpt-6'] });
      a.doesNotMatch(JSON.stringify(set), /sk-should-not-show/);
      // Omitted fields stay; an empty list and default clear.
      a.deepEqual(await manage(primary.id, { action: 'defaults', default_fallbacks: ['anthropic/claude-opus-5-5'] }), { default_model: 'google/gemini-4', default_fallbacks: ['anthropic/claude-opus-5-5'] });
      a.deepEqual(await manage(primary.id, { action: 'defaults', default_model: 'anthropic/claude-opus-5-5' }), { default_model: 'anthropic/claude-opus-5-5', default_fallbacks: ['anthropic/claude-opus-5-5'] });
      a.deepEqual(await manage(primary.id, { action: 'defaults', default_fallbacks: [] }), { default_model: 'anthropic/claude-opus-5-5', default_fallbacks: [] });
      a.equal(globals().defaultFallbackModels, undefined);
      a.deepEqual(await manage(primary.id, { action: 'defaults', default_model: 'default', default_fallbacks: ['google/gemini-4'] }), { default_model: 'default', default_fallbacks: ['google/gemini-4'] });
      a.equal(globals().defaultModel, undefined);
      // Bad calls write nothing, not even their valid half.
      await manage(primary.id, { action: 'defaults', default_model: 'google/gemini-4' });
      const settledGlobals = globals();
      const refuseDefaults = async (params, pattern) => {
        await a.rejects(async () => manage(primary.id, { action: 'defaults', ...params }), pattern);
        a.deepEqual(globals(), settledGlobals);
      };
      await refuseDefaults({ default_model: 'anthropic/claude-opus-5-5', default_fallbacks: ['google/gemini-9'] }, /Not available to bots: "google\\/gemini-9".*Nothing changed/);
      await refuseDefaults({ default_model: 'google/gemini-9', default_fallbacks: ['anthropic/claude-opus-5-5'] }, /Not available to bots/);
      await refuseDefaults({ default_model: 'gemini-4' }, /default_model .* isn't a model id/);
      await refuseDefaults({ default_model: 42 }, /default_model is a provider\\/model id/);
      await refuseDefaults({ default_model: 'anthropic/claude-opus-5-5', default_fallbacks: ['google/gemini-4', 'bad id/x'] }, /default_fallbacks\\[1\\] .* isn't a model id/);
      await refuseDefaults({ default_fallbacks: 'google/gemini-4' }, /default_fallbacks is a list/);
      await refuseDefaults({ default_fallbacks: nine }, /up to 8 default fallback models, not 9/);
      await refuseDefaults({ default_fallbacks: Array(100).fill('google/gemini-4') }, /up to 8 default fallback models/);
      listing = undefined;
      await a.rejects(async () => manage(primary.id, { action: 'defaults', default_model: 'anthropic/claude-opus-5-5' }), (err) => /Couldn't check/.test(err.message) && !/secret-token/.test(err.message));
      a.deepEqual(globals(), settledGlobals);
      // Other bots can neither read nor set them, and never reach Pi.
      const seenDefaults = asked;
      a.throws(() => manage(helper.id, { action: 'defaults' }), /Only the primary bot can change the default models/);
      a.throws(() => manage(helper.id, { action: 'defaults', default_model: 'default' }), /Only the primary bot/);
      a.equal(asked, seenDefaults);
      a.deepEqual(globals(), settledGlobals);
      // No bot's own settings and no other setting moved.
      a.deepEqual(bots(), botsBefore);
      a.deepEqual(others(), otherSettings);
      a.match(contextFor(primary.id), /manage_bot defaults/);
      a.match(contextFor(helper.id), /the default models/);

      // The settings API keeps its own behaviour: a list there still clears No fallback.
      svc.updateBot(made.id, { noFallbacks: true });
      svc.updateBot(made.id, { fallbackModels: ['x/y'] });
      a.deepEqual([db.getBot(made.id).fallbackModels, db.getBot(made.id).noFallbacks], [['x/y'], undefined]);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err + out).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a bot falls back through its models in order, only before its reply has done anything", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bots-fallback-"));
  try {
    const { code, stderr: err, stdout: out } = await spawnScript(`
      import { strict as a } from 'node:assert';
      const minds = globalThis.openbotsMinds = new Map();
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const { wake, stop, busy, onRecord, modelChain } = await import('./server/bots/runner.ts');
      const { piFlags } = await import('./server/bots/extensions.ts');
      const { laneDirectory, sessionGeneration } = await import('./server/bots/sessionPolicy.ts');
      const sessionPathFor = id => sessionGeneration(laneDirectory(process.env.OPENCHAT_DATA_DIR + '/bots/sessions', id, (globalThis.openbotsFocus?.get(id) ?? svc.directId(id))));
      svc.setHooks({ wake, stop });
      svc.updateSettings({ onboarding: 'done' });
      const until = async (ok) => { for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); a.ok(ok()); };

      // Each model in 'turns' says what its turn does: 'refuse' (Pi can't switch to it), 'error' (the call fails at once),
      // 'reject' (Pi refuses the prompt), 'partial' (writes, then fails), 'tool' (runs a tool, then fails) or 'ok' (replies).
      // 'start' is the model Pi is on when the process starts: its own pick, or the one a resumed session had.
      const setup = (name, model, fallbackModels, turns, names = {}, start) => {
        const { bot, conversationId } = svc.createBot({ name });
        svc.updateBot(bot.id, { model, fallbackModels });
        const log = [];
        let current, mind;
        const open = (on) => {
        current = on;
        mind = { token: 't', busy: false, sent: false, draft: '', loaded: JSON.stringify(piFlags()), proc: { exited: false, lastUsed: Date.now(), close() {}, send: async (cmd) => {
          if (cmd.type === 'set_model') {
            const id = cmd.provider + '/' + cmd.modelId;
            log.push(id);
            if (turns[id] === 'refuse') throw new Error('Model not found: ' + id);
            current = id;
            return { provider: cmd.provider, id: cmd.modelId, name: names[id] };
          }
          if (cmd.type === 'get_available_thinking_levels' && turns[current] === 'effort-error') throw new Error('Could not read thinking levels');
          if (cmd.type === 'prompt') {
            const turn = turns[current];
            if (turn === 'reject') throw new Error('No API key found for ' + current);
            setTimeout(() => {
              const emit = (record) => onRecord(bot.id, mind, record);
              if (turn === 'partial') emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Half a' } });
              if (turn === 'tool') emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'touch x' } });
              if (turn === 'ok') emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello from ' + current } });
              const errorMessage = turn === 'expired' ? 'invalid_grant: refresh token expired for key sk-live-abcdef1234567890' : current + ' is over its limit';
              emit({ type: 'message_end', message: turn === 'ok' ? { role: 'assistant', stopReason: 'stop' } : { role: 'assistant', stopReason: 'error', errorMessage } });
              emit({ type: 'agent_settled' });
            }, 1);
            return {};
          }
          if (cmd.type === 'get_state') return current ? { model: { provider: current.slice(0, current.indexOf('/')), id: current.slice(current.indexOf('/') + 1), name: names[current] } } : {};
          return cmd.type === 'get_available_thinking_levels' ? { levels: [] } : {};
        } } };
        Object.defineProperty(mind, 'sessionPath', { get: () => sessionPathFor(bot.id) });
        minds.set(bot.id, mind);
        };
        open(start);
        const messages = () => db.messages(conversationId, 50).map((r) => r.message).filter((m) => m.author === bot.id);
        const reply = async () => {
          const before = messages().length;
          svc.postMessage(conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: 'hi' });
          await until(() => !busy(bot.id) && messages().slice(before).some((m) => !m.event || m.event.kind === 'error'));
          const mine = messages().slice(before);
          return { switches: mine.filter((m) => m.event?.kind === 'model'), errors: mine.filter((m) => m.event?.kind === 'error'), texts: mine.filter((m) => !m.event).map((m) => m.text) };
        };
        // A new Pi process, resuming the bot's session on whatever model it was left on.
        const reopen = () => open(current);
        return { bot, log, reply, reopen };
      };

      // Fallbacks are kept in order, repeats and the bot's own model dropped.
      const order = setup('Order', 'a/one', ['b/two', 'a/one', 'c/three', 'b/two'], {});
      a.deepEqual(db.getBot(order.bot.id).fallbackModels, ['b/two', 'a/one', 'c/three']);
      a.deepEqual(modelChain(order.bot.id), ['a/one', 'b/two', 'c/three']);
      svc.updateBot(order.bot.id, { fallbackModels: [] });
      a.equal(db.getBot(order.bot.id).fallbackModels, undefined);

      // The primary fails, the next can't be switched to, the third (a second account) replies. Only that switch is posted.
      const manager = setup('manager', 'anthropic/opus', ['claude-code-2/opus', 'openai-codex-2/gpt-6.1-sol'], { 'anthropic/opus': 'error', 'claude-code-2/opus': 'refuse', 'openai-codex-2/gpt-6.1-sol': 'ok' }, { 'openai-codex-2/gpt-6.1-sol': 'GPT 6.1 Sol' });
      let r = await manager.reply();
      a.deepEqual(manager.log, ['anthropic/opus', 'claude-code-2/opus', 'openai-codex-2/gpt-6.1-sol']);
      a.equal(r.switches.length, 1);
      // Only the model it switched to: no priority, no account, as no other model in the chain is a GPT 6.1 Sol.
      a.deepEqual(r.switches[0].event, { kind: 'model', text: 'Switched to GPT 6.1 Sol', model: 'openai-codex-2/gpt-6.1-sol' });
      a.deepEqual(r.texts, ['Hello from openai-codex-2/gpt-6.1-sol']);
      a.equal(r.errors.length, 0);
      a.notEqual(svc.getStatus(manager.bot.id)?.state, 'error');

      // The next reply starts on the bot's own model again.
      manager.log.length = 0;
      await manager.reply();
      a.equal(manager.log[0], 'anthropic/opus');

      // Text already written, or a tool already run, isn't redone on another model.
      for (const turn of ['partial', 'tool']) {
        const bot = setup('Busy ' + turn, 'a/one', ['b/two'], { 'a/one': turn, 'b/two': 'ok' });
        r = await bot.reply();
        a.deepEqual(bot.log, ['a/one'], turn);
        a.equal(r.switches.length, 0, turn);
        a.equal(r.errors.length, 1, turn);
        // The chat says it couldn't reply; the provider's error is the log's.
        a.deepEqual(r.errors[0].event, { kind: 'error', text: "Couldn't reply", detail: (await import("./shared/bots")).shownReplyError(svc.getStatus(r.errors[0].author).error) }, turn);
        a.equal(svc.getStatus(bot.bot.id).state, 'error', turn);
        a.equal(svc.getStatus(bot.bot.id).provider, true, turn);
        a.match(svc.getStatus(bot.bot.id).error, /a\\/one is over its limit/, turn);
        a.doesNotMatch(svc.getStatus(bot.bot.id).error, /Every model failed/, turn);
      }

      const config = setup('Config refusal', 'a/one', ['b/two'], { 'a/one': 'effort-error', 'b/two': 'ok' });
      const configReply = await config.reply();
      a.deepEqual(config.log, ['a/one']);
      a.equal(configReply.switches.length, 0);
      a.match(configReply.errors[0].event.detail, /Could not read thinking levels/);

      // Every model failing says so, with each one's reason. A fallback that failed too was never switched to.
      const doomedTurns = { 'a/one': 'error', 'b/two': 'error', 'c/three': 'refuse' };
      const doomed = setup('Doomed', 'a/one', ['b/two', 'c/three'], doomedTurns, { 'b/two': 'Two' });
      r = await doomed.reply();
      a.deepEqual(doomed.log, ['a/one', 'b/two', 'c/three']);
      a.equal(r.switches.length, 0);
      a.equal(r.errors.length, 1);
      a.deepEqual(r.errors[0].event, { kind: 'error', text: "Couldn't reply", detail: (await import("./shared/bots")).shownReplyError(svc.getStatus(r.errors[0].author).error) });
      a.deepEqual(r.texts, []);
      // How each one failed is kept for diagnostics, not posted.
      const status = svc.getStatus(doomed.bot.id);
      a.equal(status.state, 'error');
      a.match(status.error, /^Every model failed/);
      for (const reason of ['a/one: a/one is over its limit', 'b/two: b/two is over its limit', 'c/three: Model not found: c/three']) a.ok(status.error.includes(reason), status.error);
      a.match(JSON.stringify(r), /Every model failed/);
      // The bot isn't left stuck: the next reply tries the primary again, and replies once it can.
      doomed.log.length = 0;
      db.setValue('told:' + doomed.bot.id, 0);
      Object.assign(doomedTurns, { 'a/one': 'ok' });
      r = await doomed.reply();
      a.deepEqual(doomed.log, ['a/one']);
      a.deepEqual(r.texts, ['Hello from a/one']);
      a.equal(r.switches.length, 0);
      a.equal(svc.getStatus(doomed.bot.id), undefined);

      // A prompt Pi refuses outright (no key for that model) ran nothing either.
      const keyless = setup('Keyless', 'a/one', ['b/two'], { 'a/one': 'reject', 'b/two': 'ok' });
      r = await keyless.reply();
      a.deepEqual(keyless.log, ['a/one', 'b/two']);
      a.deepEqual(r.texts, ['Hello from b/two']);
      a.deepEqual(r.switches.map((m) => m.event.text), ['Switched to two']);

      // No model set anywhere and no Pi default: the bot runs on Pi's own pick. A fallback that worked
      // doesn't stay on for the next reply, in this process or a resumed one, and not quietly either.
      const own = { 'pi/own': 'error', 'b/two': 'ok' };
      const unset = setup('Unset', undefined, ['b/two'], own, { 'b/two': 'Two' }, 'pi/own');
      r = await unset.reply();
      a.deepEqual(unset.log, ['b/two']);
      a.deepEqual(r.texts, ['Hello from b/two']);
      a.equal(r.switches.length, 1);
      own['pi/own'] = 'ok';
      r = await unset.reply();
      a.deepEqual(unset.log, ['b/two', 'pi/own']);
      a.deepEqual(r.texts, ['Hello from pi/own']);
      a.deepEqual(r.switches.map((m) => m.event.text), ['Switched to own']);
      own['pi/own'] = 'error';
      r = await unset.reply();
      a.deepEqual(r.texts, ['Hello from b/two']);
      a.deepEqual(r.switches.map((m) => m.event.text), ['Switched to Two']);
      unset.log.length = 0;
      unset.reopen();
      own['pi/own'] = 'ok';
      r = await unset.reply();
      a.deepEqual(unset.log, ['pi/own']);
      a.deepEqual(r.texts, ['Hello from pi/own']);
      a.deepEqual(r.switches.map((m) => m.event.text), ['Switched to own']);
      // Pi's own pick can't be had back: the reply runs on the fallback, as the chat was last told.
      own['pi/own'] = 'error';
      r = await unset.reply();
      a.equal(r.switches.length, 1);
      own['pi/own'] = 'refuse';
      unset.log.length = 0;
      r = await unset.reply();
      // Pi is still on the fallback, so only the way back is asked for.
      a.deepEqual(unset.log, ['pi/own']);
      a.deepEqual(r.texts, ['Hello from b/two']);
      a.equal(r.errors.length, 0);
      a.equal(r.switches.length, 0);

      // The chat hears of a change of model, not of every reply that tried the primary first: the same fallback
      // again says nothing, in this process or a resumed one; another fallback, or one higher up coming back, says so.
      // Two GPT 6.1 Sols, one per account, are told apart by their account; Grok, the only one of its kind, isn't.
      const turns = { 'xai/grok-4.7': 'error', 'openai-codex/gpt-6.1-sol': 'ok', 'openai-codex-2/gpt-6.1-sol': 'ok' };
      const names = { 'xai/grok-4.7': 'Grok 4.7', 'openai-codex/gpt-6.1-sol': 'GPT 6.1 Sol', 'openai-codex-2/gpt-6.1-sol': 'GPT 6.1 Sol' };
      const steady = setup('Steady', 'xai/grok-4.7', ['openai-codex/gpt-6.1-sol', 'openai-codex-2/gpt-6.1-sol'], turns, names);
      const said = (r) => r.switches.map((m) => [m.event.text, m.event.detail]);
      r = await steady.reply();
      a.deepEqual(said(r), [['Switched to GPT 6.1 Sol', 'openai-codex']]);
      steady.log.length = 0;
      r = await steady.reply();
      // The primary is still tried first each reply, as before...
      a.deepEqual(steady.log, ['xai/grok-4.7', 'openai-codex/gpt-6.1-sol']);
      a.deepEqual(r.texts, ['Hello from openai-codex/gpt-6.1-sol']);
      // ...but landing on the same fallback isn't news.
      a.deepEqual(said(r), []);
      steady.reopen();
      r = await steady.reply();
      a.deepEqual(said(r), []);
      // The first fallback gives out too: the second account takes over, and that is said.
      turns['openai-codex/gpt-6.1-sol'] = 'error';
      r = await steady.reply();
      a.deepEqual(r.texts, ['Hello from openai-codex-2/gpt-6.1-sol']);
      a.deepEqual(said(r), [['Switched to GPT 6.1 Sol', 'openai-codex-2']]);
      r = await steady.reply();
      a.deepEqual(said(r), []);
      // The first fallback is back: up one place.
      turns['openai-codex/gpt-6.1-sol'] = 'ok';
      r = await steady.reply();
      a.deepEqual(said(r), [['Switched to GPT 6.1 Sol', 'openai-codex']]);
      // The primary is back, after a reopen: up to the first, once.
      steady.reopen();
      turns['xai/grok-4.7'] = 'ok';
      r = await steady.reply();
      a.deepEqual(r.texts, ['Hello from xai/grok-4.7']);
      a.deepEqual(r.switches.map((m) => m.event), [{ kind: 'model', text: 'Switched to Grok 4.7', model: 'xai/grok-4.7' }]);
      r = await steady.reply();
      a.deepEqual(said(r), []);
      // A fallback that fails before replying is never announced, even on the way to one that works.
      turns['xai/grok-4.7'] = 'error';
      turns['openai-codex/gpt-6.1-sol'] = 'reject';
      r = await steady.reply();
      a.deepEqual(said(r), [['Switched to GPT 6.1 Sol', 'openai-codex-2']]);

      // Without fallbacks the provider's error stays out of the chat too.
      const single = setup('Single', 'a/one', undefined, { 'a/one': 'error' });
      r = await single.reply();
      a.deepEqual(single.log, ['a/one']);
      a.equal(r.switches.length, 0);
      a.deepEqual(r.errors[0].event, { kind: 'error', text: "Couldn't reply", detail: (await import("./shared/bots")).shownReplyError(svc.getStatus(r.errors[0].author).error) });
      // A lapsed sign-in still says how to fix it, and only that.
      const lapsed = setup('Lapsed', 'a/one', ['b/two'], { 'a/one': 'expired', 'b/two': 'expired' });
      r = await lapsed.reply();
      a.deepEqual(r.errors[0].event, { kind: 'error', text: "Couldn't reply", detail: 'The sign-in for this model has expired. Sign in again in Settings → Providers.' });
      a.doesNotMatch(JSON.stringify(r.errors[0].event), /invalid_grant|sk-live/);

      // The default model's fallbacks are kept in order, without repeats or anything that isn't "provider/model".
      svc.updateSettings({ defaultModel: 'd/main', defaultFallbackModels: [' e/backup ', 'bad', 'e/backup', 'openai-codex-2/gpt-6.1-sol', 7] });
      a.deepEqual(svc.getSettings().defaultFallbackModels, ['e/backup', 'openai-codex-2/gpt-6.1-sol']);

      // A bot on Default without fallbacks of its own fails over through the default's, announced as any other.
      const inherits = setup('Inherits', undefined, undefined, { 'd/main': 'error', 'e/backup': 'refuse', 'openai-codex-2/gpt-6.1-sol': 'ok' }, { 'openai-codex-2/gpt-6.1-sol': 'GPT 6.1 Sol' });
      a.deepEqual(modelChain(inherits.bot.id), ['d/main', 'e/backup', 'openai-codex-2/gpt-6.1-sol']);
      r = await inherits.reply();
      a.deepEqual(inherits.log, ['d/main', 'e/backup', 'openai-codex-2/gpt-6.1-sol']);
      a.deepEqual(r.texts, ['Hello from openai-codex-2/gpt-6.1-sol']);
      a.deepEqual(r.switches.map((m) => m.event), [{ kind: 'model', text: 'Switched to GPT 6.1 Sol', model: 'openai-codex-2/gpt-6.1-sol' }]);
      // ...and the next reply goes back to the default model.
      inherits.log.length = 0;
      await inherits.reply();
      a.equal(inherits.log[0], 'd/main');

      // Its own fallbacks replace the default's.
      const ownList = setup('Own list', undefined, ['f/own'], { 'd/main': 'error', 'f/own': 'ok' });
      a.deepEqual(modelChain(ownList.bot.id), ['d/main', 'f/own']);
      r = await ownList.reply();
      a.deepEqual(ownList.log, ['d/main', 'f/own']);
      // A bot on a model of its own, with no list of its own, still falls back through the default's...
      const ownModel = setup('Own model', 'a/one', undefined, { 'a/one': 'error', 'e/backup': 'ok' });
      a.deepEqual(modelChain(ownModel.bot.id), ['a/one', 'e/backup', 'openai-codex-2/gpt-6.1-sol']);
      r = await ownModel.reply();
      a.deepEqual(ownModel.log, ['a/one', 'e/backup']);
      a.deepEqual(r.texts, ['Hello from e/backup']);
      // ...and goes back to its own model on the next reply.
      ownModel.log.length = 0;
      await ownModel.reply();
      a.equal(ownModel.log[0], 'a/one');

      // No fallback: neither the default's nor a list of its own, on its own model or on Default.
      const none = setup('No fallback', 'a/one', ['f/own'], { 'a/one': 'error', 'f/own': 'ok', 'e/backup': 'ok' });
      svc.updateBot(none.bot.id, { noFallbacks: true });
      a.equal(db.getBot(none.bot.id).noFallbacks, true);
      a.deepEqual(db.getBot(none.bot.id).fallbackModels, ['f/own']);
      a.deepEqual(modelChain(none.bot.id), ['a/one']);
      r = await none.reply();
      a.deepEqual(none.log, ['a/one']);
      a.equal(r.switches.length, 0);
      a.deepEqual(r.errors[0].event, { kind: 'error', text: "Couldn't reply", detail: (await import("./shared/bots")).shownReplyError(svc.getStatus(r.errors[0].author).error) });
      svc.updateBot(none.bot.id, { model: '' });
      a.deepEqual(modelChain(none.bot.id), ['d/main']);
      // The choice survives a round trip through the API's JSON and the database.
      a.equal(JSON.parse(JSON.stringify(svc.fullBot(none.bot.id))).noFallbacks, true);
      // Back to its own list, then to the defaults; a legacy empty list stays "inherit".
      svc.updateBot(none.bot.id, { noFallbacks: false });
      a.equal(db.getBot(none.bot.id).noFallbacks, undefined);
      a.deepEqual(modelChain(none.bot.id), ['d/main', 'f/own']);
      svc.updateBot(none.bot.id, { noFallbacks: true });
      svc.updateBot(none.bot.id, { fallbackModels: ['g/listed'] });
      a.equal(db.getBot(none.bot.id).noFallbacks, undefined);
      a.deepEqual(modelChain(none.bot.id), ['d/main', 'g/listed']);
      svc.updateBot(none.bot.id, { noFallbacks: false, fallbackModels: [] });
      a.deepEqual(modelChain(none.bot.id), ['d/main', 'e/backup', 'openai-codex-2/gpt-6.1-sol']);

      // A default-model reply that already wrote isn't redone on the default's fallbacks either.
      const halfway = setup('Halfway', undefined, undefined, { 'd/main': 'partial', 'e/backup': 'ok' });
      r = await halfway.reply();
      a.deepEqual(halfway.log, ['d/main']);
      a.equal(r.switches.length, 0);
      a.deepEqual(r.errors[0].event, { kind: 'error', text: "Couldn't reply", detail: (await import("./shared/bots")).shownReplyError(svc.getStatus(r.errors[0].author).error) });
      a.doesNotMatch(svc.getStatus(halfway.bot.id).error, /Every model failed/);

      // With no default model, Pi's default leads the chain and the default's fallbacks follow it.
      svc.updateSettings({ defaultModel: '', defaultFallbackModels: ['e/backup'] });
      a.deepEqual(modelChain(inherits.bot.id), [undefined, 'e/backup']);
      svc.updateSettings({ defaultFallbackModels: [] });
      a.equal(svc.getSettings().defaultFallbackModels, undefined);
      a.deepEqual(modelChain(inherits.bot.id), [undefined]);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") });
    // Each failed reply is in the server log, with the provider's reasons and without the key.
    expect(err).toMatch(/\[bots\] \S+ couldn't reply: /);
    expect(err).toMatch(/\[bots\] \S+ couldn't reply: Every model failed\.\na\/one: a\/one is over its limit\nb\/two: b\/two is over its limit\nc\/three: Model not found: c\/three\n/);
    expect(err).toContain("invalid_grant");
    expect(err + out).not.toContain("sk-live-abcdef1234567890");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("a bot's model chain: its model, then its own fallbacks, none, or the defaults whatever its model", () => {
  const settings = { defaultModel: "d/main", defaultFallbackModels: ["e/backup", "d/main", "f/third"] };
  // Default, nothing of its own: the defaults, without repeating the primary.
  expect(botModelChain({}, settings)).toEqual(["d/main", "e/backup", "f/third"]);
  expect(botModelChain(undefined, settings)).toEqual(["d/main", "e/backup", "f/third"]);
  // A custom primary with no list of its own keeps that primary and still takes the defaults.
  expect(botModelChain({ model: "a/one" }, settings)).toEqual(["a/one", "e/backup", "d/main", "f/third"]);
  expect(botModelChain({ model: "e/backup" }, settings)).toEqual(["e/backup", "d/main", "f/third"]);
  // A legacy empty list is still "inherit".
  expect(botModelChain({ model: "a/one", fallbackModels: [] }, settings)).toEqual(["a/one", "e/backup", "d/main", "f/third"]);
  expect(botModelChain({ fallbackModels: [], noFallbacks: false }, settings)).toEqual(["d/main", "e/backup", "f/third"]);
  // Its own list replaces the defaults, on Default or a custom primary, deduped in order.
  expect(botModelChain({ fallbackModels: ["g/own", "d/main"] }, settings)).toEqual(["d/main", "g/own"]);
  expect(botModelChain({ model: "a/one", fallbackModels: ["a/one", "b/two", "b/two"] }, settings)).toEqual(["a/one", "b/two"]);
  // A second account's model is its own entry, kept apart from the first account's.
  expect(botModelChain({ model: "openai-codex/gpt", fallbackModels: ["openai-codex-2/gpt", "openai-codex/gpt"] }, settings)).toEqual(["openai-codex/gpt", "openai-codex-2/gpt"]);
  expect(botModelChain({ model: "openai-codex/gpt" }, { defaultFallbackModels: ["openai-codex/gpt", "openai-codex-2/gpt"] })).toEqual(["openai-codex/gpt", "openai-codex-2/gpt"]);
  // No fallback: just the primary, whatever is listed or set as defaults.
  expect(botModelChain({ noFallbacks: true }, settings)).toEqual(["d/main"]);
  expect(botModelChain({ model: "a/one", noFallbacks: true }, settings)).toEqual(["a/one"]);
  expect(botModelChain({ model: "a/one", fallbackModels: ["b/two"], noFallbacks: true }, settings)).toEqual(["a/one"]);
  expect(botModelChain({ noFallbacks: true }, {})).toEqual([undefined]);
  // Without a default model the primary is Pi's own.
  expect(botModelChain({}, { defaultFallbackModels: ["e/backup"] })).toEqual([undefined, "e/backup"]);
  expect(botModelChain({}, {})).toEqual([undefined]);
});

test("a bot's fallback mode: the defaults unless it has a list or is set to none", () => {
  expect(fallbackMode(undefined)).toBe("inherit");
  expect(fallbackMode({})).toBe("inherit");
  expect(fallbackMode({ fallbackModels: [] })).toBe("inherit");
  expect(fallbackMode({ fallbackModels: ["a/one"] })).toBe("own");
  expect(fallbackMode({ noFallbacks: true, fallbackModels: ["a/one"] })).toBe("none");
});

test("@mention suggestions rank exact, prefix, word, substring, then tight fuzzy matches", () => {
  const names = (bots: { name: string }[], q: string) => matchMentionBots(bots, q).map((b) => b.name);
  const bots = [{ name: "ob-manager" }, { name: "manager" }, { name: "Manager Mike" }, { name: "submanager" }, { name: "helper" }, { name: "ob-helper · notes" }];
  expect(names(bots, "manager")).toEqual(["manager", "Manager Mike", "ob-manager", "submanager"]);
  expect(names(bots, "MANAGER")).toEqual(names(bots, "manager"));
  expect(names([{ name: "ob-manager" }, { name: "helper" }], "manager")).toEqual(["ob-manager"]);
  // Only the name before " · " counts.
  expect(names(bots, "notes")).toEqual([]);
  expect(names(bots, "help")).toEqual(["helper", "ob-helper · notes"]);
  // Fuzzy: a tight subsequence of three letters or more.
  expect(names([{ name: "ob-manager" }, { name: "helper" }], "obmgr")).toEqual(["ob-manager"]);
  expect(names([{ name: "manager" }], "mngr")).toEqual(["manager"]);
  // Irrelevant: too short, wrong order, or spread thin.
  expect(names(bots, "mg")).toEqual([]);
  expect(names(bots, "regam")).toEqual([]);
  expect(names([{ name: "a really long bot name indeed" }], "ald")).toEqual([]);
  // Ties go shorter first, then A to Z, then as given; a bare @ keeps the given order.
  expect(names([{ name: "zed-bot" }, { name: "bot" }, { name: "abe-bot" }], "bot")).toEqual(["bot", "abe-bot", "zed-bot"]);
  expect(names([{ name: "b" }, { name: "a" }], "")).toEqual(["b", "a"]);
  // Duplicates stay as separate suggestions.
  expect(names([{ name: "ob-manager" }, { name: "ob-manager" }], "manager")).toEqual(["ob-manager", "ob-manager"]);
});

test("the broadcast keywords keep their place among colliding bot names", () => {
  const order = (bots: { name: string }[], q: string) => {
    const ranked = matchMentionBots(bots, q).map((b) => b.name);
    const at = mentionBroadcastAt(matchMentionBots(bots, q), q);
    if (at >= 0) ranked.splice(at, 0, "All bots");
    return ranked;
  };
  const bots = [{ name: "Wallace" }, { name: "Marshall" }, { name: "Neverly" }, { name: "ob-manager" }];
  // @all is the broadcast, not Wallace or Marshall; @every is, not Neverly.
  expect(order(bots, "all")).toEqual(["All bots", "Wallace", "Marshall"]);
  expect(order(bots, "every")).toEqual(["All bots", "Neverly"]);
  expect(order(bots, "everyone")).toEqual(["All bots"]);
  // A bot actually named for it still comes first.
  expect(order([...bots, { name: "All Stars" }], "all")).toEqual(["All Stars", "All bots", "Wallace", "Marshall"]);
  // Bare @ keeps the given order with everyone last; other queries have no broadcast.
  expect(order(bots, "")).toEqual(["Wallace", "Marshall", "Neverly", "ob-manager", "All bots"]);
  expect(order(bots, "manager")).toEqual(["ob-manager"]);
});

test("fallback requires an explicit model refusal, never a configuration or ambiguous RPC failure", async () => {
  const { modelStartFailure, ModelFailure } = await import("../server/bots/runner");
  const { PiTimeoutError } = await import("../server/pi/rpc");
  for (const message of ["Model not found: a/b", "No API key found for anthropic"]) expect(modelStartFailure(new Error(message))).toBeInstanceOf(ModelFailure);
  for (const error of [new Error("already processing a prompt"), new Error("get_state failed"), new PiTimeoutError("set_model timed out")]) expect(modelStartFailure(error)).toBe(error);
});

test("reply diagnostics preserve the reason while redacting credentials and bounding legacy data", async () => {
  const { shownReplyError } = await import("../shared/bots");
  const error = 'HTTP 400: cache_control limit. Authorization: Bearer abcdefghijklmnop api_key=sk-live-abcdef1234567890 refresh_token=privatevalue';
  const shown = shownReplyError(error, true)!;
  expect(shown).toContain('HTTP 400: cache_control limit.');
  for (const secret of ['abcdefghijklmnop', 'sk-live-abcdef1234567890', 'privatevalue']) expect(shown).not.toContain(secret);
  expect(shownReplyError('x'.repeat(5000))!.length).toBe(4000);
});


test("reply diagnostics redact spaced credential labels and Google API keys", async () => {
  const { shownReplyError, redactSecrets, eventDetail } = await import("../shared/bots");
  const googleKey = "AIza" + "A".repeat(34) + "-";
  for (const detail of [
    "Invalid API key: private-provider-key",
    'Invalid API key: "private-provider-key"',
    "access token=private-provider-key",
    "refresh token: private-provider-key",
    `Google rejected ${googleKey}`,
  ]) {
    for (const result of [redactSecrets(detail), shownReplyError(detail, true), shownReplyError(detail), eventDetail({ kind: "error", text: "Couldn't reply", detail })]) {
      expect(result).toContain("[redacted]");
      expect(result).not.toContain("private-provider-key");
      expect(result).not.toContain(googleKey);
    }
  }
  expect(shownReplyError("Invalid API key: private-provider-key", true)).toBe("Invalid API key: [redacted]");
});
