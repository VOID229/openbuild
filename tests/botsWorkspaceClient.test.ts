import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A tab's OpenBots kept per workspace: this server's ("srv", "Studio") and a paired host's ("host",
// "Host Box"), each by its server id. Every tab is its own process with a fake browser (address,
// session and local storage, fetch), so module state stays per tab as it does in a browser. The
// host's routes are faked here; tests/botsWorkspaceServers.test.ts covers them on real servers.
const directory = mkdtempSync(join(tmpdir(), "openbuild-bots-tabs-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const PRELUDE = `
  import { mock } from "bun:test";
  import { resolve } from "node:path";
  import assert from "node:assert/strict";
  import { existsSync, readFileSync, writeFileSync } from "node:fs";
  const devices = [{ id: "srv", local: true, name: "Studio" }, { id: "host", name: "Host Box" }];
  mock.module(resolve("src/lib/store.ts"), () => ({ useStore: Object.assign(() => undefined, { getState: () => ({ settings: { profile: {} }, devices }) }) }));
  // This browser's local storage, shared by its tabs through a file; each tab's session is its own.
  const FILE = process.env.STORAGE;
  const disk = () => (FILE && existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
  const save = (d) => writeFileSync(FILE, JSON.stringify(d));
  globalThis.localStorage = {
    getItem: (k) => disk()[k] ?? null,
    setItem: (k, v) => { const d = disk(); d[k] = String(v); save(d); },
    removeItem: (k) => { const d = disk(); delete d[k]; save(d); },
  };
  const session = new Map();
  globalThis.sessionStorage = { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, String(v)), removeItem: (k) => session.delete(k) };
  globalThis.location = { href: process.env.TAB_URL || "http://localhost/" };
  globalThis.history = { state: null, replaceState(state, _, url) { this.state = state; location.href = String(url); } };
  const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

  const chat = (id, messages = []) => ({ id, kind: "direct", botIds: ["bot"], createdAt: 1, updatedAt: 1, messages });
  const snap = (conversations) => ({ bots: [{ id: "bot", name: "Bot", look: {} }], conversations, settings: { sections: [] }, typing: {}, drafts: [], status: {} });
  const snapshots = { srv: snap([chat("local-chat")]), host: snap([chat("host-chat")]) };
  const prefixes = { srv: "/api/workspace/to/srv", host: "/api/workspace/via/host" };
  const calls = [];
  const streams = { srv: [], host: [] };
  const enc = new TextEncoder();
  /** Return a promise to answer a request yourself, or undefined to let the fake workspace answer. */
  let hold = () => undefined;
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    const method = init.method ?? "GET";
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
    if (path === "/api/config") return Response.json({ mode: "local", serverId: "srv", machine: "Studio" });
    const held = hold(path, method, init);
    if (held) return held;
    for (const [id, prefix] of Object.entries(prefixes)) {
      if (!path.startsWith(prefix + "/")) continue;
      const rest = path.slice(prefix.length);
      const headers = { "x-openbuild-server": id };
      if (rest === "/api/bots") return Response.json(snapshots[id], { headers });
      if (rest === "/api/bots/stream") {
        let controller;
        const body = new ReadableStream({ start(c) { controller = c; } });
        const s = { send: (e) => { try { controller.enqueue(enc.encode(JSON.stringify(e) + "\\n")); } catch {} } };
        streams[id].push(s);
        s.send({ t: "hello", workspace: id });
        s.send({ t: "snapshot", ...snapshots[id] });
        return new Response(body, { headers });
      }
      return Response.json({ ok: true }, { headers });
    }
    return Response.json({ ok: true });
  };
  const bots = await import(resolve("src/lib/bots/store.ts"));
  const { useBots, preloadBots, switchWorkspace, cancelSwitch, pendingWrites } = bots;
  const { useWorkspace } = await import(resolve("src/lib/bots/workspace.ts"));
  const ids = () => useBots.getState().conversations.map((c) => c.id);
  /** A request held until the test answers it. */
  const deferred = () => { let answer; const promise = new Promise((r) => (answer = r)); return { promise, answer }; };
`;

async function tab(script: string, env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "--eval", PRELUDE + script + "\nprocess.exit(0);"], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  return stdout.trim();
}

test("two tabs on different workspaces keep everything apart, and each comes back to its own", async () => {
  const storage = join(directory, "two-tabs.json");
  const opened = `
    await preloadBots();
    useBots.getState().ensureSeeded();
    await wait(60);
    const workspace = useBots.getState().workspace;
    useBots.getState().toggleFolded("work-" + workspace);
    useBots.getState().setDetailsOpen(workspace === "srv");
    await wait(1200);
    const own = prefixes[workspace];
    const others = calls.filter((c) => c.path !== "/api/config" && c.path !== "/api/bots/settings" && !c.path.startsWith(own + "/"));
    console.log(JSON.stringify({ workspace, conversations: ids(), activeId: useBots.getState().activeId, others, href: location.href, session: sessionStorage.getItem("openbuild.workspace") }));
  `;
  const local = JSON.parse(await tab(opened, { STORAGE: storage, TAB_URL: "http://localhost/bots" }));
  const remote = JSON.parse(await tab(opened, { STORAGE: storage, TAB_URL: "http://localhost/bots?workspace=host" }));
  // A new tab opens on this server; the other one is on the host its address names.
  expect(local).toMatchObject({ workspace: "srv", conversations: ["local-chat"], activeId: "local-chat", others: [], href: "http://localhost/bots", session: "srv" });
  expect(remote).toMatchObject({ workspace: "host", conversations: ["host-chat"], activeId: "host-chat", others: [], href: "http://localhost/bots?workspace=host", session: "host" });
  const saved = JSON.parse(readFileSync(storage, "utf8")) as Record<string, string>;
  // Layout and cached snapshots under each workspace's own id, never shared or merged.
  expect(JSON.parse(saved["openbuild.bots.layout:srv"]!)).toEqual({ folded: ["hidden", "work-srv"], activeId: "local-chat", detailsOpen: true });
  expect(JSON.parse(saved["openbuild.bots.layout:host"]!)).toEqual({ folded: ["hidden", "work-host"], activeId: "host-chat", detailsOpen: false });
  expect(JSON.parse(saved["openchat-kv:openbuild-bots/cache:snapshot:srv"]!).conversations.map((c: any) => c.id)).toEqual(["local-chat"]);
  expect(JSON.parse(saved["openchat-kv:openbuild-bots/cache:snapshot:host"]!).conversations.map((c: any) => c.id)).toEqual(["host-chat"]);
  expect(Object.keys(saved).filter((k) => k.includes("openbuild.bots") && !/:(srv|host)$/.test(k))).toEqual([]);
  // Reopening the host's tab paints the host's cache, and nothing of this server's.
  const reopened = await tab(`
    hold = () => new Promise(() => {});
    await preloadBots();
    console.log(JSON.stringify({ workspace: useBots.getState().workspace, conversations: ids(), detailsOpen: useBots.getState().detailsOpen }));
  `, { STORAGE: storage, TAB_URL: "http://localhost/bots?workspace=host" });
  expect(JSON.parse(reopened)).toEqual({ workspace: "host", conversations: ["host-chat"], detailsOpen: false });
}, 30_000);

test("a switch waits for the workspace's changes, can be called off, and never cuts a write short", async () => {
  const out = await tab(`
    await preloadBots();
    useBots.getState().ensureSeeded();
    await wait(60);
    let ack = deferred();
    hold = (path, method) => (method === "POST" && path.endsWith("/messages") ? ack.promise : undefined);
    const sent = useBots.getState().post("local-chat", { author: "me", text: "on its way" });
    await wait();
    assert.equal(pendingWrites("srv"), 1);

    // Blocked: the dialog says what it's waiting for, and nothing goes to the host yet.
    const blocked = switchWorkspace("host");
    await wait();
    assert.deepEqual(useWorkspace.getState().switching, { to: "host", waiting: 1 });
    assert.equal(useBots.getState().workspace, "srv");
    assert.equal(calls.filter((c) => c.path.startsWith(prefixes.host)).length, 0);

    // Called off: the tab stays, and the write still finishes here.
    cancelSwitch();
    assert.equal(await blocked, false);
    assert.equal(useWorkspace.getState().switching, undefined);
    ack.answer(Response.json({ ok: true }, { headers: { "x-openbuild-server": "srv" } }));
    assert.equal((await sent).text, "on its way");
    assert.equal(useBots.getState().workspace, "srv");

    // Waited out: the switch goes ahead once the write has its answer.
    ack = deferred();
    const second = useBots.getState().post("local-chat", { author: "me", text: "second" });
    await wait();
    const moving = switchWorkspace("host");
    await wait();
    assert.equal(useBots.getState().workspace, "srv");
    ack.answer(Response.json({ ok: true }, { headers: { "x-openbuild-server": "srv" } }));
    assert.equal((await second).text, "second");
    assert.equal(await moving, true);
    await wait(60);
    assert.equal(useBots.getState().workspace, "host");
    assert.deepEqual(ids(), ["host-chat"]);
    assert.equal(location.href, "http://localhost/?workspace=host");
    // Each write went to its own workspace only.
    const posts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
    assert.deepEqual(posts.map((c) => [c.path, c.body.text]), [
      [prefixes.srv + "/api/bots/conversations/local-chat/messages", "on its way"],
      [prefixes.srv + "/api/bots/conversations/local-chat/messages", "second"],
    ]);
    console.log("ok");
  `);
  expect(out).toBe("ok");
}, 30_000);

test("a failed write stays with its workspace, is reconciled only against that workspace's snapshot, and is retried only there", async () => {
  const storage = join(directory, "unconfirmed.json");
  const out = await tab(`
    await preloadBots();
    useBots.getState().ensureSeeded();
    await wait(60);
    assert.equal(useBots.getState().workspace, "host");

    // The host stops answering as the message goes.
    hold = (path) => (path.startsWith(prefixes.host) ? Promise.resolve(Response.json({ error: "Host Box is unreachable", reason: "offline" }, { status: 502 })) : undefined);
    const sent = await useBots.getState().post("host-chat", { author: "me", text: "did this land?" });
    assert.equal(sent, undefined);
    const [entry] = useBots.getState().unconfirmed;
    assert.equal(entry.workspace, "host");
    assert.match(entry.label, /did this land/);
    assert.deepEqual(ids(), ["host-chat"]);
    assert.deepEqual(useBots.getState().conversations[0].messages, []);
    hold = () => undefined;

    // This server's snapshot even holds a message with that id: it isn't the host's, so it settles nothing.
    snapshots.srv = snap([chat("local-chat", [{ id: entry.check.messageId, author: "me", text: "did this land?", at: 5 }])]);
    assert.equal(await switchWorkspace("srv"), true);
    await wait(60);
    assert.equal(useBots.getState().workspace, "srv");
    assert.deepEqual(useBots.getState().unconfirmed, []);
    assert.equal(JSON.parse(localStorage.getItem("openbuild.bots.unconfirmed:host")).length, 1);

    // Late answers and events for the host are dropped here: its old stream and an old page.
    for (const s of streams.host) s.send({ t: "message", conversationId: "host-chat", message: { id: "late", author: "bot", text: "late", at: 9 } });
    await wait();
    assert.deepEqual(ids(), ["local-chat"]);
    assert.ok(!JSON.stringify(useBots.getState().conversations).includes("late"));

    // Back on the host, its own next snapshot shows the message never arrived: now it can be retried, there only.
    assert.equal(await switchWorkspace("host"), true);
    await wait(60);
    const [missing] = useBots.getState().unconfirmed;
    assert.equal(missing.missing, true);
    useBots.getState().retryUnconfirmed(missing.id);
    await wait(60);
    assert.deepEqual(useBots.getState().unconfirmed, []);
    const posts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
    assert.deepEqual(posts.map((c) => c.path), [prefixes.host + "/api/bots/conversations/host-chat/messages", prefixes.host + "/api/bots/conversations/host-chat/messages"]);
    assert.equal(posts[0].body.id, posts[1].body.id);
    // Nothing was ever sent to this server's conversations, from either workspace.
    assert.equal(calls.filter((c) => c.method !== "GET" && c.path.startsWith(prefixes.srv)).length, 0);
    console.log("ok");
  `, { STORAGE: storage, TAB_URL: "http://localhost/?workspace=host" });
  expect(out).toBe("ok");
}, 30_000);

test("a write that did land before its answer was lost is cleared by its workspace's snapshot", async () => {
  const out = await tab(`
    await preloadBots();
    useBots.getState().ensureSeeded();
    await wait(60);
    // The host takes the message, but the answer never makes it back.
    hold = (path, method, init) => {
      if (method !== "POST" || !path.endsWith("/messages")) return undefined;
      snapshots.host = snap([chat("host-chat", [{ ...JSON.parse(init.body), at: 7 }])]);
      return Promise.reject(new TypeError("network connection was lost"));
    };
    await useBots.getState().post("host-chat", { author: "me", text: "landed after all" });
    await wait(60);
    assert.deepEqual(useBots.getState().unconfirmed, []);
    assert.deepEqual(useBots.getState().conversations[0].messages.map((m) => m.text), ["landed after all"]);
    console.log("ok");
  `, { TAB_URL: "http://localhost/?workspace=host", STORAGE: join(directory, "landed.json") });
  expect(out).toBe("ok");
}, 30_000);

test("a tab whose workspace isn't here anymore says so and takes on nothing from the server there now", async () => {
  // The tab was on "old-srv"; this address now serves "srv", which isn't paired with it.
  const out = await tab(`
    hold = (path) => (path.startsWith("/api/workspace/via/old-srv/") ? Promise.resolve(Response.json({ error: "not paired", reason: "unpaired" }, { status: 404 })) : undefined);
    sessionStorage.setItem("openbuild.workspace", "old-srv");
    await preloadBots();
    useBots.getState().ensureSeeded();
    await wait(60);
    assert.equal(useBots.getState().workspace, "old-srv");
    assert.equal(useWorkspace.getState().problem.kind, "gone");
    assert.deepEqual(ids(), []);
    assert.equal(calls.filter((c) => c.path.startsWith(prefixes.srv)).length, 0);

    // In this server's own workspace, a stream naming another server is refused the same way.
    await switchWorkspace("srv");
    const intruder = { "x-openbuild-server": "intruder" };
    hold = (path) => {
      if (path === prefixes.srv + "/api/bots") return Promise.resolve(Response.json(snap([chat("intruder-chat")]), { headers: intruder }));
      if (path !== prefixes.srv + "/api/bots/stream") return undefined;
      const body = new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify({ t: "hello", workspace: "intruder" }) + "\\n" + JSON.stringify({ t: "snapshot", ...snap([chat("intruder-chat")]) }) + "\\n"));
      } });
      return Promise.resolve(new Response(body, { headers: intruder }));
    };
    await switchWorkspace("host");
    await switchWorkspace("srv");
    await wait(80);
    assert.equal(useWorkspace.getState().problem?.kind, "gone");
    assert.ok(!ids().includes("intruder-chat"));
    console.log("ok");
  `);
  expect(out).toBe("ok");
}, 30_000);

test("a workspace that stalls, ignoring the abort, on headers or a body doesn't hold the queue or a switch, and nothing is replayed", async () => {
  const out = await tab(`
    bots.deadlines.write = 150;
    bots.deadlines.read = 150;
    await preloadBots();
    useBots.getState().ensureSeeded();
    await wait(60);
    assert.equal(useBots.getState().workspace, "srv");
    const never = new Promise(() => {});
    // Headers that never come, whatever the signal says; then a refusal, and a snapshot, whose bodies never finish.
    const stalled = (status) => Promise.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }), { status, headers: { "x-openbuild-server": "srv", "content-type": "application/json" } }));
    let tries = 0;
    hold = (path, method) => {
      if (method === "POST" && path.endsWith("/messages")) return ++tries === 1 ? never : stalled(500);
      if (path === prefixes.srv + "/api/bots") return stalled(200);
      return undefined;
    };
    const started = Date.now();
    const first = useBots.getState().post("local-chat", { author: "me", text: "stalled headers" });
    const second = useBots.getState().post("local-chat", { author: "me", text: "stalled body" });
    await wait();
    const switching = switchWorkspace("host");
    await wait();
    assert.deepEqual(useWorkspace.getState().switching, { to: "host", waiting: 2 });
    assert.equal(await first, undefined);
    assert.equal(await second, undefined);
    assert.ok(Date.now() - started < 3000);
    const kept = JSON.parse(localStorage.getItem("openbuild.bots.unconfirmed:srv"));
    assert.equal(kept.length, 2);
    assert.ok(kept.every((e) => e.workspace === "srv" && !e.rejected));
    assert.match(kept[0].error, /No answer/);
    assert.equal(pendingWrites("srv"), 0);
    hold = () => undefined;

    // The switch was waiting on these; with them let go it goes ahead.
    assert.equal(await switching, true);
    await wait(60);
    assert.equal(useBots.getState().workspace, "host");
    assert.deepEqual(useBots.getState().unconfirmed, []);
    assert.equal(JSON.parse(localStorage.getItem("openbuild.bots.unconfirmed:srv")).length, 2);
    // Neither was sent anywhere else, or again.
    const posts = calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
    assert.deepEqual(posts.map((c) => [c.path.startsWith(prefixes.srv), c.body.text]), [[true, "stalled headers"], [true, "stalled body"]]);
    console.log("ok");
  `, { STORAGE: join(directory, "stalls.json") });
  expect(out).toBe("ok");
}, 30_000);

test("this server's own management writes name it too, so an address now serving another server runs none of them", async () => {
  const out = await tab(`
    await preloadBots();
    useBots.getState().ensureSeeded();
    await wait(60);
    await new Promise((r) => setTimeout(r, 50));
    // Management goes to the bound route by this server's id, the profile sync included.
    const profile = calls.find((c) => c.method === "PATCH" && c.path.endsWith("/api/bots/settings"));
    assert.equal(profile.path, prefixes.srv + "/api/bots/settings");
    // Now another server answers at this address: the bound route there refuses everything.
    hold = (path) => (path.startsWith(prefixes.srv) ? Promise.resolve(Response.json({ error: "This is Intruder, not the workspace this was meant for. Nothing ran.", reason: "mismatch" }, { status: 409, headers: { "x-openbuild-server": "intruder" } })) : undefined);
    const before = calls.length;
    useBots.getState().createBot({ name: "Made here", look: { shape: "puff", color: "blue" } });
    useBots.getState().setDefaultModel("x/y");
    await wait(80);
    const sent = calls.slice(before);
    assert.ok(sent.length >= 1);
    assert.ok(sent.every((c) => c.path.startsWith(prefixes.srv + "/")), JSON.stringify(sent));
    assert.equal(calls.filter((c) => c.path.startsWith("/api/bots")).length, 0);
    assert.equal(useWorkspace.getState().problem?.kind, "gone");
    assert.ok(!useBots.getState().bots.some((b) => b.name === "Made here"));
    console.log("ok");
  `);
  expect(out).toBe("ok");
}, 30_000);

test("a reaction is sent as the state it should end in, so a retry can't undo a late first try", async () => {
  const out = await tab(`
    snapshots.srv = snap([chat("local-chat", [{ id: "m1", author: "bot", text: "hi", at: 1 }])]);
    await preloadBots();
    useBots.getState().ensureSeeded();
    await wait(60);
    useBots.getState().toggleReaction("local-chat", "m1", "👍", "me");
    await wait();
    useBots.getState().toggleReaction("local-chat", "m1", "👍", "me");
    await wait();
    const sent = calls.filter((c) => c.method === "PATCH" && c.path.endsWith("/messages/m1")).map((c) => c.body);
    assert.deepEqual(sent, [{ emoji: "👍", on: true }, { emoji: "👍", on: false }]);
    console.log("ok");
  `);
  expect(out).toBe("ok");
}, 30_000);

test("a delete of older history that wasn't confirmed stays unknown while the snapshot only holds the latest page", async () => {
  const out = await tab(`
    const latest = { id: "new", author: "bot", text: "latest", at: 50 };
    const older = { id: "old", author: "me", text: "from long ago", at: 1 };
    snapshots.host = snap([{ ...chat("host-chat", [latest]), more: true }]);
    await preloadBots();
    useBots.getState().ensureSeeded();
    await wait(60);
    // The older page is loaded, and the delete of one of its messages gets no answer.
    hold = (path, method) => {
      if (path.includes("beforeId=")) return Promise.resolve(Response.json({ messages: [older], more: false }, { headers: { "x-openbuild-server": "host" } }));
      if (method === "DELETE") return Promise.resolve(Response.json({ error: "unreachable", reason: "offline" }, { status: 502 }));
      return undefined;
    };
    await useBots.getState().loadOlder("host-chat");
    assert.deepEqual(ids(), ["host-chat"]);
    assert.deepEqual(useBots.getState().conversations[0].messages.map((m) => m.id), ["old", "new"]);
    useBots.getState().deleteMessage("host-chat", "old");
    await wait(80);
    hold = () => undefined;
    // The host's snapshot (its latest page only) doesn't have it, which says nothing about the old one.
    const [entry] = useBots.getState().unconfirmed;
    assert.equal(entry.check.kind, "delete");
    assert.equal(entry.unknown, true);
    assert.equal(entry.missing, false);
    // A later snapshot of the same page leaves it as it is: still kept, not offered for a retry.
    await switchWorkspace("srv");
    await switchWorkspace("host");
    await wait(80);
    assert.equal(useBots.getState().unconfirmed.length, 1);
    assert.equal(useBots.getState().unconfirmed[0].unknown, true);
    // Only a full history, where it's truly absent, settles it.
    snapshots.host = snap([chat("host-chat", [latest])]);
    await switchWorkspace("srv");
    await switchWorkspace("host");
    await wait(80);
    assert.deepEqual(useBots.getState().unconfirmed, []);
    console.log("ok");
  `, { TAB_URL: "http://localhost/?workspace=host", STORAGE: join(directory, "older-delete.json") });
  expect(out).toBe("ok");
}, 30_000);
