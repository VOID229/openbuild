// Bots' computers. Each bot has one: a home folder with a terminal and a headless browser, kept on
// this machine as either
//   - a container (rootless Podman, else Docker) from OpenBots' image: Debian with Chromium, Node,
//     Python, git and the usual tools. The home folder is a folder here bind-mounted at /home/bot,
//     so files survive the container being rebuilt; or
//   - a plain folder on this machine, with no isolation: commands run as the user who runs
//     OpenBuild. For machines without a container engine.
// A computer can live on a paired device instead: that device's server runs it, and this one
// reaches it through /api/computers there (client.ts).
//
// Everything a bot does on its computer comes through here: commands (`exec`), files (`fs`), the
// browser and long-running processes (`proc`).
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import type { ComputerCapabilities, ComputerInfo, FileEntry, ProcInfo } from "../../shared/bots";
import { dataDir } from "../paths";
import { findBrowser } from "../pi/extensions/html-render";
import { Browser, PIPE_SCRIPT } from "./browser";

export const IMAGE = "localhost/openbots-computer:1";
const CONTAINER_HOME = "/home/bot";
const OUTPUT_KEEP = 256 * 1024;

const DOCKERFILE = `FROM docker.io/library/debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \\
      bash ca-certificates curl wget git openssh-client gnupg \\
      python3 python3-pip python3-venv nodejs npm \\
      chromium fonts-liberation fonts-noto-color-emoji \\
      ripgrep jq less nano procps psmisc unzip zip xz-utils file tree tmux sqlite3 sudo \\
  && rm -rf /var/lib/apt/lists/* \\
  && mkdir -p ${CONTAINER_HOME} && chmod 1777 ${CONTAINER_HOME}
ENV HOME=${CONTAINER_HOME}
WORKDIR ${CONTAINER_HOME}
CMD ["sleep", "infinity"]
`;

const run = (cmd: string[], opts: { stdin?: string; timeoutMs?: number } = {}) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = spawnChild(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.trim(), err: err.trim() });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });

// ------------------------------------------------------------------ engines and the image

type Engine = "podman" | "docker";
let enginesCache: { at: number; value: Engine[] } | undefined;

/** Container engines this user can actually use (Docker without access to its socket doesn't count). */
export async function engines(): Promise<Engine[]> {
  if (enginesCache && Date.now() - enginesCache.at < 60_000) return enginesCache.value;
  const found: Engine[] = [];
  for (const e of ["podman", "docker"] as const) {
    if (!Bun.which(e)) continue;
    const r = await run([e, "info"], { timeoutMs: 15_000 });
    if (r.code === 0) found.push(e);
  }
  enginesCache = { at: Date.now(), value: found };
  return found;
}

const hot = globalThis as {
  openbotsImage?: { state: ComputerCapabilities["image"]; log: string; building?: Promise<void> };
  openbotsComputers?: Map<string, Computer>;
};
const image = (hot.openbotsImage ??= { state: "missing", log: "" });

async function imageReady(engine: Engine): Promise<boolean> {
  const r = await run(engine === "podman" ? ["podman", "image", "exists", IMAGE] : ["docker", "image", "inspect", IMAGE], { timeoutMs: 15_000 });
  return r.code === 0;
}

/** Build OpenBots' computer image (once per machine; a few minutes the first time). */
export function buildImage(engine: Engine): Promise<void> {
  if (image.building) return image.building;
  image.building = (async () => {
    if (await imageReady(engine)) {
      image.state = "ready";
      return;
    }
    image.state = "building";
    image.log = "";
    const dir = join(tmpdir(), `openbots-image-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Dockerfile"), DOCKERFILE);
    const code = await new Promise<number>((resolve) => {
      const child = spawnChild(engine, ["build", "-t", IMAGE, dir], { stdio: ["ignore", "pipe", "pipe"] });
      const add = (d: Buffer) => (image.log = (image.log + d.toString()).slice(-8000));
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      child.on("error", (e) => {
        add(Buffer.from(e.message));
        resolve(-1);
      });
      child.on("close", (c) => resolve(c ?? -1));
    });
    await rm(dir, { recursive: true, force: true });
    image.state = code === 0 ? "ready" : "failed";
    if (code !== 0) throw new Error(`Building the computer image failed:\n${image.log.split("\n").slice(-12).join("\n")}`);
  })().finally(() => (image.building = undefined));
  return image.building;
}

export async function capabilities(device = "local"): Promise<ComputerCapabilities> {
  const found = await engines();
  if (found[0] && image.state !== "building" && image.state !== "failed") image.state = (await imageReady(found[0])) ? "ready" : "missing";
  return { device, engines: found, hostBrowser: !!findBrowser(), image: image.state, imageLog: image.state === "failed" || image.state === "building" ? image.log.slice(-3000) : undefined };
}

// ------------------------------------------------------------------ processes

interface Proc {
  info: ProcInfo;
  child: ChildProcess;
  output: string;
  /** Characters dropped from the front of `output`, so cursors stay valid. */
  dropped: number;
  readTo: number;
  kill: () => void;
  notify?: boolean;
}

/** Told when a process a bot asked to hear about ends: (computer id, process). */
export const procListeners = new Set<(computerId: string, proc: ProcInfo, tail: string) => void>();

// ------------------------------------------------------------------ computers

export interface ComputerConfig {
  id: string;
  kind: "container" | "host";
  engine?: Engine;
  createdAt: number;
}

const root = () => join(dataDir(), "computers");
const isComputerId = (id: string) => /^[A-Za-z0-9_-]{6,64}$/.test(id);

export class Computer {
  readonly dir: string;
  /** The home folder on this machine (bind-mounted into a container). */
  readonly hostHome: string;
  private browserInstance?: Browser;
  private procs = new Map<string, Proc>();
  private starting?: Promise<void>;
  /** When a running container was last seen running, so every command doesn't ask the engine again. */
  private checkedAt = 0;
  state: ComputerInfo["state"] = "stopped";
  error?: string;

  constructor(public config: ComputerConfig) {
    this.dir = join(root(), config.id);
    this.hostHome = join(this.dir, "home");
  }

  get id() {
    return this.config.id;
  }
  get container() {
    return `openbots-${this.config.id}`;
  }
  /** The home folder as the computer sees it. */
  get home() {
    return this.config.kind === "container" ? CONTAINER_HOME : this.hostHome;
  }

  private save() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir, "computer.json"), JSON.stringify(this.config, null, 2));
  }

  /** Switch between a container and a plain folder. The home folder is the same one either way. */
  async setKind(kind: "container" | "host") {
    if (this.config.kind === kind) return;
    await this.stop();
    this.config = { ...this.config, kind, engine: undefined };
    this.save();
  }

  /** Make sure it's running: create the folder, build the image and start the container as needed. */
  ensure(onProgress?: (message: string) => void): Promise<void> {
    if (this.state === "running" && (this.config.kind === "host" || Date.now() - this.checkedAt < 30_000)) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.state = "starting";
      this.error = undefined;
      try {
        mkdirSync(this.hostHome, { recursive: true, mode: 0o755 });
        mkdirSync(join(this.hostHome, "Downloads"), { recursive: true });
        this.save();
        if (this.config.kind === "host") {
          this.state = "running";
          return;
        }
        const engine = this.config.engine ?? (await engines())[0];
        if (!engine) throw new Error("No container engine works here. Install Podman (or Docker), or switch this computer to a plain folder.");
        if (this.config.engine !== engine) {
          this.config.engine = engine;
          this.save();
        }
        if (!(await imageReady(engine))) {
          onProgress?.("Setting up the computer for the first time (building its image). This takes a few minutes, once.");
          await buildImage(engine);
        }
        const inspect = await run([engine, "inspect", "-f", "{{.State.Running}}", this.container], { timeoutMs: 15_000 });
        if (inspect.code !== 0) {
          const uid = process.getuid?.() ?? 1000;
          const gid = process.getgid?.() ?? 1000;
          const selinux = existsSync("/sys/fs/selinux/enforce") ? ":Z" : "";
          const args = [
            engine, "run", "-d", "--name", this.container, "--hostname", `bot-${this.config.id.slice(0, 8)}`,
            "--label", "openbots=1", "--init", "--shm-size=1g",
            ...(engine === "podman" ? ["--userns=keep-id"] : ["--user", `${uid}:${gid}`]),
            "-v", `${this.hostHome}:${CONTAINER_HOME}${selinux}`, "-e", `HOME=${CONTAINER_HOME}`, "-w", CONTAINER_HOME,
            IMAGE, "sleep", "infinity",
          ];
          const created = await run(args, { timeoutMs: 120_000 });
          if (created.code !== 0) throw new Error(`Couldn't start the container: ${created.err || created.out}`);
          // Rootless Podman's root is this user, so sudo inside it grants nothing beyond the container.
          if (engine === "podman") await run([engine, "exec", "-u", "0", this.container, "sh", "-c", "echo 'ALL ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/bot && chmod 440 /etc/sudoers.d/bot"]);
        } else if (inspect.out !== "true") {
          const started = await run([engine, "start", this.container], { timeoutMs: 60_000 });
          if (started.code !== 0) throw new Error(`Couldn't start the container: ${started.err || started.out}`);
        }
        this.state = "running";
        this.checkedAt = Date.now();
      } catch (err) {
        this.state = "error";
        this.error = (err as Error).message;
        throw err;
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  async stop() {
    this.browserInstance?.close();
    this.browserInstance = undefined;
    for (const p of this.procs.values()) if (p.info.state === "running") p.kill();
    if (this.config.kind === "container" && this.config.engine) await run([this.config.engine, "stop", "-t", "3", this.container], { timeoutMs: 30_000 });
    this.state = "stopped";
  }

  /** Delete it: the container and the home folder with every file in it. */
  async destroy() {
    await this.stop();
    if (this.config.engine) await run([this.config.engine, "rm", "-f", this.container], { timeoutMs: 30_000 });
    // Only ever inside OpenBots' own computers folder.
    if (this.dir.startsWith(root() + "/") && relative(root(), this.dir) === this.config.id) await rm(this.dir, { recursive: true, force: true });
    hot.openbotsComputers?.delete(this.config.id);
  }

  async info(): Promise<ComputerInfo> {
    if (this.config.kind === "container" && this.config.engine && this.state !== "starting") {
      const r = await run([this.config.engine, "inspect", "-f", "{{.State.Running}}", this.container], { timeoutMs: 10_000 });
      this.state = r.out === "true" ? "running" : this.state === "error" ? "error" : "stopped";
    }
    return {
      id: this.id,
      kind: this.config.kind,
      device: "local",
      state: this.state,
      error: this.error,
      home: this.home,
      engine: this.config.engine,
      browser: this.browserInstance?.running ? { running: true, tabs: await this.browserInstance.listTabs().catch(() => []) } : { running: false, tabs: [] },
      procs: [...this.procs.values()].map((p) => p.info),
    };
  }

  // -------------------------------------------------------------- paths and environment

  /** A path the bot gave (relative to its home, or absolute in the computer). */
  private inside(path: string) {
    const p = path.replace(/^@/, "").trim() || ".";
    if (this.config.kind === "container") return posix.resolve(CONTAINER_HOME, p);
    return isAbsolute(p) ? resolve(p) : resolve(this.hostHome, p.replace(/^~(?=\/|$)/, this.hostHome));
  }

  /** Only host computers use host filesystem APIs. Container symlinks must resolve in the
   * container's namespace, never against this server's root (even in the bind-mounted home). */
  private local(insidePath: string): string | undefined {
    return this.config.kind === "host" ? insidePath : undefined;
  }

  private hostEnv(extra: Record<string, string> = {}) {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: this.hostHome, ...extra };
    // The bot's commands shouldn't find OpenBuild's or the user's sessions by accident.
    delete env.OPENBOTS_TOKEN;
    delete env.OPENBOTS_SOCKET;
    return env;
  }

  /** Start `bash -lc command` in the computer, in its own process group so it can be stopped as a whole. */
  private spawnShell(command: string, cwd: string, env: Record<string, string>, stdin: boolean): { child: ChildProcess; kill: () => void } {
    if (this.config.kind === "host") {
      const child = spawnChild("bash", ["-lc", command], { cwd: existsSync(cwd) ? cwd : this.hostHome, env: this.hostEnv(env), detached: true, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      return { child, kill };
    }
    const engine = this.config.engine!;
    const tag = crypto.randomUUID().slice(0, 12);
    const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    // setsid makes the shell a group leader; its pid (saved) is the group to kill.
    const child = spawnChild(engine, ["exec", "-i", "-w", cwd, ...envFlags, this.container, "setsid", "-w", "bash", "-c", 'echo $$ > "/tmp/.ob-$1.pid"; exec bash -lc "$2"', "ob", tag, command], {
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const kill = () => {
      void run([engine, "exec", this.container, "sh", "-c", `kill -KILL -- -"$(cat /tmp/.ob-${tag}.pid)" 2>/dev/null; rm -f /tmp/.ob-${tag}.pid`], { timeoutMs: 10_000 });
      child.kill("SIGKILL");
    };
    return { child, kill };
  }

  // -------------------------------------------------------------- commands

  /** Run a command to the end, streaming its output. Timeout and timeout:<ms> are milliseconds. */
  async exec(command: string, opts: { cwd?: string; timeout?: number; env?: Record<string, string>; onData?: (chunk: Buffer) => void; signal?: AbortSignal } = {}): Promise<{ exitCode: number | null }> {
    if (opts.signal?.aborted) throw new Error("aborted");
    await this.ensure();
    if (opts.signal?.aborted) throw new Error("aborted");
    const cwd = this.inside(opts.cwd ?? this.home);
    const { child, kill } = this.spawnShell(command, cwd, opts.env ?? {}, false);
    return new Promise((resolvePromise, reject) => {
      let timedOut = false;
      const timer = opts.timeout && opts.timeout > 0 ? setTimeout(() => ((timedOut = true), kill()), opts.timeout) : undefined;
      const onAbort = () => kill();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (d: Buffer) => opts.onData?.(d));
      child.stderr?.on("data", (d: Buffer) => opts.onData?.(d));
      child.on("error", (e) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (opts.signal?.aborted) reject(new Error("aborted"));
        else if (timedOut) reject(new Error(`timeout:${opts.timeout}`));
        else resolvePromise({ exitCode: code });
      });
    });
  }

  /** Run a short command and collect its output (all container file operations run here). */
  private async capture(command: string, stdin?: Buffer): Promise<{ code: number; out: Buffer; err: string }> {
    await this.ensure();
    const { child } = this.spawnShell(command, this.home, {}, stdin !== undefined);
    const out: Buffer[] = [];
    let err = "";
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => (err += d));
    const completion = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? -1));
      // A failed spawn or a command exiting before consuming input can also close stdin.
      child.stdin?.on("error", reject);
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
    const code = await completion;
    return { code, out: Buffer.concat(out), err: err.trim() };
  }

  // -------------------------------------------------------------- files

  async readFile(path: string): Promise<Buffer> {
    const p = this.inside(path);
    const local = this.local(p);
    if (local) return readFile(local);
    const r = await this.capture(`cat -- ${shq(p)}`);
    if (r.code !== 0) throw new Error(r.err || `Couldn't read ${p}`);
    return r.out;
  }

  async writeFile(path: string, data: Buffer | string) {
    const p = this.inside(path);
    const local = this.local(p);
    if (local) {
      await mkdir(dirname(local), { recursive: true });
      return writeFile(local, data);
    }
    const r = await this.capture(`mkdir -p -- ${shq(posix.dirname(p))} && cat > ${shq(p)}`, Buffer.from(data));
    if (r.code !== 0) throw new Error(r.err || `Couldn't write ${p}`);
  }

  async mkdir(path: string) {
    const p = this.inside(path);
    const local = this.local(p);
    if (local) return void (await mkdir(local, { recursive: true }));
    const r = await this.capture(`mkdir -p -- ${shq(p)}`);
    if (r.code !== 0) throw new Error(r.err || `Couldn't make ${p}`);
  }

  async access(path: string) {
    const p = this.inside(path);
    const local = this.local(p);
    if (local) return access(local);
    const r = await this.capture(`test -e ${shq(p)}`);
    if (r.code !== 0) throw Object.assign(new Error(`ENOENT: no such file or directory, access '${p}'`), { code: "ENOENT" });
  }

  async stat(path: string): Promise<{ dir: boolean; size: number; mtime: number }> {
    const p = this.inside(path);
    const local = this.local(p);
    if (local) {
      const s = await stat(local);
      return { dir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
    }
    const r = await this.capture(`stat -Lc '%F|%s|%Y' -- ${shq(p)}`);
    if (r.code !== 0) throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: "ENOENT" });
    const [type, size, mtime] = r.out.toString().trim().split("|");
    return { dir: type === "directory", size: Number(size), mtime: Number(mtime) * 1000 };
  }

  async readdir(path: string): Promise<string[]> {
    const p = this.inside(path);
    const local = this.local(p);
    if (local) return readdir(local);
    const r = await this.capture(`ls -1A -- ${shq(p)}`);
    if (r.code !== 0) throw new Error(r.err || `Couldn't list ${p}`);
    return r.out.toString().split("\n").filter(Boolean);
  }

  /** A folder's entries with sizes, for the app's file list. */
  async list(path = "."): Promise<{ path: string; entries: FileEntry[] }> {
    const p = this.inside(path);
    const names = (await this.readdir(p)).slice(0, 500);
    const entries = await Promise.all(
      names.map(async (name) => {
        const s = await this.stat(posix.join(p, name)).catch(() => ({ dir: false, size: 0, mtime: 0 }));
        return { name, ...s };
      }),
    );
    return { path: p, entries: entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)) };
  }

  // -------------------------------------------------------------- browser

  browser(): Browser {
    if (this.browserInstance) return this.browserInstance;
    const profile = posix.join(this.home, ".config", "openbots-browser");
    const downloads = posix.join(this.home, "Downloads");
    const spawn = (flags: string[]) => {
      if (this.config.kind === "host") {
        const bin = findBrowser();
        if (!bin) throw new Error("There's no Chrome or Chromium on this machine for the browser. Install Chromium, or switch this computer to a container.");
        return Bun.spawn(["sh", "-c", PIPE_SCRIPT, "sh", bin, ...flags], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: this.hostEnv() });
      }
      return Bun.spawn([this.config.engine!, "exec", "-i", this.container, "sh", "-c", PIPE_SCRIPT, "sh", "chromium", ...flags], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    };
    this.browserInstance = new Browser(spawn, profile, downloads);
    return this.browserInstance;
  }

  // -------------------------------------------------------------- long-running processes

  async startProc(command: string, name?: string, notify?: boolean): Promise<ProcInfo> {
    await this.ensure();
    const running = [...this.procs.values()].filter((p) => p.info.state === "running");
    if (running.length >= 12) throw new Error("Twelve processes are already running. Stop one first.");
    const id = `t${Math.random().toString(36).slice(2, 6)}`;
    const { child, kill } = this.spawnShell(command, this.home, {}, true);
    const proc: Proc = {
      info: { id, name: name?.trim() || command.slice(0, 40), command, state: "running", startedAt: Date.now() },
      child,
      output: "",
      dropped: 0,
      readTo: 0,
      kill,
      notify,
    };
    const add = (d: Buffer) => {
      proc.output += d.toString();
      if (proc.output.length > OUTPUT_KEEP) {
        const cut = proc.output.length - OUTPUT_KEEP;
        proc.output = proc.output.slice(cut);
        proc.dropped += cut;
      }
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", (err) => {
      add(Buffer.from(`${err.message}\n`));
      proc.info = { ...proc.info, state: "exited", exitCode: -1, endedAt: Date.now() };
    });
    child.stdin?.on("error", (err) => add(Buffer.from(`${err.message}\n`)));
    child.on("close", (code) => {
      proc.info = { ...proc.info, state: "exited", exitCode: proc.info.exitCode ?? code ?? null, endedAt: Date.now() };
      if (proc.notify) for (const l of procListeners) l(this.id, proc.info, proc.output.slice(-1500));
    });
    this.procs.set(id, proc);
    // Old finished ones go, so the list stays short.
    const done = [...this.procs.values()].filter((p) => p.info.state === "exited");
    for (const p of done.slice(0, Math.max(0, done.length - 10))) this.procs.delete(p.info.id);
    return proc.info;
  }

  /** New output since the last read (or the tail when `all`), optionally sending input first. */
  async readProc(id: string, opts: { input?: string; all?: boolean } = {}) {
    const proc = this.procs.get(id);
    if (!proc) throw new Error(`There's no process ${id}. terminal_read with no id lists them.`);
    if (opts.input !== undefined) {
      if (proc.info.state !== "running" || !proc.child.stdin) throw new Error("That process isn't running anymore.");
      proc.child.stdin.write(opts.input.endsWith("\n") ? opts.input : opts.input + "\n");
      await Bun.sleep(400);
    }
    const end = proc.dropped + proc.output.length;
    const from = opts.all ? proc.dropped : Math.max(proc.readTo, proc.dropped);
    const text = proc.output.slice(from - proc.dropped);
    const skipped = !opts.all && proc.readTo < proc.dropped ? proc.dropped - proc.readTo : 0;
    proc.readTo = end;
    return { info: proc.info, output: text, skipped };
  }

  stopProc(id: string) {
    const proc = this.procs.get(id);
    if (!proc) throw new Error(`There's no process ${id}.`);
    if (proc.info.state === "running") proc.kill();
    return proc.info;
  }

  listProcs() {
    return [...this.procs.values()].map((p) => p.info);
  }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Whether a computer with this id has been made on this machine (its folder exists), without loading or making it. */
export function computerExists(id: string): boolean {
  return isComputerId(id) && existsSync(join(root(), id, "computer.json"));
}

/** A computer on this machine, loaded from disk or made with `kind`. */
export function computer(id: string, kind?: "container" | "host"): Computer {
  if (!isComputerId(id)) throw Object.assign(new Error("Invalid computer id"), { status: 400 });
  const map = (hot.openbotsComputers ??= new Map());
  let c = map.get(id);
  if (!c) {
    const file = join(root(), id, "computer.json");
    let config: ComputerConfig | undefined;
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    c = new Computer(config ?? { id, kind: kind ?? "host", createdAt: Date.now() });
    map.set(id, c);
  }
  return c;
}

/** Stop every computer's browser and processes (the server is going away). Containers keep running. */
export function shutdownComputers() {
  for (const c of hot.openbotsComputers?.values() ?? []) {
    for (const p of c.listProcs()) if (p.state === "running") c.stopProc(p.id);
  }
}
