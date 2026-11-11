import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

test("registered group tool crosses authenticated dispatch and preserves chat boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openbuild-group-tools-"));
  try {
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import * as db from './server/bots/db';
      import * as svc from './server/bots/service';
      import * as agent from './server/bots/agent';
      import extension from './server/bots/extension';
      const primary = svc.createBot({name: 'Primary'});
      const beta = svc.createBot({name: 'Beta Worker'});
      const gamma = svc.createBot({name: 'Gamma'});
      const other = svc.createBot({name: beta.bot.id});
      svc.setHooks({wake() {}, stop() {}});
      const tools = [];
      extension({on() {}, registerTool(t) { tools.push(t); }});
      const tool = tools.find(t => t.name === 'manage_bot');
      a.equal(tool.exposure, 'model-only');
      a.equal(tool.parameters.properties.bots.type, 'array');
      a.ok(tool.description.includes('create_group'));
      a.ok(tool.parameters.required.includes('status'));
      agent.listen();
      process.env.OPENBOTS_SOCKET = agent.agentSocketPath();
      process.env.OPENBOTS_TOKEN = agent.mintToken(primary.bot.id);
      agent.setFocus(primary.bot.id, primary.conversationId);
      const call = async p => {
        const out = await tool.execute('test', {...p, status: 'Managing test group'});
        if (out.isError) throw Error(out.content[0].text);
        return out.details;
      };
      svc.createBot({name: 'Shared One'});
      svc.createBot({name: 'Shared Two'});
      const count = db.listConversations().length;
      for (const p of [
        {name:'Bad', bots:['Shared']}, {name:'Bad', bots:['Missing']}, {name:'Bad', bots:[42]},
        {name:'Bad', bots:['Primary']}, {bots:['Gamma']}
      ]) await a.rejects(() => call({action:'create_group', ...p}));
      a.equal(db.listConversations().length, count);
      const group = await call({action:'create_group', name:'Isolated', bots:[beta.bot.id, 'Beta Worker'], instructions:'Coordinate'});
      a.deepEqual(group.members, [primary.bot.id, beta.bot.id]);
      a.equal(db.getConversation(group.conversation).instructions, 'Coordinate');
      a.equal(db.messages(group.conversation, 10)[0].message.author, primary.bot.id);
      a.equal(agent.getFocus(primary.bot.id), primary.conversationId);
      a.ok(agent.contextFor(primary.bot.id).includes('manage_bot create_group'));
      await call({action:'add_to_group', bot:gamma.bot.id.slice(0,8), conversation:group.conversation.slice(0,8)});
      await a.rejects(() => call({action:'add_to_group', bot:'Gamma', conversation:group.conversation}), /already/);
      await call({action:'remove_from_group', bot:'Beta Worker', conversation:group.conversation});
      a.deepEqual(db.getConversation(group.conversation).botIds, [primary.bot.id, gamma.bot.id]);
      await a.rejects(() => call({action:'remove_from_group', bot:'Gamma', conversation:group.conversation}), /at least two/);
      const side = svc.createConversation({kind:'side', botIds:[primary.bot.id,beta.bot.id]});
      const foreign = svc.createConversation({kind:'group', name:'Foreign', botIds:[beta.bot.id,gamma.bot.id]});
      for (const conversation of [primary.conversationId, side.id, foreign.id]) {
        for (const action of ['add_to_group','remove_from_group'])
          await a.rejects(() => call({action, bot:'Gamma', conversation}));
      }
      await a.rejects(() => call({action:'add_to_group', bot:'Beta Worker'}), /Only group/);
      agent.setFocus(primary.bot.id, group.conversation);
      await call({action:'add_to_group', bot:'Beta Worker'});
      const before = db.listConversations().length;
      process.env.OPENBOTS_TOKEN = agent.mintToken(beta.bot.id);
      for (const action of ['create_group','add_to_group','remove_from_group'])
        await a.rejects(() => call({action, name:'Forbidden', bots:['Gamma'], bot:'Gamma', conversation:group.conversation}), /Only the primary/);
      a.equal(db.listConversations().length, before);
      process.env.OPENBOTS_TOKEN = agent.mintToken(primary.bot.id);
      await call({action:'remove_from_group', bot:'Primary', conversation:group.conversation});
      await a.rejects(() => call({action:'add_to_group', bot:'Primary', conversation:group.conversation}), /No such conversation/);
      svc.updateBot(beta.bot.id, {primary:true});
      await a.rejects(() => call({action:'create_group', name:'Demoted', bots:['Gamma']}), /Only the primary/);
      process.env.OPENBOTS_TOKEN = 'invalid';
      await a.rejects(() => call({action:'create_group', name:'Forbidden', bots:['Gamma']}), /Unauthorized/);
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: dir });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
