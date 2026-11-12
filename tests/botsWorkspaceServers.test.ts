import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serverLog } from "./serverLog";
import { spawnScriptSync } from "./spawnScript";

// A tab on one device using another's OpenBots workspace, end to end over loopback: two real
// OpenBuild servers on throwaway data directories, "Host Box" (whose workspace it is) and "Viewer
// Box" (the server the tab is open on, holding the pairing). This process plays the tab on the
// viewer and the host's own session. No real pairing, server or data is touched.
const directory = mkdtempSync(join(tmpdir(), "openbuild-bots-workspace-"));
const data = (name: string) => {
  const dir = join(directory, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "device-name"), `${name[0]!.toUpperCase()}${name.slice(1)} Box\n`);
  return dir;
};
const hostData = data("host");
const viewerData = data("viewer");
const otherData = data("other");

const children = new Map<number, ReturnType<typeof Bun.spawn>>();
let hostPort = 0;
let viewerPort = 0;
let hostId = "";
let token = "";
let clientId = "";
let conversation = "";
const hostBase = () => `http://127.0.0.1:${hostPort}`;
const viewerBase = () => `http://127.0.0.1:${viewerPort}`;

async function until(check: () => Promise<boolean>, label: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

const freePort = () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
};

async function launch(port: number, dir: string) {
  const child = Bun.spawn([process.execPath, resolve("server/index.ts")], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOST: "127.0.0.1", OPENCHAT_DATA_DIR: dir, OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(dir, "secrets.json"), PI_CODING_AGENT_DIR: join(dir, "pi"), CI: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.set(port, child);
  // The server's own output, scrubbed and bounded, is all a failed start has to go on.
  const log = serverLog();
  void log.drain(child.stdout, "out");
  void log.drain(child.stderr, "err");
  const started = Date.now();
  try {
    await until(async () => {
      if (child.exitCode !== null) throw new StartExit(child.exitCode);
      return (await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok;
    }, "server start");
  } catch (err) {
    // Not a root cause: what was observed when the wait ended, and the server's last output.
    const exited = child.exitCode === null ? "still running, not answering" : `exited with code ${child.exitCode}`;
    throw new Error(`Server on port ${port} failed to start after ${Date.now() - started} ms (${exited}); ${err instanceof Error ? err.message : String(err)}\nLast server output:\n${log.tail()}`);
  }
}

class StartExit extends Error {
  constructor(code: number | null) {
    super(`A server exited (code ${code})`);
  }
}

async function stop(port: number) {
  const child = children.get(port);
  child?.kill();
  await child?.exited;
  children.delete(port);
}

/** Pair the viewer with the host the way Settings → Devices does: the host's code, claimed, kept in the viewer's devices.json. */
async function pair() {
  const open = spawnScriptSync(`const d = await import(${JSON.stringify(resolve("server/devices.ts"))}); console.log(JSON.stringify(d.createPairing({ name: "Host Box", mode: "lan", urls: [] })));`, { OPENCHAT_DATA_DIR: hostData });
  if (open.code !== 0) throw new Error(open.stderr);
  const { code } = JSON.parse(open.stdout);
  const claimed = (await (await fetch(`${hostBase()}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Viewer Box" }) })).json()) as { token: string; device: any };
  token = claimed.token;
  hostId = claimed.device.id;
  writeFileSync(join(viewerData, "devices.json"), JSON.stringify([{ ...claimed.device, urls: [hostBase()], token }]));
  const clients = ((await (await fetch(`${hostBase()}/api/paired-clients`)).json()) as { clients: { id: string; name: string }[] }).clients;
  clientId = clients.find((c) => c.name === "Viewer Box")!.id;
}

/** The host's own session, in Settings → Devices → Using this device. */
async function allowWorkspace(workspace: boolean) {
  const res = await fetch(`${hostBase()}/api/paired-clients/${clientId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace }) });
  expect(res.status).toBe(200);
}

/** What the tab on the viewer asks for. */
const via = (path: string, init?: RequestInit) => fetch(`${viewerBase()}/api/workspace/via/${hostId}${path}`, init);
const json = (body: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const hostSnapshot = async (base = hostBase()) => (await (await fetch(`${base}/api/bots`)).json()) as { conversations: { id: string; messages: { id: string; text: string }[] }[]; bots: { id: string; name: string }[] };
const hostMessages = async (base = hostBase()) => (await hostSnapshot(base)).conversations.flatMap((c) => c.messages);

/** Read an NDJSON stream line by line. `next` resolves undefined when the stream ends. */
function lines(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return {
    async next(ms = 10_000): Promise<any | undefined> {
      const deadline = Date.now() + ms;
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) return JSON.parse(line);
          continue;
        }
        const left = deadline - Date.now();
        if (left <= 0) throw new Error("No line in time");
        const read = await Promise.race([reader.read().catch(() => ({ done: true, value: undefined })), Bun.sleep(left).then(() => "late" as const)]);
        if (read === "late") throw new Error("No line in time");
        if (read.done) return undefined;
        buf += dec.decode(read.value, { stream: true });
      }
    },
    /** Every line until the stream ends, which must happen in time. */
    async ended(ms = 10_000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const line = await this.next(Math.max(1, deadline - Date.now()));
        if (line === undefined) return true;
      }
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}

const myMessage = (text: string) => ({ id: crypto.randomUUID(), author: "me", text });

beforeAll(async () => {
  hostPort = freePort();
  viewerPort = freePort();
  await launch(hostPort, hostData);
  await pair();
  await launch(viewerPort, viewerData);
  conversation = (await hostSnapshot()).conversations[0]!.id;
}, 90_000);

afterAll(async () => {
  for (const port of [...children.keys()]) await stop(port);
  rmSync(directory, { recursive: true, force: true });
});

test("pairing alone doesn't open the host's workspace", async () => {
  const res = await via("/api/bots");
  expect(res.status).toBe(403);
  expect(res.headers.get("x-openbuild-server")).toBe(hostId);
  expect(((await res.json()) as any).reason).toBe("denied");
  expect((await via("/api/bots/stream")).status).toBe(403);
  const post = await via(`/api/bots/conversations/${conversation}/messages`, { method: "POST", ...json(myMessage("before the grant")) });
  expect(post.status).toBe(403);
  expect((await hostMessages()).some((m) => m.text === "before the grant")).toBe(false);
}, 30_000);

test("with the grant, the stream comes through the viewer, opening with a hello naming the host", async () => {
  await allowWorkspace(true);
  const res = await via("/api/bots/stream");
  expect(res.status).toBe(200);
  expect(res.headers.get("x-openbuild-server")).toBe(hostId);
  const stream = lines(res);
  expect(await stream.next()).toEqual({ t: "hello", workspace: hostId });
  const snap = await stream.next();
  expect(snap.t).toBe("snapshot");
  expect(snap.conversations.map((c: any) => c.id)).toContain(conversation);
  // A message sent from the tab lands on the host, and comes back on the stream.
  const message = myMessage("hello from the viewer");
  const post = await via(`/api/bots/conversations/${conversation}/messages`, { method: "POST", ...json(message) });
  expect(post.status).toBe(200);
  expect(post.headers.get("x-openbuild-server")).toBe(hostId);
  for (;;) {
    const e = await stream.next();
    if (e?.t === "message" && e.message.id === message.id) break;
  }
  expect((await hostMessages()).some((m) => m.id === message.id)).toBe(true);
  await stream.cancel();
}, 30_000);

/** Send `bytes` to a file route in pieces of `piece` bytes, as the browser does. */
async function upload(put: (query: string, body: BodyInit) => Promise<Response>, name: string, bytes: Uint8Array, piece: number) {
  let last: any;
  for (let offset = 0; offset < bytes.length || !last; offset += piece) {
    const q = new URLSearchParams({ name, type: "video/x-matroska", offset: String(offset), total: String(bytes.length) });
    const res = await put(q.toString(), raw(bytes.subarray(offset, offset + piece)));
    last = await res.json();
    expect({ status: res.status, error: last.error }).toEqual({ status: 200, error: undefined });
  }
  return last as { id: string; name: string; mime: string; size: number; path: string; done: boolean };
}
const raw = (bytes: Uint8Array) => bytes as unknown as BodyInit;
const octets = { "content-type": "application/octet-stream" };
const clip = () => crypto.getRandomValues(new Uint8Array(50_000));

test("a file attached for bots goes up in pieces through the viewer, into each bot's home, and comes back by range", async () => {
  const bytes = clip();
  const id = crypto.randomUUID();
  const at = `/api/bots/conversations/${conversation}/files/${id}`;
  const saved = await upload((q, body) => via(`${at}?${q}`, { method: "PUT", headers: octets, body }), "../clip one.mkv", bytes, 20_000);
  // The name is one path segment, whatever the tab called it.
  expect(saved).toMatchObject({ id, name: "clip one.mkv", mime: "video/x-matroska", size: bytes.length, done: true });
  expect(saved.path.startsWith(join(hostData, "attachments", id))).toBe(true);
  // A piece sent again (its answer was lost) lands where it did the first time.
  const again = await via(`${at}?${new URLSearchParams({ name: "clip one.mkv", offset: "40000", total: String(bytes.length) })}`, { method: "PUT", headers: octets, body: raw(bytes.subarray(40_000)) });
  expect(((await again.json()) as any).size).toBe(bytes.length);
  expect(new Uint8Array(readFileSync(saved.path))).toEqual(bytes);

  // The message names the file as the host's store has it, not as the tab claims.
  const message = { ...myMessage("watch this"), files: [{ id, name: "lies.txt", mime: "text/plain", size: 1 }] };
  expect((await via(`/api/bots/conversations/${conversation}/messages`, { method: "POST", ...json(message) })).status).toBe(200);
  const snap = (await (await fetch(`${hostBase()}/api/bots`)).json()) as { conversations: { id: string; botIds: string[]; messages: any[] }[] };
  const chat = snap.conversations.find((c) => c.id === conversation)!;
  expect(chat.messages.find((m) => m.id === message.id).files).toEqual([{ id, name: "clip one.mkv", mime: "video/x-matroska", size: bytes.length }]);
  // Every bot there has its own copy, in its home folder.
  expect(chat.botIds.length).toBeGreaterThan(0);
  for (const bot of chat.botIds) expect(new Uint8Array(readFileSync(join(hostData, "computers", bot, "home", "Attachments", id.slice(0, 8), "clip one.mkv")))).toEqual(bytes);

  // Back through the viewer: whole, and the part a player seeks to.
  const whole = await via(at);
  expect(whole.status).toBe(200);
  expect(whole.headers.get("content-type")).toBe("video/x-matroska");
  expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes);
  const part = await via(at, { headers: { range: "bytes=100-199" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe(`bytes 100-199/${bytes.length}`);
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(100, 200));

  // A file that never finished can't be attached, and one for a chat that doesn't exist isn't kept.
  const half = crypto.randomUUID();
  await via(`/api/bots/conversations/${conversation}/files/${half}?${new URLSearchParams({ name: "half.zip", offset: "0", total: "10" })}`, { method: "PUT", headers: octets, body: raw(new Uint8Array(4)) });
  expect((await via(`/api/bots/conversations/${conversation}/messages`, { method: "POST", ...json({ ...myMessage("half"), files: [{ id: half }] }) })).status).toBe(400);
  expect((await via(`/api/bots/conversations/nope/files/${crypto.randomUUID()}?name=x&offset=0&total=1`, { method: "PUT", headers: octets, body: raw(new Uint8Array(1)) })).status).toBe(404);
}, 30_000);

test("a file for a thread on a paired device goes up through the proxy, and one on the wrong machine is copied across", async () => {
  const device = (path: string, init?: RequestInit) => fetch(`${viewerBase()}/api/devices/${hostId}${path}`, init);
  const bytes = clip();
  const id = crypto.randomUUID();
  const saved = await upload((q, body) => device(`/api/attachments/${id}?${q}`, { method: "PUT", headers: octets, body }), "song.mp3", bytes, 30_000);
  expect(saved).toMatchObject({ name: "song.mp3", size: bytes.length, done: true });
  expect(saved.path).toBe(join(hostData, "attachments", id, "song.mp3"));
  expect(new Uint8Array(readFileSync(saved.path))).toEqual(bytes);
  const part = await device(`/api/attachments/${id}`, { headers: { range: "bytes=-10" } });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-length")).toBe("10");
  expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.subarray(bytes.length - 10));

  // Uploaded to this server, then the thread turned out to start on the device (and back again).
  const here = crypto.randomUUID();
  const local = await upload((q, body) => fetch(`${viewerBase()}/api/attachments/${here}?${q}`, { method: "PUT", headers: octets, body }), "notes.zip", bytes, 50_000);
  expect(local.path).toBe(join(viewerData, "attachments", here, "notes.zip"));
  const over = await fetch(`${viewerBase()}/api/attachments/${here}/copy`, { method: "POST", ...json({ to: hostId }) });
  expect(over.status).toBe(200);
  expect(((await over.json()) as any).path).toBe(join(hostData, "attachments", here, "notes.zip"));
  expect(new Uint8Array(readFileSync(join(hostData, "attachments", here, "notes.zip")))).toEqual(bytes);
  const back = await fetch(`${viewerBase()}/api/attachments/${id}/copy`, { method: "POST", ...json({ from: hostId }) });
  expect(back.status).toBe(200);
  expect(new Uint8Array(readFileSync(join(viewerData, "attachments", id, "song.mp3")))).toEqual(bytes);

  // The device can't have this server copy files around for it, and a piece has to fit its file.
  expect((await device(`/api/attachments/${here}/copy`, { method: "POST", ...json({}) })).status).toBe(403);
  expect((await fetch(`${viewerBase()}/api/attachments/${crypto.randomUUID()}?name=x&offset=5&total=3`, { method: "PUT", headers: octets, body: raw(new Uint8Array(2)) })).status).toBe(400);
  expect((await fetch(`${viewerBase()}/api/attachments/..%2Fescape?name=x&offset=0&total=1`, { method: "PUT", headers: octets, body: raw(new Uint8Array(1)) })).status).toBe(400);
}, 30_000);

test("only the listed operations run; everything else refuses the device and changes nothing", async () => {
  const before = await hostSnapshot();
  const message = myMessage("for reactions");
  expect((await via(`/api/bots/conversations/${conversation}/messages`, { method: "POST", ...json(message) })).status).toBe(200);
  const allowed: [string, string, unknown?][] = [
    ["GET", "/api/bots"],
    ["GET", `/api/bots/conversations/${conversation}/messages?beforeId=${message.id}`],
    ["PATCH", `/api/bots/conversations/${conversation}/messages/${message.id}`, { emoji: "👍" }],
    ["POST", `/api/bots/conversations/${conversation}/read`],
    ["DELETE", `/api/bots/conversations/${conversation}/messages/${message.id}`],
  ];
  for (const [method, path, body] of allowed) {
    const res = await via(path, { method, ...(body ? json(body) : {}) });
    expect({ method, path, status: res.status }).toEqual({ method, path, status: 200 });
  }
  const refused: [string, string, unknown?][] = [
    ["POST", "/api/bots", { name: "Sneaky" }],
    ["PATCH", "/api/bots/settings", { defaultModel: "x/y" }],
    ["POST", "/api/bots/reset"],
    ["GET", "/api/bots/apps"],
    ["GET", "/api/bots/apps/github/logo"],
    ["POST", "/api/bots/apps/github/connect", {}],
    ["GET", "/api/bots/targets"],
    ["GET", "/api/bots/models"],
    ["POST", "/api/bots/conversations", { kind: "group", name: "G", botIds: [] }],
    ["PATCH", `/api/bots/conversations/${conversation}`, { name: "Renamed" }],
    ["DELETE", `/api/bots/conversations/${conversation}`],
    ["PATCH", `/api/bots/${before.bots[0]!.id}`, { name: "Renamed" }],
    ["DELETE", `/api/bots/${before.bots[0]!.id}`],
  ];
  for (const [method, path, body] of refused) {
    const init = { method, ...(body ? json(body) : {}) };
    // Through the viewer, straight at the host's bound route with the device's token, and at the plain route.
    const viaViewer = await via(path, init);
    const direct = await fetch(`${hostBase()}/api/workspace/to/${hostId}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
    const plain = await fetch(`${hostBase()}${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
    expect({ path, method, statuses: [viaViewer.status, direct.status, plain.status] }).toEqual({ path, method, statuses: [403, 403, 403] });
    expect(direct.headers.get("x-openbuild-server")).toBe(hostId);
  }
  const after = await hostSnapshot();
  expect(after.bots).toEqual(before.bots);
  expect(after.conversations.map((c) => c.id)).toEqual(before.conversations.map((c) => c.id));
}, 60_000);

test("a request for another server id is refused with 409 before its body is read", async () => {
  const res = await fetch(`${hostBase()}/api/workspace/to/${crypto.randomUUID()}/api/bots/conversations/${conversation}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    // A body that never finishes: the answer can't have waited for it.
    body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }),
    // Its connection is left mid-body, so it mustn't go back to the pool: the next request on it
    // would be read as the rest of this body and fail to parse (Bun 1.3 reuses it otherwise).
    keepalive: false,
  } as RequestInit);
  expect(res.status).toBe(409);
  expect(res.headers.get("x-openbuild-server")).toBe(hostId);
}, 15_000);

/**
 * A request over a raw socket whose body arrives in two parts, with `meanwhile` run between them.
 * A fetch body stream isn't held back the same way by every Bun, so the bytes are sent by hand.
 */
async function slowRequest(method: string, path: string, body: string, meanwhile: () => Promise<void>, headers: Record<string, string> = { authorization: `Bearer ${token}` }) {
  const bytes = new TextEncoder().encode(body);
  let answer = "";
  let done!: () => void;
  const ended = new Promise<void>((r) => (done = r));
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: hostPort,
    socket: {
      data(_, chunk) {
        answer += new TextDecoder().decode(chunk);
        if (/\r\n\r\n/.test(answer)) done();
      },
      close() {
        done();
      },
    },
  });
  const head = [`${method} ${path} HTTP/1.1`, `host: 127.0.0.1:${hostPort}`, "content-type: application/json", `content-length: ${bytes.length}`, "connection: close", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
  socket.write(head);
  socket.write(bytes.slice(0, 5));
  await Bun.sleep(300);
  await meanwhile();
  socket.write(bytes.slice(5));
  await ended;
  socket.end();
  return Number(/^HTTP\/1\.1 (\d+)/.exec(answer)?.[1]);
}

/** A device's write whose body arrives only after `meanwhile` ran. */
async function slowPost(text: string, meanwhile: () => Promise<void>) {
  const message = myMessage(text);
  const status = await slowRequest("POST", `/api/workspace/to/${hostId}/api/bots/conversations/${conversation}/messages`, JSON.stringify(message), meanwhile);
  return { status, message };
}

test("a grant taken back while a write's body was on its way fails it closed", async () => {
  const { status, message } = await slowPost("sent as the grant went", () => allowWorkspace(false));
  expect(status).toBe(403);
  expect((await hostMessages()).some((m) => m.id === message.id)).toBe(false);
  await allowWorkspace(true);
}, 20_000);

test("taking the grant back closes that device's open streams", async () => {
  const stream = lines(await via("/api/bots/stream"));
  expect((await stream.next()).t).toBe("hello");
  await allowWorkspace(false);
  expect(await stream.ended()).toBe(true);
  // And it can't open another.
  expect((await via("/api/bots/stream")).status).toBe(403);
  await allowWorkspace(true);
}, 20_000);

test("an address now held by another OpenBuild runs nothing, and an offline host is unreachable", async () => {
  await stop(hostPort);
  const offline = await via("/api/bots");
  expect(offline.status).toBe(502);
  expect(((await offline.json()) as any).reason).toBe("offline");

  // Something at the address that redirects: never followed.
  let followed = 0;
  const elsewhere = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (followed++, new Response("{}")) });
  const redirecting = Bun.serve({ port: hostPort, hostname: "127.0.0.1", fetch: (req) => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${elsewhere.port}${new URL(req.url).pathname}`, "x-openbuild-server": hostId } }) });
  const redirected = await via(`/api/bots/conversations/${conversation}/messages`, { method: "POST", ...json(myMessage("redirected")) });
  expect(redirected.status).toBe(502);
  expect(followed).toBe(0);
  redirecting.stop(true);
  elsewhere.stop(true);

  // Another OpenBuild on the host's address.
  await launch(hostPort, otherData);
  const other = await hostSnapshot();
  const otherConversation = other.conversations[0]!.id;
  const message = myMessage("meant for the host");
  for (const id of [conversation, otherConversation]) {
    const res = await via(`/api/bots/conversations/${id}/messages`, { method: "POST", ...json({ ...message, id: crypto.randomUUID() }) });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).reason).toBe("mismatch");
  }
  const snap = await via("/api/bots");
  expect(snap.status).toBe(502);

  // The host's own tab, still open at that address, managing its bots: every write names the host,
  // so the server there now runs none of them, and nothing about it changes.
  const settingsBefore = await (await fetch(`${hostBase()}/api/bots`)).json() as any;
  const managing: [string, string, unknown?][] = [
    ["POST", "/api/bots", { name: "Made on the wrong server" }],
    ["PATCH", "/api/bots/settings", { defaultModel: "wrong/server", user: { name: "Not me" } }],
    ["PATCH", `/api/bots/${other.bots[0]!.id}`, { name: "Renamed on the wrong server" }],
    ["POST", "/api/bots/reset"],
    ["POST", `/api/bots/conversations/${otherConversation}/read`],
  ];
  for (const [method, path, body] of managing) {
    const res = await fetch(`${hostBase()}/api/workspace/to/${hostId}${path}`, { method, ...(body ? json(body) : {}) });
    expect({ path, status: res.status }).toEqual({ path, status: 409 });
    expect(res.headers.get("x-openbuild-server")).not.toBe(hostId);
  }
  const settingsAfter = await (await fetch(`${hostBase()}/api/bots`)).json() as any;
  expect(settingsAfter.bots).toEqual(settingsBefore.bots);
  expect(settingsAfter.settings).toEqual(settingsBefore.settings);
  expect(settingsAfter.conversations.map((c: any) => c.id)).toEqual(settingsBefore.conversations.map((c: any) => c.id));
  expect((await hostMessages()).some((m) => m.text === "meant for the host")).toBe(false);
  await stop(hostPort);
  await launch(hostPort, hostData);
  expect((await via("/api/bots")).status).toBe(200);
}, 90_000);

test("this server's own session manages its bots on the bound route; a device never can", async () => {
  const own = await fetch(`${hostBase()}/api/workspace/to/${hostId}/api/bots/settings`, { method: "PATCH", ...json({ defaultModel: "owner/choice" }) });
  expect(own.status).toBe(200);
  expect(own.headers.get("x-openbuild-server")).toBe(hostId);
  expect(((await hostSnapshot()) as any).settings.defaultModel).toBe("owner/choice");
  const device = await fetch(`${hostBase()}/api/workspace/to/${hostId}/api/bots/settings`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ defaultModel: "device/choice" }) });
  expect(device.status).toBe(403);
  expect(((await hostSnapshot()) as any).settings.defaultModel).toBe("owner/choice");
}, 20_000);

test("a reaction sent again while its first try is still on its way ends as asked, once", async () => {
  const message = myMessage("react to me");
  expect((await via(`/api/bots/conversations/${conversation}/messages`, { method: "POST", ...json(message) })).status).toBe(200);
  const path = `/api/workspace/to/${hostId}/api/bots/conversations/${conversation}/messages/${message.id}`;
  // The first try's body is held up on the way; the tab, hearing nothing, sends it again, and then
  // the first try lands after all.
  const first = await slowRequest("PATCH", path, JSON.stringify({ emoji: "🎉", on: true }), async () => {
    const retried = await via(`/api/bots/conversations/${conversation}/messages/${message.id}`, { method: "PATCH", ...json({ emoji: "🎉", on: true }) });
    expect(retried.status).toBe(200);
  });
  expect(first).toBe(200);
  const reactions = (await hostMessages()).find((m) => m.id === message.id) as any;
  expect(reactions.reactions.filter((r: any) => r.by === "me" && r.emoji === "🎉")).toHaveLength(1);
  // And taking it back the same way is a set too.
  for (let i = 0; i < 2; i++) expect((await via(`/api/bots/conversations/${conversation}/messages/${message.id}`, { method: "PATCH", ...json({ emoji: "🎉", on: false }) })).status).toBe(200);
  expect(((await hostMessages()).find((m) => m.id === message.id) as any).reactions ?? []).toEqual([]);
}, 20_000);

test("forgetting the pairing closes the device's streams and fails a write in flight", async () => {
  const stream = lines(await via("/api/bots/stream"));
  expect((await stream.next()).t).toBe("hello");
  const { status, message } = await slowPost("sent as the pairing went", async () => {
    expect((await fetch(`${hostBase()}/api/paired-clients/${clientId}`, { method: "DELETE" })).status).toBe(200);
  });
  expect(status).toBe(401);
  expect(await stream.ended()).toBe(true);
  expect((await hostMessages()).some((m) => m.id === message.id)).toBe(false);
  const after = await via("/api/bots");
  expect(after.status).toBe(401);
}, 30_000);
