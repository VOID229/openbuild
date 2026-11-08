import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// OpenCode servers OpenBuild starts must not outlive it: not on SIGTERM (systemd stop with
// KillMode=process, `openbuild stop`), and not on SIGKILL, where the next start reaps them.
const directory = mkdtempSync(join(tmpdir(), "ob-opencode-orphans-"));
const data = join(directory, "data");
const log = join(directory, "log");
const fake = join(directory, "fake-opencode.js");
const bin = join(directory, "opencode");
mkdirSync(data);
writeFileSync(fake, String.raw`
import { appendFileSync } from 'node:fs';
const service = process.argv.includes('--service');
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === '/api/info') return Response.json({ version: '2.0.32' });
  if (path === '/api/model') return Response.json({ data: [] });
  if (path === '/api/model/default') return Response.json({ data: null });
  return Response.json({ data: [] });
}});
appendFileSync(process.env.OC_FIXTURE_LOG, JSON.stringify({ pid: process.pid, service, tethered: process.env.OC_FIXTURE_TETHERED, token: !!process.env.OPENBUILD_OPENCODE_TOKEN }) + '\n');
console.log('opencode server listening on ' + server.url);
`);
// Strip Bun's no-orphans flag to stand for an OpenCode build without it (and CI's older Bun),
// so only OpenBuild's own cleanup can stop these servers.
writeFileSync(bin, `#!/bin/sh\nOC_FIXTURE_TETHERED="$BUN_FEATURE_FLAG_NO_ORPHANS"\nexport OC_FIXTURE_TETHERED\nunset BUN_FEATURE_FLAG_NO_ORPHANS\nexec "${process.execPath}" "${fake}" "$@"\n`);
chmodSync(bin, 0o700);
const env = {
  ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", OPENCHAT_DATA_DIR: data, PI_CODING_AGENT_DIR: join(directory, "agent"),
  OPENCODE_BIN: bin, OPENCODE_SERVER_URL: "", OPENCODE_SERVER_PASSWORD: "", OC_FIXTURE_LOG: log, OPENBUILD_SESSION_DISCOVERY: "0",
};
const rows = (): { pid: number; service: boolean; tethered?: string; token: boolean }[] =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
// A killed orphan is a zombie until its new parent reaps it.
const alive = (pid: number) => { try { return !/^\S+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; } };
async function until(check: () => boolean | Promise<boolean>, label: string, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) if (await check()) return;
  throw new Error(`Timed out: ${label}`);
}
const others: number[] = [];
afterAll(() => {
  for (const { pid } of rows()) try { process.kill(pid, "SIGKILL"); } catch {}
  for (const pid of others) try { process.kill(pid, "SIGKILL"); } catch {}
  rmSync(directory, { recursive: true, force: true });
});

/** An OpenBuild web server whose models request has started its shared OpenCode server. */
async function serverWithOpencode() {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  const before = rows().length;
  const server = Bun.spawn([process.execPath, resolve("server/index.ts")], { env: { ...env, PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text()]).then(parts => parts.join("\n"));
  await until(async () => {
    if (server.exitCode !== null) throw new Error(`Server exited: ${await output}`);
    try { return (await fetch(`http://127.0.0.1:${port}/api/opencode/models`)).ok; } catch { return false; }
  }, "server and OpenCode models");
  const spawned = rows().slice(before);
  expect(spawned).toHaveLength(1);
  return { server, output, child: spawned[0]! };
}

test.skipIf(process.platform !== "linux")("SIGTERM to the web server stops its OpenCode server and still exits by the signal", async () => {
  const { server, child } = await serverWithOpencode();
  expect(child).toMatchObject({ tethered: "1", token: true });
  expect(alive(child.pid)).toBe(true);
  server.kill("SIGTERM");
  await server.exited;
  expect(server.signalCode).toBe("SIGTERM");
  await until(() => !alive(child.pid), "OpenCode server stopped with the web server", 5_000);
}, 40_000);

test.skipIf(process.platform !== "linux")("after a SIGKILL the next start reaps only OpenBuild's orphans", async () => {
  // The user's own server, and a live owner's server (a detached worker's), must survive.
  const before = rows().length;
  const service = Bun.spawn([bin, "serve", "--service"], { env: { ...process.env, OC_FIXTURE_LOG: log }, stdout: "pipe", stderr: "ignore" });
  others.push(service.pid);
  const owner = Bun.spawn([process.execPath, "-e", `
    const { workerConnection } = await import(${JSON.stringify(resolve("server/opencode-agent/connection.ts"))});
    await workerConnection(); console.log("ready"); setInterval(() => {}, 1000);
  `], { env, stdout: "pipe", stderr: "inherit" });
  others.push(owner.pid);
  await new Response(owner.stdout).body!.getReader().read();
  await until(() => rows().length === before + 2, "user's and worker's servers");
  const user = rows().slice(before).find(r => r.service)!, worker = rows().slice(before).find(r => !r.service)!;
  expect(worker).toMatchObject({ tethered: "", token: true });

  const { server, child } = await serverWithOpencode();
  // A stale record whose PID now belongs to an unrelated process: the token can't match.
  writeFileSync(join(data, "opencode-servers", `${user.pid}.json`), JSON.stringify({ pid: user.pid, owner: 1, token: crypto.randomUUID() + crypto.randomUUID() }));
  server.kill("SIGKILL");
  await server.exited;
  await Bun.sleep(300);
  expect(alive(child.pid)).toBe(true); // nothing in-process can run on SIGKILL
  expect(readdirSync(join(data, "opencode-servers")).sort()).toEqual([child.pid, user.pid, worker.pid].map(pid => `${pid}.json`).sort());

  const next = await serverWithOpencode();
  await until(() => !alive(child.pid), "orphan reaped at startup", 5_000);
  expect(next.server.exitCode).toBeNull();
  expect(alive(user.pid)).toBe(true);
  expect(alive(worker.pid)).toBe(true);
  const records = readdirSync(join(data, "opencode-servers"));
  expect(records).toContain(`${worker.pid}.json`);
  expect(records).not.toContain(`${child.pid}.json`);
  expect(records).not.toContain(`${user.pid}.json`);
  next.server.kill("SIGTERM");
  await next.server.exited;
  await until(() => !alive(next.child.pid), "second server's OpenCode stopped", 5_000);
  owner.kill("SIGTERM");
  await owner.exited;
  await until(() => !alive(worker.pid), "owner's OpenCode stopped with its owner", 5_000);
  expect(alive(user.pid)).toBe(true);
}, 60_000);
