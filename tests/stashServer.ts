// A throwaway OpenBuild server for the stash tests: its own data directory, a spare port, no
// password, restartable on the same port and data. Never the server this machine runs.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export class ThrowawayServer {
  readonly dir = mkdtempSync(join(tmpdir(), "ob-stash-"));
  readonly data = join(this.dir, "data");
  port = 0;
  private child?: ReturnType<typeof Bun.spawn>;
  private log: string[] = [];

  /** `http://127.0.0.1:<port>`; the same server is also `http://localhost:<port>`, another origin. */
  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start() {
    if (!this.port) {
      const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      this.port = probe.port!;
      probe.stop(true);
    }
    mkdirSync(this.data, { recursive: true });
    const child = Bun.spawn([process.execPath, resolve("server/index.ts")], {
      env: {
        ...process.env,
        NODE_ENV: "development",
        PORT: String(this.port),
        HOST: "127.0.0.1",
        OPENCHAT_DATA_DIR: this.data,
        OPENCHAT_SECRETS: "file",
        OPENCHAT_SECRETS_FILE: join(this.dir, "secrets.json"),
        PI_CODING_AGENT_DIR: join(this.dir, "pi-agent"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) void new Response(stream).text().then((t) => this.log.push(t));
    for (const deadline = Date.now() + 30_000; ; ) {
      if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode}): ${this.log.join("\n")}`);
      if (await fetch(`${this.url}/api/auth/status`).then((r) => r.ok, () => false)) return;
      if (Date.now() > deadline) throw new Error("Server didn't start");
      await Bun.sleep(50);
    }
  }

  async stop() {
    this.child?.kill("SIGTERM");
    await this.child?.exited;
    this.child = undefined;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async json<T = any>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.url + path, init);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async dispose() {
    await this.stop();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
