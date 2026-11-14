import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalAuth } from "../server/localAuth";
import { PreviewSocket } from "../server/preview";
import { spawnScriptSync } from "./spawnScript";

// A localhost preview of a paired device's dev server, through two real OpenBuild servers on
// throwaway data directories: the browser's server on 127.0.0.2, the device (the host) on
// 127.0.0.1 with the dev server on its loopback. Everything the relay route does (the device
// API's checks, its response handling, WebSocket upgrades) runs as it does across a LAN.
const linux = process.platform === "linux";
const directory = mkdtempSync(join(tmpdir(), "openbuild-preview-paired-"));
const hostData = join(directory, "host");
const clientData = join(directory, "client");
const password = "preview paired fixture password";
let port = 0;
let cookie = "";
let deviceId = "";
const servers: ReturnType<typeof Bun.spawn>[] = [];
const logs: Promise<string>[] = [];
let dev: ReturnType<typeof Bun.serve> | undefined;

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}

async function launch(data: string, host: string) {
  const env = {
    ...process.env, NODE_ENV: "production", PORT: String(port), HOST: host, OPENCHAT_ALLOWED_HOSTS: host,
    OPENCHAT_DATA_DIR: data, OPENCHAT_SECRETS: "file", OPENCHAT_SECRETS_FILE: join(data, "secrets.json"), PI_CODING_AGENT_DIR: join(data, "pi"), CI: "1",
  };
  const child = Bun.spawn([process.execPath, resolve("server/index.ts")], { env, stdout: "pipe", stderr: "pipe" });
  servers.push(child);
  logs.push(new Response(child.stdout).text(), new Response(child.stderr).text());
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited: ${(await Promise.all(logs)).join("\n")}`);
    return fetch(`http://${host}:${port}/api/auth/status`).then((r) => r.ok, () => false);
  }, `server on ${host}`);
}

beforeAll(async () => {
  if (!linux) return;
  for (const dir of [hostData, clientData]) mkdirSync(dir, { recursive: true });
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  port = probe.port!;
  probe.stop(true);
  await createLocalAuth({ directory: clientData }).setPassword(password);
  await Promise.all([launch(hostData, "127.0.0.1"), launch(clientData, "127.0.0.2")]);
  const login = await fetch(`http://127.0.0.2:${port}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const script = `const d = await import(${JSON.stringify(resolve("server/devices.ts"))}); console.log(JSON.stringify(d.createPairing({ name: "host-box", mode: "lan", urls: [] })));`;
  const opened = spawnScriptSync(script, { OPENCHAT_DATA_DIR: hostData });
  if (opened.code !== 0) throw new Error(opened.stderr);
  const { code } = JSON.parse(opened.stdout);
  const paired = await fetch(`http://127.0.0.2:${port}/api/pair/connect`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ mode: "lan", code, address: `127.0.0.1:${port}` }),
  });
  expect(paired.status, await paired.clone().text()).toBe(200);
  deviceId = JSON.parse(readFileSync(join(clientData, "devices.json"), "utf8"))[0].id;
  dev = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      if (req.headers.get("upgrade") === "websocket" && server.upgrade(req, { data: undefined })) return;
      const url = new URL(req.url);
      return Response.json({ path: url.pathname + url.search, origin: req.headers.get("origin"), authorization: req.headers.get("authorization") });
    },
    websocket: { message(ws, data) { ws.send(data); } },
  });
}, 60_000);

afterAll(async () => {
  dev?.stop(true);
  for (const child of servers) child.kill();
  await Promise.all(servers.map((child) => child.exited));
  rmSync(directory, { recursive: true, force: true });
});

async function openPreview(url: string) {
  const res = await fetch(`http://127.0.0.2:${port}/api/preview`, {
    method: "POST", headers: { cookie, "content-type": "application/json", origin: `http://127.0.0.2:${port}` }, body: JSON.stringify({ url, deviceId }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const entry = (await res.json()).url as string;
  const opened = await fetch(entry, { redirect: "manual" });
  return { entry, origin: new URL(entry).origin, cookie: opened.headers.get("set-cookie")!.split(";")[0]! };
}

test.skipIf(!linux)("a paired device's dev server opens through the real relay, HTTP and hot reload socket", async () => {
  const preview = await openPreview(`http://localhost:${dev!.port}/app?x=1`);
  // On the address the browser reached the app at, bound to the same one.
  expect(preview.origin).toStartWith("http://127.0.0.2:");
  const page = await fetch(preview.origin + "/app?x=1", { headers: { cookie: preview.cookie } });
  expect(await page.json()).toMatchObject({ path: "/app?x=1", authorization: null });
  const post = await fetch(preview.origin + "/form", { method: "POST", body: "a=1", headers: { cookie: preview.cookie, origin: preview.origin } });
  expect((await post.json()).origin).toBe(`http://127.0.0.1:${dev!.port}`);
  await new Promise<void>((done, fail) => {
    const socket = new PreviewSocket(preview.origin.replace("http:", "ws:") + "/hmr", { headers: { cookie: preview.cookie, origin: preview.origin } });
    const timer = setTimeout(() => fail(new Error("relay socket timed out")), 5000);
    socket.onopen = () => socket.send("paired hmr");
    socket.onmessage = (e) => { expect(e.data).toBe("paired hmr"); clearTimeout(timer); socket.close(); done(); };
    socket.onclose = (e) => { clearTimeout(timer); fail(new Error(`relay socket closed: ${e.code}`)); };
  });
  // Another page of the same dev server is the same preview.
  expect((await openPreview(`http://localhost:${dev!.port}/other`)).origin).toBe(preview.origin);
}, 30_000);

test.skipIf(!linux)("a paired device's dev server that isn't up yet shows the waiting page", async () => {
  const free = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const unused = free.port;
  free.stop(true);
  const preview = await openPreview(`http://localhost:${unused}/`);
  const res = await fetch(preview.origin + "/", { headers: { cookie: preview.cookie, "sec-fetch-dest": "iframe", accept: "text/html" } });
  expect(res.status).toBe(502);
  expect(await res.text()).toContain("Waiting for the dev server");
}, 30_000);
