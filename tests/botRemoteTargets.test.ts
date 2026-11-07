import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// A bot whose computer is on another machine, end to end over loopback: a real OpenBuild server on
// a throwaway data directory plays the paired machine ("Target Box"), and this process is the
// workspace server where the bot lives. The bot's tool calls go through the same agent socket its
// Pi would use, then over HTTP to the target. No real pairing, server or container is touched.
const directory = mkdtempSync(join(tmpdir(), "openbuild-bot-targets-"));
const targetData = join(directory, "target");
const workspaceData = join(directory, "workspace");
mkdirSync(targetData, { recursive: true });
mkdirSync(workspaceData, { recursive: true });
writeFileSync(join(targetData, "device-name"), "Target Box\n");
Object.assign(process.env, {
  OPENCHAT_DATA_DIR: workspaceData,
  OPENCHAT_SECRETS: "file",
  OPENCHAT_SECRETS_FILE: join(workspaceData, "secrets.json"),
  PI_CODING_AGENT_DIR: join(workspaceData, "pi"),
});

const devices = await import("../server/devices");
const svc = await import("../server/bots/service");
const agent = await import("../server/bots/agent");
const { computerTargets, guestComputerId } = await import("../server/computers/api");

let port = 0;
let server: ReturnType<typeof Bun.spawn> | undefined;
let target = "";
let token = "";
let clientId = "";
const base = () => `http://127.0.0.1:${port}`;

async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function launchTarget() {
  const child = Bun.spawn([process.execPath, resolve("server/index.ts")], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), HOST: "127.0.0.1", OPENCHAT_DATA_DIR: targetData, OPENCHAT_SECRETS_FILE: join(targetData, "secrets.json"), PI_CODING_AGENT_DIR: join(targetData, "pi"), CI: "1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  server = child;
  await until(async () => {
    if (child.exitCode !== null) throw new Error("The target server exited");
    return (await fetch(`${base()}/api/auth/status`)).ok;
  }, "target server");
}

async function stopTarget() {
  server?.kill();
  await server?.exited;
  server = undefined;
}

/** What the target's own session (Settings → Devices → Using this device) allows the workspace's bots. */
async function grant(botTools: Record<string, boolean>) {
  const res = await fetch(`${base()}/api/paired-clients/${clientId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ botTools }) });
  expect(res.status).toBe(200);
}

/** A tool call the way the bot's Pi makes it: over the agent socket with the bot's token. */
async function tool(botId: string, method: string, params: Record<string, unknown>) {
  const res = await fetch("http://agent/", { unix: agent.agentSocketPath(), method: "POST", headers: { authorization: `Bearer ${agent.mintToken(botId)}` }, body: JSON.stringify({ method, params }) } as RequestInit);
  return (await res.json()) as { result?: any; error?: string };
}

const workspaceComputers = () => (existsSync(join(workspaceData, "computers")) ? readdirSync(join(workspaceData, "computers")) : []);
const targetComputers = () => (existsSync(join(targetData, "computers")) ? readdirSync(join(targetData, "computers")) : []);

let bot = "";

beforeAll(async () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  port = probe.port!;
  probe.stop(true);
  await launchTarget();
  // Open a pairing on the target the way `openbuild pair --host` does, and claim it from here.
  const open = Bun.spawnSync([process.execPath, "-e", `const d = await import(${JSON.stringify(resolve("server/devices.ts"))}); console.log(JSON.stringify(d.createPairing({ name: "Target Box", mode: "lan", urls: [] })));`], { env: { ...process.env, OPENCHAT_DATA_DIR: targetData }, stdout: "pipe", stderr: "pipe" });
  if (open.exitCode !== 0) throw new Error(open.stderr.toString());
  const { code } = JSON.parse(open.stdout.toString());
  const claimed = (await (await fetch(`${base()}/api/pair/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Workspace Box" }) })).json()) as { token: string; device: any };
  token = claimed.token;
  target = claimed.device.id;
  devices.addDevice({ ...claimed.device, urls: [base()], token });
  clientId = ((await (await fetch(`${base()}/api/paired-clients`)).json()) as { clients: { id: string }[] }).clients[0]!.id;
  agent.listen();
  bot = svc.createBot({ name: "Remote" }).bot.id;
}, 60_000);

afterAll(async () => {
  await stopTarget();
  rmSync(directory, { recursive: true, force: true });
});

test("pairing alone lets the workspace's bots do nothing on the target, and nothing runs here instead", async () => {
  svc.updateBot(bot, { computer: { device: target, kind: "container" } });
  const run = await tool(bot, "bash", { command: "echo hi" });
  expect(run.error).toContain("Target Box hasn't allowed bots from Workspace Box to use it");
  for (const [method, params] of [["read", { path: "x" }], ["browser", { action: "tabs" }], ["process", { action: "list" }]] as const) {
    expect((await tool(bot, method, params)).error).toContain("hasn't allowed bots from Workspace Box to use it");
  }
  // Nothing was made on either side, and the bot keeps its choice.
  expect(targetComputers()).toEqual([]);
  expect(workspaceComputers()).toEqual([]);
  expect(svc.fullBot(bot)!.computer).toEqual({ device: target, kind: "container" });
  const listed = (await computerTargets()).find((t) => t.device === target)!;
  expect(listed).toMatchObject({ name: "Target Box", status: "access", grants: { files: false, terminal: false, browser: false, unisolated: false } });
}, 30_000);

test("a paired device can't grant itself anything, and an unknown token is refused rather than taken for a browser", async () => {
  const self = await fetch(`${base()}/api/paired-clients/${clientId}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ botTools: { terminal: true } }) });
  expect(self.status).toBe(403);
  const stranger = await fetch(`${base()}/api/computers/capabilities`, { headers: { authorization: `Bearer ${"ab".repeat(32)}` } });
  expect(stranger.status).toBe(401);
  const caps = (await (await fetch(`${base()}/api/computers/capabilities`, { headers: { authorization: `Bearer ${token}` } })).json()) as any;
  expect(caps.grants.terminal).toBe(false);
});

test("each grant opens only its own tools, and unisolated access is a grant of its own", async () => {
  await grant({ terminal: true });
  svc.updateBot(bot, { computer: { device: target, kind: "host" } });
  expect((await tool(bot, "bash", { command: "pwd" })).error).toContain("only allows bots from Workspace Box a container");
  await grant({ unisolated: true });
  const run = await tool(bot, "bash", { command: "pwd" });
  expect(run.error).toBeUndefined();
  // It ran on the target, in the computer kept for this workspace's bot, and says where.
  const guest = guestComputerId(clientId, bot);
  expect(run.result.output.trim()).toBe(join(targetData, "computers", guest, "home"));
  expect(run.result.ranOn).toBe("Target Box");
  expect(targetComputers()).toEqual([guest]);
  expect(guest).not.toBe(bot);
  expect(workspaceComputers()).toEqual([]);

  const started = await tool(bot, "process", { action: "start", command: "true", name: "quick" });
  expect(started.result.ranOn).toBe("Target Box");
  expect(started.result.note).toContain("can't tell you when it exits");

  expect((await tool(bot, "write", { path: "note.txt", content: "remote" })).error).toContain("hasn't allowed files");
  expect((await tool(bot, "browser", { action: "quit" })).error).toContain("hasn't allowed the browser");
  await grant({ files: true, browser: true });
  expect((await tool(bot, "write", { path: "note.txt", content: "remote" })).result).toEqual({ ok: true, bytes: 6 });
  expect((await tool(bot, "read", { path: "note.txt" })).result).toBe("remote");
  expect(existsSync(join(targetData, "computers", guest, "home", "note.txt"))).toBe(true);
  expect((await tool(bot, "browser", { action: "quit" })).result).toEqual({ ok: true });

  // Taking a grant back takes effect on the next call.
  await grant({ terminal: false });
  expect((await tool(bot, "bash", { command: "pwd" })).error).toContain("hasn't allowed the terminal");
  await grant({ terminal: true });
  expect((await computerTargets()).find((t) => t.device === target)).toMatchObject({ status: "ready", grants: { files: true, terminal: true, browser: true, unisolated: true } });
}, 30_000);

test("a target that goes offline fails the tool without running it here, and works again once it's back", async () => {
  await stopTarget();
  const run = await tool(bot, "bash", { command: "pwd" });
  expect(run.error).toMatch(/Target Box (is unreachable|stopped answering)/);
  expect(workspaceComputers()).toEqual([]);
  // Whatever was remembered about the address has been dropped: the next attempt checks again.
  expect((await tool(bot, "bash", { command: "pwd" })).error).toContain("Target Box is unreachable");
  expect((await computerTargets()).find((t) => t.device === target)!.status).toBe("offline");
  expect(svc.fullBot(bot)!.computer).toEqual({ device: target, kind: "host" });

  await launchTarget();
  const back = await tool(bot, "bash", { command: "cat note.txt" });
  expect(back.error).toBeUndefined();
  expect(back.result.output).toBe("remote");
}, 60_000);

test("an address that answers as another machine, or as an OpenBuild without grants, gets nothing", async () => {
  let posts = 0;
  const impostor = (header?: string) =>
    Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (req.method === "POST") posts++;
        return Response.json({ engines: [], hostBrowser: false, image: "missing" }, { headers: header ? { "x-openbuild-server": header } : {} });
      },
    });
  for (const [header, expected] of [
    ["someone-else", "another OpenBuild answered there. Nothing ran."],
    [undefined, "needs a newer OpenBuild before bots can use it. Nothing ran."],
  ] as const) {
    const fake = impostor(header);
    const id = `fake-${header ?? "old"}`;
    devices.addDevice({ id, name: "Moved Box", mode: "lan", urls: [`http://127.0.0.1:${fake.port}`], token: "cd".repeat(32) });
    const other = svc.createBot({ name: `Elsewhere ${id}` }).bot.id;
    svc.updateBot(other, { computer: { device: id, kind: "host" } });
    expect((await tool(other, "bash", { command: "echo should-not-run" })).error).toContain(expected);
    fake.stop(true);
  }
  expect(posts).toBe(0);
  expect(workspaceComputers()).toEqual([]);
}, 30_000);

test("a device that isn't paired can't be chosen, and a revoked pairing says so", async () => {
  expect(() => svc.updateBot(bot, { computer: { device: "never-paired", kind: "container" } })).toThrow("isn't paired");
  expect(svc.fullBot(bot)!.computer).toEqual({ device: target, kind: "host" });

  const revoked = await fetch(`${base()}/api/paired-clients/${clientId}`, { method: "DELETE" });
  expect(revoked.ok).toBe(true);
  expect((await tool(bot, "bash", { command: "pwd" })).error).toContain("Target Box no longer trusts this pairing");
  expect((await computerTargets()).find((t) => t.device === target)!.status).toBe("revoked");

  devices.removeDevice(target);
  expect((await tool(bot, "bash", { command: "pwd" })).error).toContain("isn't paired anymore");
  expect(workspaceComputers()).toEqual([]);
}, 30_000);
