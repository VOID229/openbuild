// One name per bot: two bots called "e" showed twice in the @mention list, and nobody could tell which
// was which. A name someone types is refused when another of the user's bots has it (any case, spaces
// trimmed). Bots that share a name from before still load, and renaming either is how that's fixed.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botNameClash, botNameError, botNameKey, botNameTaken } from "../shared/bots";
import { spawnScript } from "./spawnScript";

// Each script runs against its own data directory, in a process of its own.
async function run(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-bot-names-"));
  try {
    const { code, stderr: err } = await spawnScript(`${script}\nprocess.exit(0);`, { OPENCHAT_DATA_DIR: dir, PI_CODING_AGENT_DIR: join(dir, "pi") });
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
  // Dr Eggbot, as every install starts.
  svc.ensureStarted();
  // Importing the routes starts the runner, which sets its own hooks: the quiet ones go in after.
  const { botRoutes } = await import('./server/bots/routes.ts');
  const { manage } = await import('./server/bots/agent.ts');
  svc.setHooks({ wake() {}, stop() {} });
  // What a refusal says, and its status, or 'ok' when there was none.
  const refusal = (fn) => { try { fn(); return 'ok'; } catch (e) { return e instanceof svc.BotsError ? e.status + ' ' + e.message : String(e); } };
  const names = () => db.listBots().map((b) => b.name).sort();
`;

test("the key: a bot's mention name, spaces folded, in any case", () => {
  expect(botNameKey("  Scout  ")).toBe("scout");
  expect(botNameKey("SCOUT")).toBe(botNameKey("scout"));
  expect(botNameKey("Code   Reviewer")).toBe(botNameKey("code reviewer"));
  // " · " starts a tag, which an @mention leaves out.
  expect(botNameKey("Writer · docs")).toBe(botNameKey("writer"));
  expect(botNameTaken("  e ")).toBe("You already have a bot named e");
});

test("a clash is another bot's name; a bot's own, in any case, never is", () => {
  const bots = [{ id: "a", name: "e" }, { id: "b", name: "e" }, { id: "c", name: "Scout" }];
  expect(botNameClash(bots, " SCOUT ")?.id).toBe("c");
  expect(botNameClash(bots, "Atlas")).toBeUndefined();
  expect(botNameClash(bots, "")).toBeUndefined();
  // Renaming c: its own name passes, another's doesn't.
  expect(botNameClash(bots, "scout", bots[2])).toBeUndefined();
  expect(botNameClash(bots, "E", bots[2])?.id).toBe("a");
  // a and b were called "e" before the check: keeping it passes, so either can still save, and a free name fixes it.
  expect(botNameClash(bots, "e", bots[0])).toBeUndefined();
  expect(botNameClash(bots, "f", bots[0])).toBeUndefined();
  expect(botNameError(bots, "Scout ")).toBe("You already have a bot named Scout");
  expect(botNameError(bots, "Atlas")).toBeUndefined();
});

test("making a bot with another's name is refused, in any case and with spaces around it", async () => {
  await run(`${SETUP}
    svc.createBot({ name: 'e' });
    a.equal(refusal(() => svc.createBot({ name: 'e' })), '400 You already have a bot named e');
    a.equal(refusal(() => svc.createBot({ name: '  E  ' })), '400 You already have a bot named E');
    // The tag isn't part of the mention: "e · docs" would show as a second "e".
    a.equal(refusal(() => svc.createBot({ name: 'e · docs' })), '400 You already have a bot named e · docs');
    // Nothing was made by the refusals.
    a.deepEqual(names(), ['Dr Eggbot', 'e'].sort());
    svc.createBot({ name: 'e2' });
    // A retired bot keeps its name: it can be rehired.
    const gone = svc.createBot({ name: 'Scout' }).bot;
    svc.retireBot(gone.id);
    a.ok(db.getBot(gone.id).retiredAt);
    a.equal(refusal(() => svc.createBot({ name: 'scout' })), '400 You already have a bot named scout');
  `);
});

test("a bot making or renaming one with manage_bot is told the same, and nothing is saved", async () => {
  await run(`${SETUP}
    const primary = db.listBots().find((b) => b.primary);
    svc.createBot({ name: 'Juniper' });
    const told = async (p) => { try { await manage(primary.id, p); return 'ok'; } catch (e) { return e.message; } };
    a.equal(await told({ action: 'create', name: 'juniper', instructions: 'Check the build.' }), 'You already have a bot named juniper');
    a.equal(await told({ action: 'update', bot: 'Juniper', name: 'dr eggbot' }), 'You already have a bot named dr eggbot');
    a.deepEqual(names(), ['Dr Eggbot', 'Juniper']);
    a.equal(await told({ action: 'create', name: 'Atlas', instructions: 'Check the build.' }), 'ok');
    a.deepEqual(names(), ['Atlas', 'Dr Eggbot', 'Juniper']);
  `);
});

test("the app's routes answer a clash with 400 and the words to show, and save nothing", async () => {
  // Not 409: from a bots route that tells the app its workspace is gone, and the tab would leave it.
  await run(`${SETUP}
    const routes = botRoutes((h) => h);
    const api = async (path, method, body, params = {}) => {
      const req = new Request('http://x' + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      req.params = params;
      const route = Object.keys(params).length ? '/api/bots/:id' : path;
      const res = await routes[route][method](req);
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const look = { shape: 'puff', color: 'blue' };
    const e = await api('/api/bots', 'POST', { name: 'e', look });
    a.equal(e.status, 200);
    a.deepEqual(await api('/api/bots', 'POST', { name: ' E ', look }), { status: 400, body: { error: 'You already have a bot named E' } });
    const f = await api('/api/bots', 'POST', { name: 'f', look });
    a.deepEqual(await api('/api/bots/' + f.body.bot.id, 'PATCH', { name: 'e' }, { id: f.body.bot.id }), { status: 400, body: { error: 'You already have a bot named e' } });
    a.deepEqual(names(), ['Dr Eggbot', 'e', 'f']);
  `);
});

test("renaming to another bot's name is refused; its own name in another case passes", async () => {
  await run(`${SETUP}
    const scout = svc.createBot({ name: 'Scout' }).bot;
    const atlas = svc.createBot({ name: 'Atlas' }).bot;
    a.equal(refusal(() => svc.updateBot(atlas.id, { name: ' scout ' }, { by: 'me' })), '400 You already have a bot named scout');
    a.equal(db.getBot(atlas.id).name, 'Atlas');
    // No line says it changed.
    const said = db.messages(svc.directId(atlas.id), 50).map((r) => r.message).filter((m) => m.event?.kind === 'renamed');
    a.equal(said.length, 0);
    a.equal(svc.updateBot(atlas.id, { name: 'ATLAS' }, { by: 'me' }).name, 'ATLAS');
    a.equal(svc.updateBot(scout.id, { name: 'Tracer' }, { by: 'me' }).name, 'Tracer');
    // A bot renaming itself is told the same.
    a.equal(refusal(() => svc.updateBot(atlas.id, { name: 'tracer' })), '400 You already have a bot named tracer');
    // The name Scout gave up is free again, though @Scout still reaches Tracer in old sessions.
    a.equal(svc.createBot({ name: 'Scout' }).bot.name, 'Scout');
  `);
});

test("bots with one name from before still load and save, and renaming one fixes it", async () => {
  await run(`${SETUP}
    const one = svc.createBot({ name: 'e' }).bot;
    // As two bots were made before the check: stored straight, no rename, no migration.
    const twin = { ...db.getBot(one.id), id: crypto.randomUUID(), primary: undefined };
    db.putBot(twin);
    db.putConversation({ id: crypto.randomUUID(), kind: 'direct', botIds: [twin.id], createdAt: Date.now(), updatedAt: Date.now() });
    const loaded = svc.snapshot().bots.filter((b) => b.name === 'e');
    a.equal(loaded.length, 2);
    // Either still saves its other settings, the name sent along as it is.
    a.equal(svc.updateBot(twin.id, { name: 'e', role: 'Tests things' }, { by: 'me' }).role, 'Tests things');
    a.equal(svc.updateBot(one.id, { instructions: 'Be brief.' }, { by: 'me' }).instructions, 'Be brief.');
    // Renaming one to a free name is allowed, and that's the clash gone.
    a.equal(svc.updateBot(twin.id, { name: 'f' }, { by: 'me' }).name, 'f');
    a.equal(refusal(() => svc.updateBot(twin.id, { name: 'e' }, { by: 'me' })), '400 You already have a bot named e');
    a.deepEqual(names(), ['Dr Eggbot', 'e', 'f'].sort());
  `);
});
