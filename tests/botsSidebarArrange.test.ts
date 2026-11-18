import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnScript } from "./spawnScript";

// Sidebar moves end to end: the app's real store (src/lib/bots/store.ts) in a tab of its own, a
// process with a fake browser, whose requests go to the real bots routes and service on a throwaway
// data directory. A move is planned the way the sidebar plans a drop (sidebarOrder.ts) and handed to
// the store's `arrange`. Then a second tab, with nothing in its browser storage, loads the workspace
// afresh: what it shows is only what the server kept.
const directory = mkdtempSync(join(tmpdir(), "openbuild-sidebar-arrange-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const env = { OPENCHAT_DATA_DIR: join(directory, "data"), PI_CODING_AGENT_DIR: join(directory, "pi"), PI_BIN: join(directory, "no-pi") };

const PRELUDE = `
  import { mock } from "bun:test";
  import { resolve } from "node:path";
  import assert from "node:assert/strict";
  const devices = await import(resolve("server/devices.ts"));
  const SERVER = devices.serverId();
  mock.module(resolve("src/lib/store.ts"), () => ({ useStore: Object.assign(() => undefined, { getState: () => ({ settings: { profile: {} }, devices: [{ id: SERVER, local: true, name: "Studio" }] }) }) }));
  const memory = new Map();
  globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k), get length() { return memory.size; }, key: (i) => [...memory.keys()][i] ?? null };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.location = { href: "http://localhost/bots" };
  globalThis.history = { state: null, replaceState() {} };
  const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  // Loading the routes starts the runner, which sets its hooks: these replace them, so no bot wakes.
  const { botRoutes } = await import(resolve("server/bots/routes.ts"));
  const svc = await import(resolve("server/bots/service.ts"));
  svc.setHooks({ wake() {}, stop() {} });
  svc.updateSettings({ onboarding: "done" });
  const routes = Object.entries(botRoutes((h) => h)).flatMap(([pattern, methods]) => {
    const names = [...pattern.matchAll(/:(\\w+)/g)].map((m) => m[1]);
    const re = new RegExp("^" + pattern.replace(/:\\w+/g, "([^/]+)") + "$");
    return Object.entries(methods).map(([method, handle]) => ({ method, re, names, handle }));
  }).sort((a, b) => a.names.length - b.names.length);
  const writes = [];
  // The tab's requests, to this server's bound workspace route, answered by the real bots routes.
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/config") return Response.json({ mode: "local", serverId: SERVER, machine: "Studio" });
    const prefix = "/api/workspace/to/" + SERVER;
    if (!url.pathname.startsWith(prefix + "/")) return Response.json({});
    const path = url.pathname.slice(prefix.length);
    const method = init.method ?? "GET";
    if (method !== "GET") writes.push(method + " " + path);
    for (const r of routes) {
      const m = r.method === method && r.re.exec(path);
      if (!m) continue;
      const req = Object.assign(new Request("http://localhost" + path + url.search, { method, headers: init.headers, body: init.body, signal: init.signal }), { params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) });
      const res = await r.handle(req, { timeout() {}, requestIP: () => ({ address: "127.0.0.1" }) });
      res.headers.set("x-openbuild-server", SERVER);
      return res;
    }
    return Response.json({ error: "no route" }, { status: 404 });
  };
  const { useBots, preloadBots, pendingWrites } = await import(resolve("src/lib/bots/store.ts"));
  const order = await import(resolve("src/lib/bots/sidebarOrder.ts"));
  const open = async () => {
    await preloadBots();
    useBots.getState().ensureSeeded();
    for (let i = 0; i < 200 && !(useBots.getState().loaded && useBots.getState().connected); i++) await wait();
    assert.ok(useBots.getState().loaded, "the workspace loaded");
  };
  /** The sidebar as the store has it: each list's chats by name, and the sections. */
  const sidebar = () => {
    const s = useBots.getState();
    const lists = order.sidebarLists(s.conversations, s.bots, s.sections, s.order);
    const name = (c) => c.name ?? s.bots.find((b) => b.id === c.botIds[0]).name;
    return { pinned: lists.pinned.map(name), rest: lists.rest.map(name), filed: Object.fromEntries(lists.filed.map(([section, list]) => [section, list.map(name)])), sections: s.sections };
  };
  const idOf = (name) => useBots.getState().conversations.find((c) => (c.name ?? useBots.getState().bots.find((b) => b.id === c.botIds[0])?.name) === name).id;
  /** A drop, as the sidebar makes it, then until the server has it and its events are back. */
  const drop = async (from, target) => {
    const s = useBots.getState();
    const plan = order.planMove(order.movableLists(order.sidebarLists(s.conversations, s.bots, s.sections, s.order)), s.order, idOf(from), "list" in target ? target : { id: idOf(target.id), place: target.place });
    assert.ok(plan, "a move from " + from);
    s.arrange(plan);
    for (let i = 0; i < 200 && pendingWrites(SERVER) > 0; i++) await wait();
    await wait(100);
    assert.equal(useBots.getState().error, undefined);
  };
`;

async function tab(script: string) {
  const { code, stdout, stderr } = await spawnScript(PRELUDE + script + "\nprocess.exit(0);", env);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

test("swaps across sections land whole on the server, sections kept, and a fresh tab shows them as left", async () => {
  const moved = await tab(`
    // Ada alone in Work, the Crew group loose in the rows, Cleo alone in Home, Bo pinned.
    const ada = svc.createBot({ name: "Ada" }), bo = svc.createBot({ name: "Bo" }), cleo = svc.createBot({ name: "Cleo" });
    const crew = svc.createConversation({ kind: "group", name: "Crew", botIds: [bo.bot.id, cleo.bot.id] });
    const ours = [ada.conversationId, bo.conversationId, cleo.conversationId, crew.id];
    // The starter bot the workspace begins with is out of the way.
    for (const c of svc.snapshot().conversations) if (!ours.includes(c.id)) svc.updateConversation(c.id, { hidden: true, pinnedAt: null });
    svc.updateConversation(ada.conversationId, { section: "Work", pinnedAt: null });
    svc.updateConversation(cleo.conversationId, { section: "Home", pinnedAt: null });
    svc.updateConversation(crew.id, { pinnedAt: null });
    svc.updateConversation(bo.conversationId, { pinnedAt: 1 });
    svc.updateSettings({ sections: ["Work", "Home"] });
    await open();
    const steps = [sidebar()];

    // Ada (the only chat in Work) swapped with Crew (in the rows): Crew into Work, Ada into Crew's row.
    await drop("Ada", { id: "Crew", place: "swap" });
    steps.push(sidebar());
    // The two sections' only chats swapped: Crew into Home, Cleo into Work.
    await drop("Crew", { id: "Cleo", place: "swap" });
    steps.push(sidebar());
    // A pinned bot and the only chat in a section: Cleo pinned in Bo's place, Bo into Work.
    await drop("Bo", { id: "Cleo", place: "swap" });
    steps.push(sidebar());
    // Only the move's own write went out for each.
    const arranged = writes.filter((w) => w.endsWith("/arrange")).length;
    console.log(JSON.stringify({ steps, arranged, others: writes.filter((w) => !w.endsWith("/arrange")), server: svc.getSettings().sections }));
  `);
  expect(moved.steps[0]).toEqual({ pinned: ["Bo"], rest: ["Crew"], filed: { Work: ["Ada"], Home: ["Cleo"] }, sections: ["Work", "Home"] });
  expect(moved.steps[1]).toEqual({ pinned: ["Bo"], rest: ["Ada"], filed: { Work: ["Crew"], Home: ["Cleo"] }, sections: ["Work", "Home"] });
  expect(moved.steps[2]).toEqual({ pinned: ["Bo"], rest: ["Ada"], filed: { Work: ["Cleo"], Home: ["Crew"] }, sections: ["Work", "Home"] });
  expect(moved.steps[3]).toEqual({ pinned: ["Cleo"], rest: ["Ada"], filed: { Work: ["Bo"], Home: ["Crew"] }, sections: ["Work", "Home"] });
  expect(moved.arranged).toBe(3);
  expect(moved.server).toEqual(["Work", "Home"]);

  // Reloaded, with nothing cached in the browser: the server's copy is the same.
  const reloaded = await tab(`
    await open();
    console.log(JSON.stringify(sidebar()));
  `);
  expect(reloaded).toEqual(moved.steps[3]);
}, 60_000);

test("the last chat out of a section still takes the section along, and the order survives a reload", async () => {
  const moved = await tab(`
    await open();
    // Crew, alone in Home, dragged below Ada among the rows: Home goes, as it does when it's moved from the menu.
    await drop("Crew", { id: "Ada", place: "after" });
    // And above Ada: the rows in the order put there by hand.
    await drop("Crew", { id: "Ada", place: "before" });
    console.log(JSON.stringify(sidebar()));
  `);
  expect(moved).toEqual({ pinned: ["Cleo"], rest: ["Crew", "Ada"], filed: { Work: ["Bo"] }, sections: ["Work"] });
  const reloaded = await tab(`
    await open();
    console.log(JSON.stringify(sidebar()));
  `);
  expect(reloaded).toEqual(moved);
}, 60_000);
