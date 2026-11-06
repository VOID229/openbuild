import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piBin } from "../server/pi/install";

const pi = piBin();

// Real Pi, a fake model and a Pi set up like nobody's: no extensions needed, and one planted that must not load.
test.skipIf(!pi)("bots talk to each other and search using only what OpenBots ships", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-bots-pi-"));
  try {
    const agent = join(dir, "agent");
    const marker = join(dir, "canary-loaded");
    mkdirSync(join(agent, "extensions"), { recursive: true });
    writeFileSync(join(agent, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "shared-test-key" } }));
    writeFileSync(join(agent, "SYSTEM.md"), "USER_SYSTEM_CANARY");
    writeFileSync(join(agent, "APPEND_SYSTEM.md"), "USER_APPEND_CANARY");
    // The same tool name as one of ours, which stopped every bot from starting when user extensions loaded.
    writeFileSync(
      join(agent, "extensions", "canary.ts"),
      `import { writeFileSync } from "node:fs";
       export default function (pi: any) {
         writeFileSync(${JSON.stringify(marker)}, "loaded");
         pi.registerTool({ name: "bot_web_search", label: "x", description: "x", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: null }) });
       }`,
    );
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import { writeFileSync } from 'node:fs';
      const seenTools = new Set();
      const sse = (delta, finish) => 'data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish ?? null }] }) + '\\n\\n';
      const say = (text) => sse({ role: 'assistant', content: text }) + sse({}, 'stop') + 'data: [DONE]\\n\\n';
      const use = (name, args) => sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + sse({}, 'tool_calls') + 'data: [DONE]\\n\\n';
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
        if (new URL(req.url).pathname === '/search') return Response.json({ results: [{ title: 'Tea result', url: 'https://tea.test/', content: 'About tea' }] });
        a.equal(req.headers.get('authorization'), 'Bearer shared-test-key');
        const body = await req.json();
        const prompt = JSON.stringify(body.messages.filter((m) => m.role === 'system' || m.role === 'developer'));
        a.ok(!prompt.includes('USER_SYSTEM_CANARY'), prompt);
        a.ok(!prompt.includes('USER_APPEND_CANARY'), prompt);
        a.ok(prompt.includes("one of the user's bots in OpenBots"), prompt);
        a.ok(prompt.includes('For every tool that has a status parameter'), prompt);
        for (const t of body.tools ?? []) {
          seenTools.add(t.function.name);
          if (['ask_bot', 'bot_web_search', 'bash', 'use_app'].includes(t.function.name)) {
            a.ok(t.function.parameters.required.includes('status'), JSON.stringify(t));
          }
        }
        const last = body.messages.at(-1);
        const text = JSON.stringify(last.content);
        let out;
        if (last.role === 'tool' && text.includes('pong')) out = use('bot_web_search', { query: 'tea', provider: 'searxng', status: 'Finding tea sources' });
        else if (last.role === 'tool' && text.includes('Tea result')) out = say('all done');
        else if (last.role === 'tool') out = say('tool failed: ' + text.slice(0, 300));
        else if (text.includes('ASK')) out = use('ask_bot', { bot: 'Beta', text: 'ping', status: 'Checking with Beta' });
        else out = say('pong');
        return new Response(out, { headers: { 'content-type': 'text/event-stream' } });
      } });
      writeFileSync(process.env.PI_CODING_AGENT_DIR + '/models.json', JSON.stringify({ providers: { mock: { baseUrl: 'http://127.0.0.1:' + server.port + '/v1', api: 'openai-completions', models: [{ id: 'm' }] } } }));
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const { startBots } = await import('./server/bots/runner.ts');
      svc.updateSettings({ defaultModel: 'mock/m', searxng: ['http://127.0.0.1:' + server.port], onboarding: 'done' });
      const alpha = svc.createBot({ name: 'Alpha' });
      const beta = svc.createBot({ name: 'Beta' });
      startBots();
      svc.postMessage(alpha.conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text: 'ASK' });

      const said = (id) => db.messages(id, 50).filter((r) => !r.message.event).map((r) => r.message.text);
      const activity = (id) => db.messages(id, 50).flatMap((r) => r.message.event?.kind === 'message' ? [r.message.event.text] : []);
      const until = Date.now() + 45000;
      while (Date.now() < until && !said(alpha.conversationId).includes('all done')) await Bun.sleep(100);
      a.deepEqual(said(alpha.conversationId).filter((t) => t !== 'ASK'), ['all done']);

      // The two really did talk, in a side chat the user can read.
      const side = db.listConversations().find((c) => c.kind === 'side');
      a.ok(side.botIds.includes(alpha.bot.id) && side.botIds.includes(beta.bot.id));
      a.deepEqual(said(side.id), ['ping', 'pong']);
      // Each bot's own chat notes the exchange, linking to the side chat.
      a.deepEqual(activity(alpha.conversationId), ['Sent a message to Beta']);
      a.deepEqual(activity(beta.conversationId), ['Received a message from Alpha']);
      for (const name of ['send_message', 'ask_bot', 'bot_web_search', 'remember', 'routine']) a.ok(seenTools.has(name), 'missing ' + name);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: agent, PI_BIN: pi!, PI_OFFLINE: "1", OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

// The same, with extensions switched on: off by default, one at a time, and models follow what's loaded.
test.skipIf(!pi)("a bot loads only the extensions the user picked, and the model list follows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-bots-pi-"));
  try {
    const agent = join(dir, "agent");
    const marker = join(dir, "picked-loaded");
    mkdirSync(join(agent, "extensions"), { recursive: true });
    writeFileSync(join(agent, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "shared-test-key" } }));
    writeFileSync(join(agent, "SYSTEM.md"), "USER_SYSTEM_CANARY");
    writeFileSync(join(agent, "APPEND_SYSTEM.md"), "USER_APPEND_CANARY");
    writeFileSync(
      join(agent, "extensions", "picked.ts"),
      `import { appendFileSync } from "node:fs";
       export default function (pi: any) {
         appendFileSync(${JSON.stringify(marker)}, "x");
         pi.on("before_agent_start", (event: any) => { event.systemPromptOptions.appendSystemPrompt += "\\nPICKED_EXTENSION_PROMPT"; });
         pi.registerProvider("pickedprovider", { baseUrl: "http://127.0.0.1:1/v1", apiKey: "x", api: "openai-completions", models: [{ id: "extra", name: "Extra", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }] });
         pi.registerTool({ name: "picked_tool", label: "x", description: "x", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: null }) });
       }`,
    );
    // A name of ours again, for a clash the settings page can report.
    writeFileSync(join(agent, "extensions", "clash.ts"), `export default function (pi: any) { pi.registerTool({ name: "send_message", label: "x", description: "x", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: null }) }); }`);
    const child = Bun.spawn([process.execPath, "-e", `
      import { strict as a } from 'node:assert';
      import { existsSync, writeFileSync } from 'node:fs';
      let tools = [];
      let lastPrompt = '';
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
        a.equal(req.headers.get('authorization'), 'Bearer shared-test-key');
        const body = await req.json();
        const prompt = JSON.stringify(body.messages.filter((m) => m.role === 'system' || m.role === 'developer'));
        a.ok(!prompt.includes('USER_SYSTEM_CANARY'), prompt);
        a.ok(!prompt.includes('USER_APPEND_CANARY'), prompt);
        a.ok(prompt.includes("one of the user's bots in OpenBots"), prompt);
        lastPrompt = prompt;
        tools = (body.tools ?? []).map((t) => t.function.name);
        const chunk = (delta, finish) => 'data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish ?? null }] }) + '\\n\\n';
        return new Response(chunk({ role: 'assistant', content: 'hi' }) + chunk({}, 'stop') + 'data: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
      } });
      writeFileSync(process.env.PI_CODING_AGENT_DIR + '/models.json', JSON.stringify({ providers: { mock: { baseUrl: 'http://127.0.0.1:' + server.port + '/v1', api: 'openai-completions', models: [{ id: 'm' }] } } }));
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const { available, botModels, piFlags } = await import('./server/bots/extensions.ts');
      const { startBots } = await import('./server/bots/runner.ts');
      const marker = ${JSON.stringify(marker)};
      const providers = async () => new Set((await botModels(true)).models.map((m) => m.provider));

      // Every tool OpenBots registers stays on the list that keeps bots to their own tools.
      const source = await Bun.file('./server/bots/extension.ts').text();
      const allowed = piFlags()[piFlags().indexOf('--tools') + 1].split(',');
      for (const [, name] of source.matchAll(/tool\\(\\s*"([a-z_]+)"/g)) a.ok(allowed.includes(name), name + ' is not on the tool list');

      // Off, and on with nothing picked: nothing loads.
      a.deepEqual(available().map((e) => e.id).sort(), ['extensions/clash.ts', 'extensions/picked.ts']);
      a.ok((await providers()).has('mock'));
      a.ok(!(await providers()).has('pickedprovider'));
      svc.updateSettings({ customExtensions: { enabled: true, ids: [] } });
      a.ok(!(await providers()).has('pickedprovider'));
      a.equal(existsSync(marker), false);

      // Only ids that are installed turn into paths.
      svc.updateSettings({ customExtensions: { enabled: true, ids: ['extensions/gone.ts', '/etc/evil.ts', '../evil.ts'] } });
      a.ok(!piFlags().some((f) => f.includes('evil') || f.includes('gone')));

      svc.updateSettings({ defaultModel: 'mock/m', onboarding: 'done' });
      const { bot, conversationId } = svc.createBot({ name: 'Alpha' });
      startBots();
      const talk = async (text) => {
        const before = db.messages(conversationId, 50).length + 2;
        svc.postMessage(conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text });
        const until = Date.now() + 20000;
        while (Date.now() < until && db.messages(conversationId, 50).length < before) await Bun.sleep(50);
        a.equal(db.messages(conversationId, 50).length, before);
      };
      await talk('one');
      a.ok(!tools.includes('picked_tool'));

      // Picked: its model is listed, and the same bot picks up its tool on the next reply, keeping its own.
      svc.updateSettings({ customExtensions: { enabled: true, ids: ['extensions/picked.ts'] } });
      a.ok((await providers()).has('pickedprovider'));
      await talk('two');
      a.ok(tools.includes('picked_tool'));
      a.ok(lastPrompt.includes('PICKED_EXTENSION_PROMPT'));
      for (const name of ['bash', 'send_message', 'ask_bot', 'bot_web_search']) a.ok(tools.includes(name), name);

      // Off again takes it all back.
      svc.updateSettings({ customExtensions: { enabled: false, ids: ['extensions/picked.ts'] } });
      a.ok(!(await providers()).has('pickedprovider'));
      await talk('three');
      a.ok(!tools.includes('picked_tool'));

      // A clash is reported with the reason, rather than found in a chat.
      svc.updateSettings({ customExtensions: { enabled: true, ids: ['extensions/clash.ts'] } });
      await a.rejects(botModels(true), /conflicts/);
      process.exit(0);
    `], { cwd: join(import.meta.dir, ".."), env: { ...process.env, OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: agent, PI_BIN: pi!, PI_OFFLINE: "1", OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") }, stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    // A temp Pi has no install folder to read a model scope from, which is allowed for.
    expect(err.replace(/\[pi\] model scope unavailable.*\n/g, "")).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
