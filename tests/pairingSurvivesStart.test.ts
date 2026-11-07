import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** `openbuild …` on the macbook. */
function cli(...args: string[]) {
  const run = Bun.spawnSync([process.execPath, join(root, "bin/openbuild.ts"), ...args], { cwd: root, env: env(mac, macPort), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const out = run.stdout.toString() + run.stderr.toString();
  if (run.exitCode !== 0) throw new Error(`openbuild ${args.join(" ")} failed:\n${out}`);
  return out;
}

/** Run devices.ts in the macbook's data, in a subprocess so this process never holds its paths. */
function onMac(code: string) {
  const script = `const d = await import(${JSON.stringify(join(root, "server/devices.ts"))}); console.log(JSON.stringify(await (async () => { ${code} })() ?? null));`;
  const run = Bun.spawnSync([process.execPath, "-e", script], { env: env(mac, macPort), stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString());
}

const macMode = () => JSON.parse(readFileSync(join(mac, "server.json"), "utf8")).mode as string;
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

test.skipIf(!linux)("revoking on the paired machine still shows as revoked", async () => {
  const [client] = onMac("return d.pairedClients()");
  onMac(`d.forgetPairedClient(${JSON.stringify(client.id)})`);
  expect((await seen()).status).toBe("revoked");
  // The imac keeps its record until someone unpairs it there; nothing removes it behind their back.
  expect(records().imac).toEqual(paired.imac);
});
