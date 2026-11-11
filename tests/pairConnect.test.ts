import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalAuth } from "../server/localAuth";
import { spawnScriptSync } from "./spawnScript";

// Two real OpenBuild servers on throwaway data directories: a host on 127.0.0.1 and a client on
// 127.0.0.2, on the same port, so the client's discovery finds the host the way it would find
// another computer. A fake `tailscale` on PATH lists the host as a tailnet peer. Nothing here
// reaches the network beyond loopback, and no real pairing or server is touched.
const linux = process.platform === "linux";
const directory = mkdtempSync(join(tmpdir(), "openbuild-pair-connect-"));
const hostData = join(directory, "host");
const clientData = join(directory, "client");
const cliData = join(directory, "cli");
const bin = join(directory, "bin");
const status = join(directory, "tailscale-status.json");
const password = "pair connect fixture password";
let port = 0;
let cookie = "";
const servers: ReturnType<typeof Bun.spawn>[] = [];
const logs: Promise<string>[] = [];

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}

const env = (data: string, host: string) => ({
  ...process.env,
  NODE_ENV: "production",
  PORT: String(port),
  HOST: host,
  OPENCHAT_ALLOWED_HOSTS: host,
  OPENCHAT_DATA_DIR: data,
  OPENCHAT_SECRETS: "file",
  OPENCHAT_SECRETS_FILE: join(data, "secrets.json"),
  PI_CODING_AGENT_DIR: join(data, "pi"),
  PATH: `${bin}:${process.env.PATH}`,
  FAKE_TAILSCALE_STATUS: status,
  CI: "1",
});

async function launch(data: string, host: string) {
  const child = Bun.spawn([process.execPath, resolve("server/index.ts")], { env: env(data, host), stdout: "pipe", stderr: "pipe" });
  servers.push(child);
  logs.push(new Response(child.stdout).text(), new Response(child.stderr).text());
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited: ${(await Promise.all(logs)).join("\n")}`);
    try {
      return (await fetch(`http://${host}:${port}/api/auth/status`)).ok;
    } catch {
      return false;
    }
  }, `server on ${host}`);
}

const connect = (body: unknown, init: RequestInit = {}) =>
  fetch(`http://127.0.0.2:${port}/api/pair/connect`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", ...(init.headers as Record<string, string>) },
    body: JSON.stringify(body),
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });

/** Open a pairing on the host, the way `openbuild pair --host` does. */
function openPairing(data: string, mode: "lan" | "tailscale", name = "host-box") {
  const script = `const d = await import(${JSON.stringify(resolve("server/devices.ts"))}); console.log(JSON.stringify(d.createPairing({ name: ${JSON.stringify(name)}, mode: ${JSON.stringify(mode)}, urls: [] })));`;
  const run = spawnScriptSync(script, { OPENCHAT_DATA_DIR: data });
  if (run.code !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as { code: string; expiresAt: number };
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const clearClientDevices = () => rmSync(join(clientData, "devices.json"), { force: true });

beforeAll(async () => {
  if (!linux) return;
  for (const dir of [hostData, clientData, cliData, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(bin, "tailscale"), `#!/bin/sh\ncat "$FAKE_TAILSCALE_STATUS"\n`);
  chmodSync(join(bin, "tailscale"), 0o755);
  writeFileSync(status, JSON.stringify({ BackendState: "Running", Self: { TailscaleIPs: ["127.0.0.2"] }, Peer: { host: { TailscaleIPs: ["127.0.0.1"] } } }));
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  port = probe.port!;
  probe.stop(true);
  await createLocalAuth({ directory: clientData }).setPassword(password);
  await Promise.all([launch(hostData, "127.0.0.1"), launch(clientData, "127.0.0.2")]);
  const login = await fetch(`http://127.0.0.2:${port}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
}, 60_000);

afterAll(async () => {
  for (const child of servers) child.kill();
  await Promise.all(servers.map((child) => child.exited));
  rmSync(directory, { recursive: true, force: true });
});

test.skipIf(!linux)("pairing from Settings needs the signed-in browser", async () => {
  const res = await fetch(`http://127.0.0.2:${port}/api/pair/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "lan", code: "ABCD-2345" }) });
  expect(res.status).toBe(401);
});

test.skipIf(!linux)("bad input is refused before anything is contacted", async () => {
  expect((await connect({ mode: "wifi", code: "ABCD-2345" })).status).toBe(400);
  expect((await connect({ mode: "lan", code: "" })).status).toBe(400);
  expect((await connect({ mode: "lan", code: "ab" })).status).toBe(400);
  for (const address of [`http://127.0.0.1:${port}/api/projects`, `user:pw@127.0.0.1:${port}`, `127.0.0.1:${port}?x=1`, "ftp://127.0.0.1"]) {
    const res = await connect({ mode: "lan", code: "ABCD-2345", address });
    expect(res.status).toBe(400);
  }
});

test.skipIf(!linux)("Tailscale: discovery finds the host, skips this server, and the token stays server-side", async () => {
  clearClientDevices();
  const { code } = openPairing(hostData, "tailscale");
  // This server has a pairing open too: it is found at its own tailnet address and must be skipped.
  const own = openPairing(clientData, "tailscale", "client-box");
  const res = await connect({ mode: "tailscale", code: code.toLowerCase() });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  const { device } = JSON.parse(text);
  expect(device).toMatchObject({ name: "host-box", mode: "tailscale" });
  const saved = readJson(join(clientData, "devices.json"));
  expect(saved).toHaveLength(1);
  expect(saved[0].token).toMatch(/^[a-f0-9]{64}$/);
  expect(text).not.toContain(saved[0].token);
  expect(text).not.toContain("token");
  // The host holds only a hash, and its pairing is used up.
  expect(readFileSync(join(hostData, "paired-clients.json"), "utf8")).not.toContain(saved[0].token);
  expect(readJson(join(hostData, "pairing.json")).claimedBy).toBeTruthy();
  // This server's own pairing was not claimed.
  expect(readJson(join(clientData, "pairing.json"))).toMatchObject({ code: own.code });
  expect(readJson(join(clientData, "pairing.json")).claimedBy).toBeUndefined();
  rmSync(join(clientData, "pairing.json"));

  // The paired device shows in Settings → Devices, without its token.
  const list = await fetch(`http://127.0.0.2:${port}/api/devices`, { headers: { cookie } }).then((r) => r.text());
  expect(list).toContain("host-box");
  expect(list).not.toContain(saved[0].token);

  // The code is single-use.
  const again = await connect({ mode: "tailscale", code });
  expect(again.status).toBe(404);
  expect((await again.json()).reason).toBe("not-found");
}, 30_000);

test.skipIf(!linux)("a paired device's token can't make its host pair with anything", async () => {
  const [{ token }] = readJson(join(clientData, "devices.json"));
  const res = await fetch(`http://127.0.0.1:${port}/api/pair/connect`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ mode: "lan", code: "ABCD-2345", address: "127.0.0.2" }),
  });
  expect(res.status).toBe(403);
});

test.skipIf(!linux)("LAN: pairing at a typed address", async () => {
  clearClientDevices();
  const { code } = openPairing(hostData, "lan");
  const res = await connect({ mode: "lan", code, address: `127.0.0.1:${port}` });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(JSON.parse(text).device).toMatchObject({ name: "host-box", mode: "lan" });
  expect(readJson(join(clientData, "devices.json"))[0].urls[0]).toMatch(/^https?:\/\/127\.0\.0\.1:/);
}, 30_000);

test.skipIf(!linux)("a wrong code is rejected and leaves the host waiting", async () => {
  clearClientDevices();
  const { code } = openPairing(hostData, "lan");
  const wrong = code === "ZZZZ-ZZZZ" ? "YYYY-YYYY" : "ZZZZ-ZZZZ";
  const res = await connect({ mode: "lan", code: wrong, address: `http://127.0.0.1:${port}` });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.reason).toBe("rejected");
  expect(body.error).toContain("didn't match");
  expect(readJson(join(hostData, "pairing.json")).claimedBy).toBeUndefined();
  expect(existsSync(join(clientData, "devices.json"))).toBe(false);
}, 30_000);

test.skipIf(!linux)("an expired code finds nobody waiting", async () => {
  const pending = openPairing(hostData, "tailscale");
  writeFileSync(join(hostData, "pairing.json"), JSON.stringify({ ...readJson(join(hostData, "pairing.json")), expiresAt: Date.now() - 1 }));
  const res = await connect({ mode: "tailscale", code: pending.code });
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body.reason).toBe("not-found");
  expect(body.error).toContain("openbuild pair --host");
}, 30_000);

test.skipIf(!linux)("nobody at a typed address is reported as not found", async () => {
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const free = closed.port;
  closed.stop(true);
  const res = await connect({ mode: "lan", code: "ABCD-2345", address: `http://127.0.0.1:${free}` });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toContain(`at http://127.0.0.1:${free}`);
}, 30_000);

test.skipIf(!linux)("one search at a time; cancelling frees the slot", async () => {
  // A host that accepts connections and never answers keeps a search running.
  const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  try {
    const ctrl = new AbortController();
    const first = connect({ mode: "lan", code: "ABCD-2345", address: `http://127.0.0.1:${silent.port}` }, { signal: ctrl.signal }).catch((e) => e);
    await Bun.sleep(150);
    const second = await connect({ mode: "lan", code: "ABCD-2345", address: `http://127.0.0.1:${silent.port}` });
    expect(second.status).toBe(409);
    ctrl.abort();
    await first;
    // The server notices the browser left and stops searching.
    let status = 409;
    await until(async () => {
      const res = await connect({ mode: "lan", code: "ABCD-2345", address: "127.0.0.9:1" });
      status = res.status;
      return status !== 409;
    }, "the search to stop after cancelling");
    expect([404, 429]).toContain(status);
  } finally {
    silent.stop(true);
  }
}, 30_000);

test.skipIf(!linux)("attempts are rate limited", async () => {
  let res: Response | undefined;
  for (let i = 0; i < 12; i++) {
    res = await connect({ mode: "lan", code: "ABCD-2345", address: "127.0.0.9:1" });
    if (res.status === 429) break;
  }
  expect(res!.status).toBe(429);
  expect(Number(res!.headers.get("retry-after"))).toBeGreaterThan(0);
}, 60_000);

// `openbuild pair --client` still works, through the same code path, in a real terminal.
const hasPython = linux && Bun.spawnSync(["which", "python3"]).exitCode === 0;
const pty = String.raw`
import json, os, pty, subprocess, sys, time
master, slave = pty.openpty()
os.set_blocking(master, False)
child = subprocess.Popen(json.loads(sys.argv[1]), stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
answers = json.loads(sys.argv[2])
output = b''
start = time.monotonic()
try:
    while time.monotonic() - start < 25:
        try:
            output += os.read(master, 8192)
        except OSError:
            pass
        if answers and answers[0][0].encode() in output:
            os.write(master, (answers.pop(0)[1] + '\n').encode())
        if child.poll() is not None:
            break
        time.sleep(0.01)
    try:
        output += os.read(master, 65536)
    except OSError:
        pass
    print(json.dumps({'code': child.poll(), 'output': output.decode(errors='replace')}))
finally:
    if child.poll() is None:
        child.kill()
    child.wait()
    os.close(master)
`;

test.skipIf(!hasPython)("the CLI pairs over Tailscale with the same protocol", async () => {
  const { code } = openPairing(hostData, "tailscale", "cli-host");
  const run = Bun.spawnSync(
    ["python3", "-c", pty, JSON.stringify([process.execPath, resolve("bin/openbuild.ts"), "pair", "--client"]), JSON.stringify([["Tailscale or", "1"], ["Pairing code", code]])],
    { env: { ...env(cliData, "127.0.0.3"), OPENBUILD_NO_MOTION: "1" }, stdout: "pipe", stderr: "pipe" },
  );
  const result = JSON.parse(run.stdout.toString());
  expect(result.output).toContain("Paired with");
  expect(result.output).toContain("cli-host");
  expect(result.code).toBe(0);
  expect(readJson(join(cliData, "devices.json"))[0]).toMatchObject({ name: "cli-host", mode: "tailscale" });
}, 40_000);
