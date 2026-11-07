import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalAuth } from "../server/localAuth";

// A pairing has to survive however OpenBuild is started on either side. The "macbook" hosts over a
// fake tailnet (127.0.0.2, from a fake `tailscale` on PATH) with the real `openbuild start`; the
// "imac" is a server on 127.0.0.1 that paired with it from Settings → Devices. Then the CLI runs on
// the macbook the ways a person would, and the imac checks what it sees. Every file lives in a
// throwaway directory, and OPENBUILD_SYSTEMD=0 keeps the CLI away from any real service.
const linux = process.platform === "linux";
const root = resolve(import.meta.dir, "..");
const directory = mkdtempSync(join(tmpdir(), "openbuild-pair-start-"));
const mac = join(directory, "macbook");
const imac = join(directory, "imac");
const bin = join(directory, "bin");
const password = "pairing survives start fixture";
let macPort = 0;
let imacPort = 0;
let cookie = "";
let deviceId = "";
let imacServer: ReturnType<typeof Bun.spawn> | undefined;

const free = () => {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
};

const env = (data: string, port: number) => ({
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  OPENCHAT_DATA_DIR: data,
  OPENCHAT_SECRETS: "file",
  OPENCHAT_SECRETS_FILE: join(data, "secrets.json"),
  PI_CODING_AGENT_DIR: join(data, "pi"),
  OPENBUILD_SYSTEMD: "0",
  PORT: String(port),
  CI: "1",
});

/** `openbuild …` on the macbook, or on another fixture computer. */
const cli = (...args: string[]) => cliOn(mac, macPort, ...args);
function cliOn(data: string, port: number, ...args: string[]) {
  const run = Bun.spawnSync([process.execPath, join(root, "bin/openbuild.ts"), ...args], { cwd: root, env: env(data, port), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const out = run.stdout.toString() + run.stderr.toString();
  if (run.exitCode !== 0) throw new Error(`openbuild ${args.join(" ")} failed:\n${out}`);
  return out;
}

/** Run devices.ts in the macbook's (or another fixture's) data, in a subprocess so this process never holds its paths. */
const onMac = (code: string) => onData(mac, macPort, code);
function onData(data: string, port: number, code: string) {
  const script = `const d = await import(${JSON.stringify(join(root, "server/devices.ts"))}); console.log(JSON.stringify(await (async () => { ${code} })() ?? null));`;
  const run = Bun.spawnSync([process.execPath, "-e", script], { env: env(data, port), stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString());
}

const macMode = () => JSON.parse(readFileSync(join(mac, "server.json"), "utf8")).mode as string;
/** The remembered mode, removed to stand for a computer that updated from a version without it. */
const savedMode = (data = mac) => (existsSync(join(data, "network-mode")) ? readFileSync(join(data, "network-mode"), "utf8").trim() : undefined);
const forgetSavedMode = (data = mac) => rmSync(join(data, "network-mode"), { force: true });
async function until(check: () => Promise<boolean>, label: string) {
  for (const end = Date.now() + 20_000; Date.now() < end; await Bun.sleep(100)) if (await check()) return;
  throw new Error(`Timed out: ${label}`);
}
/** What the imac shows for the macbook in Settings → Devices. */
async function seen(): Promise<{ status: string; urls: string[] }> {
  const res = await fetch(`http://127.0.0.1:${imacPort}/api/devices`, { headers: { cookie } });
  const { devices } = (await res.json()) as { devices: { id: string; status: string; urls: string[] }[] };
  return devices.find((d) => d.id === deviceId)!;
}
/** Both sides' pairing records: the imac's saved addresses and token, the macbook's trusted token hashes. */
const records = () => ({
  imac: JSON.parse(readFileSync(join(imac, "devices.json"), "utf8")).map((d: any) => ({ id: d.id, urls: d.urls, token: d.token, serverId: d.serverId })),
  mac: JSON.parse(readFileSync(join(mac, "paired-clients.json"), "utf8")).map((c: any) => ({ id: c.id, tokenHash: c.tokenHash })),
});
let paired: ReturnType<typeof records>;

beforeAll(async () => {
  if (!linux) return;
  for (const dir of [mac, imac, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(directory, "tailscale.json"), JSON.stringify({ BackendState: "Running", Self: { DNSName: "macbook.tailnet.invalid.", TailscaleIPs: ["127.0.0.2"] }, Peer: {} }));
  writeFileSync(join(bin, "tailscale"), `#!/bin/sh\ncat "${join(directory, "tailscale.json")}"\n`);
  chmodSync(join(bin, "tailscale"), 0o755);
  macPort = free();
  imacPort = free();
  await createLocalAuth({ directory: imac }).setPassword(password);
  imacServer = Bun.spawn([process.execPath, join(root, "server/index.ts")], {
    cwd: root,
    env: { ...env(imac, imacPort), NODE_ENV: "production", HOST: "127.0.0.1", OPENCHAT_ALLOWED_HOSTS: "127.0.0.1" },
    stdout: "ignore",
    stderr: "ignore",
  });
  // The macbook shares itself on its tailnet and opens a pairing, as `openbuild pair --host` does.
  cli("start", "tailscale");
  const urls = JSON.parse(readFileSync(join(mac, "server.json"), "utf8")).urls;
  const { code } = onMac(`return d.createPairing({ name: "MacBook", mode: "tailscale", urls: ${JSON.stringify(urls)} })`);
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${imacPort}/api/auth/status`)).ok) break;
    } catch {}
    await Bun.sleep(50);
  }
  const login = await fetch(`http://127.0.0.1:${imacPort}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const pair = await fetch(`http://127.0.0.1:${imacPort}/api/pair/connect`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ mode: "tailscale", code, address: `127.0.0.2:${macPort}` }),
  });
  expect(pair.status).toBe(200);
  deviceId = ((await pair.json()) as { device: { id: string } }).device.id;
  paired = records();
}, 120_000);

afterAll(async () => {
  if (linux) {
    try {
      cli("stop");
    } catch {}
  }
  imacServer?.kill();
  await imacServer?.exited;
  rmSync(directory, { recursive: true, force: true });
});

test.skipIf(!linux)("pairing over the tailnet saves only the tailnet addresses", async () => {
  expect(paired.imac).toHaveLength(1);
  expect(paired.mac).toHaveLength(1);
  expect(paired.imac[0].urls).toEqual([`http://127.0.0.2:${macPort}`, `http://macbook.tailnet.invalid:${macPort}`]);
  expect((await seen()).status).toBe("online");
});

test.skipIf(!linux)("after an update, a running tailnet server is remembered, so a stop and a plain start keep it", async () => {
  // The macbook was started on its tailnet by a version that didn't remember the mode.
  forgetSavedMode();
  expect(cli("start")).toContain("already running (tailscale)");
  expect(savedMode()).toBe("tailscale");
  cli("stop");
  expect((await seen()).status).toBe("offline");
  cli("start");
  expect(macMode()).toBe("tailscale");
  expect((await seen()).status).toBe("online");
  expect(records()).toEqual(paired);
}, 120_000);

test.skipIf(!linux)("after an update, a server stopped from the paired device starts again on the tailnet", async () => {
  forgetSavedMode();
  // The imac stops it the way `openbuild remote server stop` does; the keeper holds the port.
  const { token } = JSON.parse(readFileSync(join(imac, "devices.json"), "utf8"))[0];
  const stop = await fetch(`http://127.0.0.2:${macPort}/api/remote/stop`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  expect(stop.status).toBe(200);
  await until(async () => (await seen()).status === "stopped", "the macbook's keeper answering");
  cli("start");
  expect(macMode()).toBe("tailscale");
  expect(savedMode()).toBe("tailscale");
  expect((await seen()).status).toBe("online");
  expect(records()).toEqual(paired);
}, 120_000);

test.skipIf(!linux)("a plain `openbuild start` on the paired machine keeps it on the tailnet", async () => {
  // This is how the app got opened on localhost: it used to switch the server to this computer only.
  const out = cli("start");
  expect(out).toContain("already running (tailscale)");
  expect(macMode()).toBe("tailscale");
  expect(await seen()).toMatchObject({ status: "online", urls: paired.imac[0].urls });
  expect(records()).toEqual(paired);
}, 60_000);

test.skipIf(!linux)("a restart, or a stop then a plain start, comes back on the tailnet", async () => {
  cli("restart");
  expect(macMode()).toBe("tailscale");
  expect((await seen()).status).toBe("online");
  cli("stop");
  // Fully stopped: unreachable, never revoked, and still paired on both sides.
  expect((await seen()).status).toBe("offline");
  expect(records()).toEqual(paired);
  cli("start");
  expect(macMode()).toBe("tailscale");
  expect((await seen()).status).toBe("online");
  expect(records()).toEqual(paired);
}, 120_000);

test.skipIf(!linux)("an explicit local start keeps the pairing, says so, and shows as unreachable, not revoked", async () => {
  const out = cli("start", "local");
  expect(out).toContain("The pairing is kept");
  expect(out).toContain("openbuild start tailscale");
  expect(macMode()).toBe("local");
  expect(await seen()).toMatchObject({ status: "offline", urls: paired.imac[0].urls });
  expect(records()).toEqual(paired);
  cli("start", "tailscale");
  expect((await seen()).status).toBe("online");
  expect(records()).toEqual(paired);
}, 120_000);

test.skipIf(!linux)("an address that reaches another OpenBuild isn't taken for a revocation", async () => {
  // A saved address that now reaches the imac's own server (as a loopback name for the other
  // computer would) answers 401 for the macbook's token. The real address still decides.
  const file = join(imac, "devices.json");
  const original = readFileSync(file, "utf8");
  const list = JSON.parse(original);
  list[0].urls = [`http://127.0.0.1:${imacPort}`, ...list[0].urls];
  writeFileSync(file, JSON.stringify(list), { mode: 0o600 });
  try {
    expect((await seen()).status).toBe("online");
    // Proxied requests go past that address to the macbook too.
    const config = await fetch(`http://127.0.0.1:${imacPort}/api/devices/${deviceId}/api/config`, { headers: { cookie } });
    expect(config.status).toBe(200);
    expect(((await config.json()) as { serverId: string }).serverId).toBe(paired.imac[0].serverId);
    cli("start", "local");
    expect((await seen()).status).toBe("offline");
    cli("start", "tailscale");
    expect((await seen()).status).toBe("online");
  } finally {
    writeFileSync(file, original, { mode: 0o600 });
  }
}, 120_000);

/** Another OpenBuild at a saved address, answering every request with `status` under its own id. */
const otherServer = (status: number) =>
  Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ serverId: "someone-else", running: true }, { status, headers: { "x-openbuild-server": "someone-else" } }) });
/** Put these addresses in the imac's saved list for the macbook while `run` runs. */
async function withUrls(urls: string[], run: () => Promise<void>) {
  const file = join(imac, "devices.json");
  const original = readFileSync(file, "utf8");
  const list = JSON.parse(original);
  list[0].urls = urls;
  writeFileSync(file, JSON.stringify(list), { mode: 0o600 });
  try {
    await run();
  } finally {
    writeFileSync(file, original, { mode: 0o600 });
  }
}
const proxied = () => fetch(`http://127.0.0.1:${imacPort}/api/devices/${deviceId}/api/config`, { headers: { cookie } });

test.skipIf(!linux)("another OpenBuild's answer of any status is skipped by the probe and the proxy", async () => {
  const others = [otherServer(404), otherServer(403), otherServer(200)];
  try {
    const otherUrls = others.map((o) => `http://127.0.0.1:${o.port}`);
    // Other servers first, then the macbook: the macbook answers.
    await withUrls([...otherUrls, ...paired.imac[0].urls], async () => {
      expect((await seen()).status).toBe("online");
      const res = await proxied();
      expect(res.status).toBe(200);
      expect(((await res.json()) as { serverId: string }).serverId).toBe(paired.imac[0].serverId);
    });
    // Only other servers: unreachable, and nothing of theirs is passed on.
    await withUrls(otherUrls, async () => {
      expect((await seen()).status).toBe("offline");
      expect((await proxied()).status).toBe(502);
    });
  } finally {
    for (const o of others) o.stop(true);
  }
});

test.skipIf(!linux)("revoking on the paired machine still shows as revoked", async () => {
  const [client] = onMac("return d.pairedClients()");
  onMac(`d.forgetPairedClient(${JSON.stringify(client.id)})`);
  expect((await seen()).status).toBe("revoked");
  expect((await proxied()).status).toBe(401);
  // Another server answering after the macbook's refusal doesn't hide it.
  const other = otherServer(404);
  try {
    await withUrls([...paired.imac[0].urls, `http://127.0.0.1:${other.port}`], async () => {
      expect((await seen()).status).toBe("revoked");
      expect((await proxied()).status).toBe(401);
    });
  } finally {
    other.stop(true);
  }
  // The imac keeps its record until someone unpairs it there; nothing removes it behind their back.
  expect(records().imac).toEqual(paired.imac);
});

test.skipIf(!linux)("LAN: after an update, a plain start, a stop and a plain start keep the server on the network", async () => {
  const box = join(directory, "lanbox");
  mkdirSync(box, { recursive: true });
  const port = free();
  // Another device paired with it, from its own side of the pairing.
  onData(box, port, `const p = d.createPairing({ name: "LAN box", mode: "lan", urls: [] }); return d.claimPairing(p.code, "laptop") && null`);
  try {
    cliOn(box, port, "start", "lan");
    forgetSavedMode(box);
    const mode = () => JSON.parse(readFileSync(join(box, "server.json"), "utf8")) as { mode: string; hosts: string[]; urls: string[] };
    expect(cliOn(box, port, "start")).toContain("already running (lan)");
    expect(savedMode(box)).toBe("lan");
    cliOn(box, port, "stop");
    cliOn(box, port, "start");
    expect(mode()).toMatchObject({ mode: "lan", hosts: ["0.0.0.0"] });
    // Reachable on this computer's network address, when it has one.
    const lan = mode().urls.find((u) => /^http:\/\/\d+\.\d+\.\d+\.\d+:/.test(u));
    if (lan) expect((await fetch(`${lan}/api/auth/status`)).ok).toBe(true);
  } finally {
    try {
      cliOn(box, port, "stop");
    } catch {}
  }
}, 120_000);
