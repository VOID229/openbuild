import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Never touch the developer's service, data, or actual runtime workers.
for (const managed of [false, true]) test(`stop preserves workers and stop --all terminates them with no server (${managed ? "systemd" : "detached"})`, async () => {
  const temp = mkdtempSync(join(tmpdir(), "openbuild-lifecycle-"));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const data = join(temp, "data");
    mkdirSync(data);
    const systemctl = join(temp, "systemctl");
    writeFileSync(systemctl, "#!/bin/sh\nexit 1\n");
    chmodSync(systemctl, 0o755);
    const child = () => {
      const p = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      children.push(p);
      return p;
    };
    const server = child();
    const pi = child();
    const durable = child();
    const ps = join(temp, "ps");
    writeFileSync(ps, `#!/bin/sh
case "$2" in
  ${pi.pid}) echo '/bin/bun ${root}/server/pi/worker.ts';;
  ${durable.pid}) echo '/bin/bun ${root}/server/durable/worker.ts';;
  *) echo '/bin/bun unrelated.ts';;
esac
`);
    chmodSync(ps, 0o755);
    writeFileSync(join(data, "server.json"), JSON.stringify({ pid: server.pid, mode: "local", port: 3100, urls: [] }));
    for (const [folder, pid] of [["pi-worker", pi.pid], ["durable", durable.pid]] as const) {
      mkdirSync(join(data, folder));
      writeFileSync(join(data, folder, "worker.json"), JSON.stringify({ pid, protocol: 1 }));
    }
    const cli = (...args: string[]) => Bun.spawnSync([process.execPath, join(root, "bin/openbuild.ts"), ...args], {
      env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, OPENCHAT_DATA_DIR: data },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10000,
    });
    expect(cli("stop").exitCode).toBe(0);
    await server.exited;
    expect(alive(server.pid)).toBe(false);
    expect(alive(pi.pid)).toBe(true);
    expect(alive(durable.pid)).toBe(true);
    expect(cli("stop").exitCode).toBe(0);
    expect(alive(pi.pid)).toBe(true);
    expect(alive(durable.pid)).toBe(true);
    if (managed) {
      // After the CLI-owned server stops, exercise an installed (inactive) unit.
      // These actions are mocked; they must never reach a real user service.
      writeFileSync(systemctl, `#!/bin/sh
if [ "$2" = show ]; then
  printf '%s\\n' 'LoadState=loaded' 'ActiveState=inactive' 'ExecStart=/bin/bun ${root}/server/index.ts' 'KillMode=process'
fi
exit 0
`);
      expect(cli("stop").exitCode).toBe(0);
      expect(alive(pi.pid)).toBe(true);
      expect(alive(durable.pid)).toBe(true);
    }
    expect(cli("stop", "--all").exitCode).toBe(0);
    await Promise.all([pi.exited, durable.exited]);
    expect(alive(pi.pid)).toBe(false);
    expect(alive(durable.pid)).toBe(false);
    expect(cli("stop", "--all").exitCode).toBe(0); // stale metadata is harmless
    const unrelated = child();
    writeFileSync(join(data, "pi-worker", "worker.json"), JSON.stringify({ pid: unrelated.pid }));
    expect(cli("stop", "--all").exitCode).toBe(0);
    expect(alive(unrelated.pid)).toBe(true); // reused PID does not identify a worker
    expect(cli("restart", "--all").exitCode).toBe(1);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => child.exited));
    rmSync(temp, { recursive: true, force: true });
  }
});
