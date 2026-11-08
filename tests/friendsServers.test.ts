import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { joinProof, loadKeyPair, newKeyPair, nonce, seal, unseal, type KeyPair } from "../server/friends/protocol";

// Two people's OpenBuilds becoming friends, end to end over loopback: real servers on throwaway data
// directories, "Alice" (who invites, and hosts) and "Bob" (who adds her code, and dials). This process
// is each owner at their own terminal (the control socket) and browser (the app's API), and, for the
// wire checks, a client speaking the friend protocol by hand. No real pairing, Tailscale, server or
// data is touched, and no Pi runs.
const directory = mkdtempSync(join(tmpdir(), "openbuild-friends-e2e-"));
const data = (name: string) => {
  const dir = join(directory, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const alice = { name: "Alice", dir: data("alice"), port: 0, friendPort: 0 };
const bob = { name: "Bob", dir: data("bob"), port: 0, friendPort: 0 };
type Side = typeof alice;
const children = new Map<Side, ReturnType<typeof Bun.spawn>>();
const app = (side: Side) => `http://127.0.0.1:${side.port}`;
const friendBase = () => `http://127.0.0.1:${alice.friendPort}`;

async function until<T>(check: () => Promise<T | undefined | false>, label: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await Bun.sleep(80);
  }
  throw new Error(`Timed out: ${label}${last ? ` (${(last as Error).message})` : ""}`);
}

const freePort = () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
};

async function launch(side: Side) {
  const child = Bun.spawn([process.execPath, resolve("server/index.ts")], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(side.port),
      HOST: "127.0.0.1",
      OPENCHAT_DATA_DIR: side.dir,
      OPENCHAT_SECRETS: "file",
      OPENCHAT_SECRETS_FILE: join(side.dir, "secrets.json"),
      PI_CODING_AGENT_DIR: join(side.dir, "pi"),
      PI_BIN: join(side.dir, "no-pi"),
      OPENBUILD_FRIEND_HOST: "127.0.0.1",
      OPENBUILD_FRIEND_PORT: String(side.friendPort),
      CI: "1",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  children.set(side, child);
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`${side.name}'s server exited`);
    return (await fetch(`${app(side)}/api/auth/status`)).ok && (await control(side, "status").then(() => true));
  }, `${side.name} starting`);
}

async function stop(side: Side) {
  const child = children.get(side);
  child?.kill();
  await child?.exited;
  children.delete(side);
}

/** The owner at their terminal: what `openbuild friend …` sends. */
async function control(side: Side, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch("http://localhost/", { unix: join(side.dir, "friends", "control.sock"), method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }) } as RequestInit);
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (body.error) throw new Error(body.error);
  return body.result;
}

/** `openbuild friend add`: every line the server answers with. */
async function add(side: Side, code: string): Promise<any[]> {
  const res = await fetch("http://localhost/", { unix: join(side.dir, "friends", "control.sock"), method: "POST", body: JSON.stringify({ method: "add", params: { code } }) } as RequestInit);
  return (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
}

const json = (body: unknown, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const snapshot = async (side: Side) => (await (await fetch(`${app(side)}/api/bots`)).json()) as { bots: { id: string; name: string; primary?: boolean }[]; conversations: any[] };
const sharedChat = async (side: Side) => (await snapshot(side)).conversations.find((c) => c.friend);
const messages = async (side: Side, id: string) => ((await (await fetch(`${app(side)}/api/bots/conversations/${id}/messages`)).json()) as { messages: any[] }).messages;
const post = (side: Side, conversation: string, text: string, id: string = crypto.randomUUID()) =>
  fetch(`${app(side)}/api/bots/conversations/${conversation}/messages`, json({ id, author: "me", text })).then(async (r) => (expect(r.status).toBe(200), id));
const friendsOf = async (side: Side) => (await control(side, "status")).friends as { id: string; name: string; status: string; role: string; fingerprint: string }[];
/** The real CLI, as the owner types it. */
function cli(side: Side, ...args: string[]): string {
  const out = Bun.spawnSync([process.execPath, resolve("bin/openbuild.ts"), "friend", ...args], { env: { ...process.env, OPENCHAT_DATA_DIR: side.dir, NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  return out.stdout.toString() + out.stderr.toString();
}
const keyOf = (side: Side): KeyPair => loadKeyPair(JSON.parse(readFileSync(join(side.dir, "friends", "identity.json"), "utf8")));

beforeAll(async () => {
  for (const side of [alice, bob]) {
    side.port = freePort();
    side.friendPort = freePort();
  }
  await Promise.all([launch(alice), launch(bob)]);
  for (const side of [alice, bob]) expect((await fetch(`${app(side)}/api/bots/settings`, json({ user: { name: side.name } }, "PATCH"))).status).toBe(200);
}, 60_000);

/** The Pi and Durable workers the servers started outlive them by design: stop the ones on this test's data. */
function stopWorkers() {
  if (!existsSync("/proc")) return;
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (env.some((v) => v.startsWith(`OPENCHAT_DATA_DIR=${directory}`))) process.kill(Number(pid), "SIGKILL");
    } catch {}
  }
}

afterAll(async () => {
  await Promise.all([...children.keys()].map(stop));
  stopWorkers();
  rmSync(directory, { recursive: true, force: true });
});

let code = "";
let aliceChat = "";
let bobChat = "";

test("an invite code, the friend's request and the owner's approval make them friends, each holding the other's key", async () => {
  // Nothing listens for friends until there's something to listen for.
  await expect(fetch(`${friendBase()}/friend/v1/connect`)).rejects.toThrow();
  const invite = await control(alice, "invite", { mode: "lan", address: `127.0.0.1:${alice.friendPort}` });
  code = invite.code;
  expect(invite.urls).toEqual([`http://127.0.0.1:${alice.friendPort}`]);
  const joining = add(bob, code);
  const { request } = await control(alice, "wait");
  expect(request.name).toBe("Bob");
  // What Alice is asked to approve is Bob's real key.
  expect(request.fingerprint).toBe(keyOf(bob).id.slice(0, 16).match(/.{4}/g)!.join("-"));
  expect((await control(alice, "decide", { request: request.id, approve: true })).friend).toMatchObject({ name: "Bob", role: "guest", mode: "lan" });
  const lines = await joining;
  expect(lines[0].waiting.name).toBe("Alice");
  expect(lines.at(-1).friend).toMatchObject({ name: "Alice", role: "host", mode: "lan" });

  // Each knows the other by their key's id, and holds their real public key.
  const [aliceFriends, bobFriends] = [await friendsOf(alice), await friendsOf(bob)];
  expect(aliceFriends.map((f) => [f.id, f.name])).toEqual([[keyOf(bob).id, "Bob"]]);
  expect(bobFriends.map((f) => [f.id, f.name])).toEqual([[keyOf(alice).id, "Alice"]]);
  const bobsCopy = JSON.parse(readFileSync(join(bob.dir, "friends", "friends.json"), "utf8")).friends[0];
  expect(bobsCopy.publicKey).toBe(keyOf(alice).publicKey);
  // Only Bob dials: Alice's side never connects anywhere.
  expect(bobsCopy.urls).toEqual([`http://127.0.0.1:${alice.friendPort}`]);
  await until(async () => (await friendsOf(alice))[0]?.status === "online" && (await friendsOf(bob))[0]?.status === "online", "both connected");
}, 60_000);

test("the code works once, and only with its secret", async () => {
  const stranger = loadKeyPair(newKeyPair());
  const parsed = JSON.parse(Buffer.from(code.slice(5), "base64url").toString());
  const ask = (proof: string) => {
    const n = nonce();
    return fetch(`${friendBase()}/friend/v1/join`, json(JSON.parse(seal({ t: "join", from: stranger.id, to: keyOf(alice).id, invite: parsed.i, key: stranger.publicKey, name: "Mallory", nonce: n, proof: proof || joinProof(parsed.s, { invite: parsed.i, from: stranger.id, nonce: n }) }, stranger))));
  };
  // Used by Bob already.
  expect((await ask("")).status).toBe(409);
  // A wrong secret is refused, and doesn't tell anything.
  expect((await ask(joinProof("d3Jvbmctc2VjcmV0LXdyb25n", { invite: parsed.i, from: stranger.id, nonce: "x" }))).status).toBe(403);
  expect((await friendsOf(alice)).map((f) => f.name)).toEqual(["Bob"]);
});

test("the friend port answers the friend protocol and nothing else", async () => {
  const paths = ["/", "/index.html", "/thread-1", "/api/auth/status", "/api/auth/login", "/api/pair/info", "/api/pair/claim", "/api/bots", "/api/bots/stream", "/api/bots/settings", "/api/chats", "/api/projects", "/api/fs/list", "/api/terminals", "/api/computers", "/api/devices", "/api/paired-clients", "/api/state", "/api/keys/secrets", "/api/friends", "/api/workspace/to/x/api/bots", "/api/remote/status", "/api/pi/status", "/api/preview/relay/3100", "/friend/v1", "/friend/v1/", "/friend/v2/connect"];
  for (const path of paths) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const res = await fetch(`${friendBase()}${path}`, { method, ...(method === "GET" ? {} : { body: "{}" }) });
      expect([path, method, res.status]).toEqual([path, method, 404]);
      expect(await res.text()).toBe("Not found");
    }
  }
  // The connect path itself: a stranger is refused, a friend must upgrade, and nothing from a browser counts.
  expect((await fetch(`${friendBase()}/friend/v1/connect?from=${loadKeyPair(newKeyPair()).id}`)).status).toBe(403);
  expect((await fetch(`${friendBase()}/friend/v1/connect?from=${keyOf(bob).id}`)).status).toBe(426);
  expect((await fetch(`${friendBase()}/friend/v1/connect?from=${keyOf(bob).id}`, { headers: { origin: "https://evil.example" } })).status).toBe(404);
  expect((await fetch(`${friendBase()}/friend/v1/join`, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status).toBe(404);
  // And the app's own port doesn't speak it.
  const appJoin = await fetch(`${app(alice)}/friend/v1/join`, { method: "POST", body: "{}" });
  expect(appJoin.headers.get("content-type") ?? "").not.toContain("application/json");
});

test("a shared chat syncs both ways, each side's words attributed to that side", async () => {
  const { bots: aliceBots } = await snapshot(alice);
  const egg = aliceBots.find((b) => b.primary)!;
  const { chat } = await control(alice, "chat", { friend: "Bob", name: "Weekend plans", bots: [egg.name] });
  aliceChat = chat.id;
  const theirs = await until(sharedChat.bind(null, bob), "Bob gets the chat");
  bobChat = theirs.id;
  expect(theirs).toMatchObject({ kind: "group", name: "Weekend plans", botIds: [], friend: { friend: keyOf(alice).id, friendName: "Alice", chat: aliceChat } });
  expect(theirs.friend.members.map((m: any) => m.name)).toEqual([egg.name]);

  // Bob brings one of his bots in, the way the Members panel does; Alice sees who joined.
  const bobsBot = (await snapshot(bob)).bots.find((b) => b.primary)!;
  expect((await fetch(`${app(bob)}/api/bots/conversations/${bobChat}`, json({ botIds: [bobsBot.id] }, "PATCH"))).status).toBe(200);
  await until(async () => (await sharedChat(alice))?.friend.members.some((m: any) => m.id === bobsBot.id), "Alice sees Bob's bot");

  const hello = await post(alice, aliceChat, "Hello from Alice");
  const got = await until(async () => (await messages(bob, bobChat)).find((m) => m.id === hello), "Bob gets Alice's message");
  expect(got).toMatchObject({ author: `friend:${keyOf(alice).id}:owner`, text: "Hello from Alice", from: { owner: true, name: "Alice", friendName: "Alice" } });
  const reply = await post(bob, bobChat, "Hi Alice, Bob here");
  const back = await until(async () => (await messages(alice, aliceChat)).find((m) => m.id === reply), "Alice gets Bob's reply");
  expect(back).toMatchObject({ author: `friend:${keyOf(bob).id}:owner`, from: { owner: true, friendName: "Bob" } });
  // The friends list on each side shows who's connected, as the app and the CLI see it.
  const listed = (await (await fetch(`${app(bob)}/api/friends`)).json()) as { friends: { name: string; status: string }[] };
  expect(listed.friends).toMatchObject([{ name: "Alice", status: "online" }]);
  expect(cli(bob, "list")).toMatch(/Alice {2}connected\n.*you connect to them over LAN/);
  expect(cli(alice, "chats")).toMatch(/Weekend plans {2}with Bob\n.*yours: Dr Eggbot · theirs: Dr Eggbot/);
}, 60_000);

/** Speak the protocol by hand, as `key`: the handshake, then frames. */
async function connectAs(key: KeyPair, opts: { badNonce?: boolean } = {}) {
  const host = keyOf(alice);
  const ws = new WebSocket(`ws://127.0.0.1:${alice.friendPort}/friend/v1/connect?from=${key.id}`);
  const inbox: string[] = [];
  const waiting: ((t: string) => void)[] = [];
  let closed: { code: number } | undefined;
  ws.onmessage = (e) => (waiting.length ? waiting.shift()!(String(e.data)) : inbox.push(String(e.data)));
  const done = new Promise<{ code: number }>((r) => (ws.onclose = (e) => r((closed = { code: e.code }))));
  const next = (ms = 5000) => (inbox.length ? Promise.resolve(inbox.shift()!) : Promise.race([new Promise<string>((r) => waiting.push(r)), Bun.sleep(ms).then(() => { throw new Error("no frame"); })]));
  const challenge = unseal(await next(), host.publicKey)!;
  expect(challenge).toMatchObject({ t: "challenge", from: host.id, to: key.id });
  const sid = nonce();
  ws.send(seal({ t: "auth", from: key.id, to: host.id, nonce: opts.badNonce ? "not-it" : challenge.nonce, sid }, key));
  return { ws, sid, host, next, done, closed: () => closed };
}

test("frames that aren't signed by the friend, or that were already applied, are refused", async () => {
  await stop(bob);
  await until(async () => (await friendsOf(alice))[0]?.status === "offline", "Alice sees Bob go");
  // With his server stopped, Bob's list still reads from disk.
  expect(cli(bob, "list")).toMatch(/Alice {2}not connected[\s\S]*OpenBuild isn't running/);
  const bobKey = keyOf(bob);
  const before = (await messages(alice, aliceChat)).length;
  const frame = (seq: number, text: string) => ({ t: "msg", from: bobKey.id, to: keyOf(alice).id, seq, kind: "chat.message", body: { chat: aliceChat, message: { id: crypto.randomUUID(), member: "owner", text } } });

  // A replay of an old sequence number: acknowledged as already had, not applied again.
  const replay = await connectAs(bobKey);
  expect(unseal(await replay.next(), replay.host.publicKey)).toMatchObject({ t: "ready", sid: replay.sid });
  replay.ws.send(seal(frame(1, "replayed"), bobKey));
  const ack = unseal(await replay.next(), replay.host.publicKey)!;
  expect(ack.t).toBe("ack");
  expect(ack.seq as number).toBeGreaterThanOrEqual(2);
  // Tampered after signing: the connection is closed.
  const sealed = JSON.parse(seal(frame(1_000_000, "tampered"), bobKey));
  replay.ws.send(JSON.stringify({ ...sealed, p: sealed.p.replace("tampered", "TAMPERED") }));
  expect((await replay.done).code).toBe(4002);

  // Signed by someone else claiming to be Bob.
  const forged = await connectAs(bobKey);
  await forged.next();
  forged.ws.send(seal(frame(1_000_001, "forged"), loadKeyPair(newKeyPair())));
  expect((await forged.done).code).toBe(4002);
  // A handshake that doesn't answer this connection's challenge.
  const stale = await connectAs(bobKey, { badNonce: true });
  expect((await stale.done).code).toBe(4001);
  // A frame addressed to someone else, from a real connection.
  const misdirected = await connectAs(bobKey);
  await misdirected.next();
  misdirected.ws.send(seal({ ...frame(1_000_002, "misdirected"), to: bobKey.id }, bobKey));
  expect((await misdirected.done).code).toBe(4002);

  const after = await messages(alice, aliceChat);
  expect(after.length).toBe(before);
  expect(after.some((m) => ["replayed", "tampered", "TAMPERED", "forged", "misdirected"].includes(m.text))).toBe(false);
}, 60_000);

test("messages wait for a friend who's away and arrive once each, in order, after either side restarts", async () => {
  // Bob is still stopped: Alice's messages wait in her outbox.
  const sent: string[] = [];
  for (const text of ["one", "two", "three"]) sent.push(await post(alice, aliceChat, text));
  await launch(bob);
  await until(async () => {
    const list = await messages(bob, bobChat);
    return sent.every((id) => list.some((m) => m.id === id));
  }, "Bob gets what waited");
  const order = (await messages(bob, bobChat)).filter((m) => sent.includes(m.id)).map((m) => m.text);
  expect(order).toEqual(["one", "two", "three"]);

  // Now Alice is away while Bob writes.
  await stop(alice);
  const replies: string[] = [];
  for (const text of ["four", "five"]) replies.push(await post(bob, bobChat, text));
  await launch(alice);
  await until(async () => {
    const list = await messages(alice, aliceChat);
    return replies.every((id) => list.some((m) => m.id === id));
  }, "Alice gets what waited", 45_000);
  await until(async () => (await friendsOf(alice))[0]?.status === "online" && (await friendsOf(bob))[0]?.status === "online", "reconnected");

  // Reconnecting again resends nothing that already arrived.
  await stop(bob);
  await launch(bob);
  await until(async () => (await friendsOf(bob))[0]?.status === "online", "Bob back");
  await Bun.sleep(1000);
  const [bobs, alices] = [await messages(bob, bobChat), await messages(alice, aliceChat)];
  for (const id of sent) expect(bobs.filter((m) => m.id === id).length).toBe(1);
  for (const id of replies) expect(alices.filter((m) => m.id === id).length).toBe(1);
  expect(alices.filter((m) => m.id === replies[0]).map((m) => m.text)).toEqual(["four"]);
}, 120_000);

test("removing a friend revokes them at once: the connection closes, and their key is refused after", async () => {
  expect(await control(alice, "remove", { friend: "Bob" })).toEqual({ removed: "Bob" });
  expect(await friendsOf(alice)).toEqual([]);
  // Bob's side hears it on the open connection, and stops too.
  await until(async () => (await friendsOf(bob)).length === 0, "Bob hears he was removed");
  const bobs = await sharedChat(bob);
  expect(bobs.friend.ended).toBe("removed");
  expect((await messages(bob, bobChat)).some((m) => m.event?.text === "Alice removed you as a friend")).toBe(true);
  expect((await sharedChat(alice)).friend.ended).toBe("removed");

  // With nobody to serve, the friend port is closed; listening again (a new invite), Bob's key is a stranger's.
  await until(async () => !(await fetch(`${friendBase()}/friend/v1/connect`).then(() => true, () => false)), "friend port closes");
  await control(alice, "invite", { mode: "lan", address: `127.0.0.1:${alice.friendPort}` });
  expect((await fetch(`${friendBase()}/friend/v1/connect?from=${keyOf(bob).id}`)).status).toBe(403);
  const ws = new WebSocket(`ws://127.0.0.1:${alice.friendPort}/friend/v1/connect?from=${keyOf(bob).id}`);
  const outcome = await new Promise<string>((r) => ((ws.onopen = () => r("open")), (ws.onclose = () => r("closed"))));
  expect(outcome).toBe("closed");
  await control(alice, "cancel");

  // What either side writes in the old chat now stays where it's written.
  const local = await post(bob, bobChat, "anyone still there?");
  await Bun.sleep(500);
  expect((await messages(alice, aliceChat)).some((m) => m.id === local)).toBe(false);
}, 60_000);
