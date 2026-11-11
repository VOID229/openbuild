import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRIEND_TOOLS } from "../shared/friends";
import openbots, { CATALOG_BRIEF, CORE_TOOLS, loadedTools } from "../server/bots/extension";
import { piBin } from "../server/pi/install";
import { spawnScript } from "./spawnScript";

/** The extension in a stand-in Pi that keeps an active set, as Pi's own does: `--tools` names only `allowed`. */
function fakePi(allowed?: string[]) {
  const registered: any[] = [];
  const handlers: Record<string, Function[]> = {};
  let active: string[] = [];
  const has = (name: string) => !allowed || allowed.includes(name);
  const pi = {
    on(name: string, h: Function) { (handlers[name] ??= []).push(h); },
    registerTool(t: any) {
      if (!has(t.name)) return;
      registered.push(t);
      // `--tools` activates every tool it names; without it, a tool is active unless defaultActive is false.
      if (allowed || t.defaultActive !== false) active.push(t.name);
    },
    getAllTools: () => registered.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) { active = [...new Set(names)].filter((name) => registered.some((t) => t.name === name)); },
  };
  openbots(pi);
  const emit = (name: string, event: any, ctx?: any) => (handlers[name] ?? []).map((h) => h(event, ctx)).find((out) => out !== undefined);
  const declared = () => active.map((name) => registered.find((t) => t.name === name));
  const tool = (name: string) => registered.find((t) => t.name === name);
  return { pi, emit, declared, tool, active: () => active, registered };
}

const ALL = (() => {
  const all: any[] = [];
  openbots({ on() {}, registerTool(t: any) { all.push(t); } });
  return all;
})();
const NON_CORE = ALL.map((t) => t.name).filter((name) => !CORE_TOOLS.includes(name));

test("the catalog lists every tool that isn't core, by name, with a line of its own", () => {
  expect(NON_CORE.length).toBeGreaterThan(15);
  const description = ALL.find((t) => t.name === "load_tools").description as string;
  for (const name of NON_CORE) {
    expect(CATALOG_BRIEF[name]).toBeTruthy();
    expect(description).toContain(`\n- ${name}: ${CATALOG_BRIEF[name]}`);
  }
  // Nothing listed that isn't a tool, and nothing core listed.
  expect(Object.keys(CATALOG_BRIEF).sort()).toEqual([...NON_CORE].sort());
  expect(description.split("\n").filter((line) => line.startsWith("- ")).length).toBe(NON_CORE.length);
});

test("core tools are declared from the start with their full schemas; the rest wait to be loaded", () => {
  const { emit, declared, tool } = fakePi(["send_message", "react", "memory", "search", "load_tools", ...NON_CORE]);
  // A new session: Pi's `--tools` activated everything, and the extension puts the catalog back out.
  emit("session_start", { reason: "startup" }, { sessionManager: { getBranch: () => [] } });
  expect(declared().map((t) => t.name).sort()).toEqual([...CORE_TOOLS].sort());
  for (const name of CORE_TOOLS) {
    expect(tool(name).defaultActive).toBeUndefined();
    expect(tool(name).parameters.type).toBe("object");
  }
  expect(tool("send_message").parameters.required).toEqual(["text"]);
  expect(Object.keys(tool("send_message").parameters.properties)).toEqual(["text", "machine", "conversation", "reply_to", "images", "attach_screenshot"]);
  expect(tool("memory").parameters.required).toEqual(["action", "status"]);
  expect(tool("search").parameters.required).toEqual(["query", "status"]);
  expect(tool("react").parameters.required).toEqual(["message", "emoji"]);
  // load_tools is quick: no status line of its own.
  expect(tool("load_tools").parameters).toEqual({ type: "object", properties: { names: { type: "array", items: { type: "string" }, description: "Tool names from the list." } }, required: ["names"] });
  for (const name of NON_CORE) expect(tool(name).defaultActive).toBe(false);
});

test("loading a tool declares its real schema, and it can be called right after", async () => {
  const { emit, declared, tool } = fakePi();
  emit("session_start", { reason: "startup" }, { sessionManager: { getBranch: () => [] } });
  expect(declared().map((t) => t.name)).not.toContain("routine");
  const out = await tool("load_tools").execute("t", { names: ["routine", "openbuild", "nope"] });
  expect(out.isError).toBeUndefined();
  expect(out.details).toEqual({ loaded: ["routine", "openbuild"], missing: ["nope"] });
  expect(out.content[0].text).toContain("call them now");
  // What the next request declares is the tool as registered, not a stub: same object, same schema.
  const original = ALL.find((t) => t.name === "routine");
  const now = declared().find((t) => t.name === "routine");
  expect(JSON.stringify({ d: now.description, p: now.parameters })).toBe(JSON.stringify({ d: original.description, p: original.parameters }));
  expect(now.parameters.required).toEqual(["action", "status"]);
  expect(declared().map((t) => t.name)).toContain("openbuild");
  // Loading one already loaded is harmless.
  expect((await tool("load_tools").execute("t", { names: ["routine"] })).details.loaded).toEqual(["routine"]);
  // An unknown name says what can be loaded.
  const bad = await tool("load_tools").execute("t", { names: ["teleport"] });
  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toContain("No tool here is called teleport");
  expect(bad.content[0].text).toContain("bash");
});

test("a call to a tool that isn't loaded loads it and says to call it again", () => {
  const { emit, declared } = fakePi();
  emit("session_start", { reason: "startup" }, { sessionManager: { getBranch: () => [] } });
  const notFound = { role: "toolResult", toolCallId: "c1", toolName: "todo", content: [{ type: "text", text: "Tool todo not found" }], details: {}, isError: true, timestamp: 1 };
  const out = emit("message_end", { message: notFound });
  expect(out.message.role).toBe("toolResult");
  expect(out.message.toolCallId).toBe("c1");
  expect(out.message.isError).toBe(true);
  expect(out.message.content[0].text).toBe("todo wasn't loaded, so that call didn't run. It's loaded now: call it again.");
  expect(declared().map((t) => t.name)).toContain("todo");
  // Any other error is the tool's own, left alone.
  expect(emit("message_end", { message: { ...notFound, content: [{ type: "text", text: "Error: no such item" }] } })).toBeUndefined();
  expect(emit("message_end", { message: { ...notFound, toolName: "made_up", content: [{ type: "text", text: "Tool made_up not found" }] } })).toBeUndefined();
});

test("a friend's chat still has only chat: nothing to load, and nothing loads by calling it", async () => {
  const { emit, declared, tool } = fakePi(FRIEND_TOOLS);
  emit("session_start", { reason: "startup" }, { sessionManager: { getBranch: () => [] } });
  expect(declared().map((t) => t.name).sort()).toEqual([...FRIEND_TOOLS].sort());
  expect(tool("load_tools")).toBeUndefined();
  const notFound = { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "Tool bash not found" }], details: {}, isError: true, timestamp: 1 };
  expect(emit("message_end", { message: notFound })).toBeUndefined();
  expect(declared().map((t) => t.name).sort()).toEqual([...FRIEND_TOOLS].sort());
  const { friendFlags } = await import("../server/bots/extensions");
  const flags = friendFlags(false);
  expect(flags[flags.indexOf("--tools") + 1]).toBe(FRIEND_TOOLS.join(","));
});

/** A session's entries, as Pi records each loadout: toolsAdded/toolsRemoved on system messages. */
const loadout = (added: string[], removed: string[] = []) => ({ type: "message", message: { role: "system", content: "", ...(added.length ? { toolsAdded: added.map((name) => ({ name })) } : {}), ...(removed.length ? { toolsRemoved: removed.map((name) => ({ name })) } : {}) } });
const said = { type: "message", message: { role: "user", content: "hi" } };

test("a loaded tool stays loaded for the rest of the session, through a restart", () => {
  const catalog = new Set(NON_CORE);
  // What Pi recorded: the core set first, then routine loaded mid-session, then todo loaded and dropped.
  const entries = [loadout([...CORE_TOOLS]), said, loadout(["routine"]), said, loadout(["todo"]), loadout([], ["todo"]), said];
  expect([...loadedTools(entries, catalog)!]).toEqual(["routine"]);
  expect(loadedTools([], catalog)!.size).toBe(0);
  // A restarted Pi on that session: --tools activated everything; routine stays, the rest go.
  const { emit, declared, tool } = fakePi(["send_message", "react", "memory", "search", "load_tools", ...NON_CORE]);
  emit("session_start", { reason: "startup" }, { sessionManager: { getBranch: () => entries } });
  expect(declared().map((t) => t.name).sort()).toEqual([...CORE_TOOLS, "routine"].sort());
  expect(tool("routine").execute).toBeFunction();
});

test("a session from before the catalog keeps every tool it had", () => {
  const catalog = new Set(NON_CORE);
  const old = [loadout(ALL.map((t) => t.name).filter((n) => n !== "load_tools")), said];
  expect(loadedTools(old, catalog)).toBeUndefined();
  // Messages but no recorded loadout at all: keep everything too.
  expect(loadedTools([said], catalog)).toBeUndefined();
  const { emit, declared } = fakePi(["send_message", "react", "memory", "search", "load_tools", ...NON_CORE]);
  emit("session_start", { reason: "startup" }, { sessionManager: { getBranch: () => old } });
  expect(declared().length).toBe(ALL.length);
});

const pi = piBin();

// Real Pi and a fake model: the first request carries only the core, load_tools adds a tool for the
// next request of the same turn, a restarted Pi keeps it, and calling one that isn't loaded loads it.
test.skipIf(!pi)("Pi declares a loaded tool on the next request, and keeps it after a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbuild-bots-tools-"));
  try {
    const agent = join(dir, "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "k" } }));
    const { code, stderr: err } = await spawnScript(`
      import { strict as a } from 'node:assert';
      import { writeFileSync } from 'node:fs';
      import openbots, { CORE_TOOLS } from './server/bots/extension.ts';
      const registered = [];
      openbots({ on() {}, registerTool(t) { registered.push(t); } });
      const schema = (name) => registered.find((t) => t.name === name);
      const sse = (delta, finish) => 'data: ' + JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish ?? null }] }) + '\\n\\n';
      const say = (text) => sse({ role: 'assistant', content: text }) + sse({}, 'stop') + 'data: [DONE]\\n\\n';
      let n = 0;
      const use = (name, args) => sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + (++n), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }) + sse({}, 'tool_calls') + 'data: [DONE]\\n\\n';
      const requests = [];
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
        const body = await req.json();
        const tools = (body.tools ?? []).map((t) => t.function);
        const names = tools.map((t) => t.name);
        // The runner's nudge to acknowledge the user can ride in with a tool's result when the machine is slow: the model carries on from the result.
        const messages = body.messages.filter((m) => !(m.role === 'user' && JSON.stringify(m.content).includes("hasn't heard from you yet")));
        const last = messages.at(-1);
        const text = JSON.stringify(last.content);
        const user = JSON.stringify(messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
        requests.push(names);
        let out;
        if (last.role !== 'tool') {
          if (user.includes('LOAD')) {
            a.deepEqual([...names].sort(), [...CORE_TOOLS].sort());
            const load = tools.find((t) => t.name === 'load_tools');
            a.match(load.description, /\\n- routine: /);
            a.match(load.description, /\\n- bash: /);
            out = use('load_tools', { names: ['routine'] });
          } else if (user.includes('AGAIN')) {
            // A new Pi on the same session: routine is still declared, nothing else came back.
            a.deepEqual([...names].sort(), [...CORE_TOOLS, 'routine'].sort());
            out = use('routine', { action: 'list', status: 'Checking my schedule' });
          } else if (user.includes('DIRECT')) {
            a.ok(!names.includes('todo'));
            out = use('todo', { action: 'list' });
          } else out = say('?');
        } else if (text.includes('Loaded routine')) {
          // The same turn: the next request declares routine with its real schema.
          const routine = tools.find((t) => t.name === 'routine');
          a.ok(routine, names.join(','));
          a.equal(routine.description, schema('routine').description);
          a.deepEqual(routine.parameters, schema('routine').parameters);
          out = use('routine', { action: 'list', status: 'Checking my schedule' });
        } else if (text.includes("todo wasn't loaded")) {
          a.ok(names.includes('todo'), names.join(','));
          a.deepEqual(tools.find((t) => t.name === 'todo').parameters, schema('todo').parameters);
          out = use('todo', { action: 'list' });
        } else if (text.includes('Error')) {
          out = say('tool failed: ' + text.slice(0, 300));
        } else out = say('done ' + n);
        return new Response(out, { headers: { 'content-type': 'text/event-stream' } });
      } });
      writeFileSync(process.env.PI_CODING_AGENT_DIR + '/models.json', JSON.stringify({ providers: { mock: { baseUrl: 'http://127.0.0.1:' + server.port + '/v1', api: 'openai-completions', models: [{ id: 'm' }] } } }));
      const db = await import('./server/bots/db.ts');
      const svc = await import('./server/bots/service.ts');
      const runner = await import('./server/bots/runner.ts');
      svc.updateSettings({ defaultModel: 'mock/m', onboarding: 'done' });
      const { bot, conversationId } = svc.createBot({ name: 'Alpha' });
      runner.startBots();
      const said = () => db.messages(conversationId, 50).filter((r) => !r.message.event && r.message.author === bot.id).map((r) => r.message.text);
      const talk = async (text) => {
        const before = said().length;
        svc.postMessage(conversationId, { id: crypto.randomUUID(), author: 'me', at: Date.now(), text });
        const until = Date.now() + 30000;
        while (Date.now() < until && said().length === before) await Bun.sleep(50);
        const reply = said().at(-1);
        a.ok(reply?.startsWith('done'), text + ': ' + reply);
        while (runner.busy(bot.id) && Date.now() < until) await Bun.sleep(50);
      };
      await talk('LOAD');
      runner.stop(bot.id);
      await talk('AGAIN');
      await talk('DIRECT');
      process.exit(0);
    `, { OPENCHAT_DATA_DIR: join(dir, "data"), PI_CODING_AGENT_DIR: agent, PI_BIN: pi!, PI_OFFLINE: "1", OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json") });
    expect(err).toBe("");
    expect(code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 90_000);
