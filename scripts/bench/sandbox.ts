// A disposable OpenBuild server for benchmarks: its own HOME, data folder and loopback port, so it
// never reads or writes the real install, its workers or its sessions. Everything it starts carries
// OPENCHAT_DATA_DIR=<root>/data in its environment, which is how stop() finds what to clean up:
// processes of other servers (the real one included) never match.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The checkout whose server runs: this one, or another (an export of the base commit, to compare). */
const repo = () => resolve(process.env.OPENBUILD_BENCH_REPO ?? join(import.meta.dir, "../.."));

export interface Sandbox {
  root: string;
  port: number;
  url: string;
  env: Record<string, string>;
  start(): Promise<number>;
  /** SIGTERM the server, as `openbuild stop` does. Its workers keep running, as in production. */
  stop(): Promise<void>;
  /** Stop the server and every process the sandbox started. */
  destroy(): Promise<void>;
  log: string[];
}

/** The name `--remote` benchmarks reach the sandbox by, as a browser on another machine would (bench.ts). */
export const REMOTE_HOST = "openbuild-bench.test";

export function sandbox(root: string, port: number, remote = false): Sandbox {
  root = resolve(root);
  if (!root.startsWith("/tmp/")) throw new Error("A benchmark sandbox lives under /tmp");
  const home = join(root, "home");
  mkdirSync(join(home, ".config"), { recursive: true });
  mkdirSync(join(root, "data"), { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Nothing that points at the real install, its runtimes' configs or its network.
    if (v === undefined || /^(OPENCHAT_|OPENBUILD_|PI_|CLAUDE_|CODEX_|CURSOR_|XDG_|DBUS_)/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    OPENCHAT_DATA_DIR: join(root, "data"),
    OPENBUILD_TAILSCALE_SOCKET: join(root, "no-tailscale.sock"),
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    ...(remote ? { OPENCHAT_ALLOWED_HOSTS: REMOTE_HOST } : {}),
  });
  let child: ChildProcess | undefined;
  const log: string[] = [];
  const box: Sandbox = {
    root, port, url: `http://${remote ? REMOTE_HOST : "127.0.0.1"}:${port}`, env, log,
    async start() {
      const began = performance.now();
      child = spawn(process.execPath, ["server/index.ts"], { cwd: repo(), env, stdio: ["ignore", "pipe", "pipe"] });
      const onData = (chunk: Buffer) => log.push(...String(chunk).split("\n").filter(Boolean));
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      // Listening is when a browser can reach it; the warm-up continues behind the open port.
      for (;;) {
        if (child.exitCode !== null) throw new Error(`Sandbox server exited:\n${log.join("\n")}`);
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { headers: remote ? { host: `${REMOTE_HOST}:${port}` } : {}, signal: AbortSignal.timeout(500) });
          if (res.ok) return performance.now() - began;
        } catch {}
        await Bun.sleep(10);
      }
    },
    async stop() {
      const c = child;
      child = undefined;
      if (!c || c.exitCode !== null) return;
      c.kill("SIGTERM");
      const exited = new Promise((r) => c.once("exit", r));
      if (!(await Promise.race([exited.then(() => true), Bun.sleep(10_000).then(() => false)]))) c.kill("SIGKILL");
    },
    async destroy() {
      await box.stop();
      for (const pid of sandboxProcesses(env.OPENCHAT_DATA_DIR!)) try { process.kill(pid, "SIGKILL"); } catch {}
    },
  };
  return box;
}

/** Processes whose environment names this sandbox's data folder: only what it started. */
export function sandboxProcesses(dataDir: string): number[] {
  const marker = `OPENCHAT_DATA_DIR=${dataDir}\0`;
  const out: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (`${readFileSync(`/proc/${name}/environ`, "latin1")}\0`.includes(marker)) out.push(Number(name));
    } catch {}
  }
  return out;
}
