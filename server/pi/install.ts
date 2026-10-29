// Finding the Pi install OpenBuild drives. Pi is never bundled: the server runs whatever `pi` is
// installed for this user (the managed installer's ~/.local/bin/pi, an npm global install, or
// PI_BIN), and reads its SDK from that same install for things RPC mode doesn't cover (sign-in).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** ~/.pi/agent, or PI_CODING_AGENT_DIR: settings, auth, extensions, skills, sessions. */
export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** The `pi` executable, or undefined when Pi isn't installed. */
export function piBin(): string | undefined {
  if (process.env.PI_BIN) return existsSync(process.env.PI_BIN) ? process.env.PI_BIN : undefined;
  const found = Bun.which("pi", { PATH: `${process.env.PATH ?? ""}:${join(homedir(), ".local", "bin")}:${join(agentDir(), "bin")}` });
  return found ?? undefined;
}

/**
 * The installed pi-coding-agent package directory. The managed installer keeps releases under
 * <agent>/install/releases/<version>; an npm install is found by following the `pi` symlink.
 */
export function packageRoot(): string | undefined {
  const install = join(agentDir(), "install");
  try {
    const version = readFileSync(join(install, "current-version"), "utf8").trim();
    const root = join(install, "releases", version, "node_modules", ...PI_PACKAGE.split("/"));
    if (existsSync(join(root, "package.json"))) return root;
  } catch {}
  const bin = piBin();
  if (!bin) return undefined;
  try {
    let dir = dirname(realpathSync(bin));
    for (let i = 0; i < 6; i++) {
      const pkg = join(dir, "package.json");
      if (existsSync(pkg) && JSON.parse(readFileSync(pkg, "utf8")).name === PI_PACKAGE) return dir;
      dir = dirname(dir);
    }
  } catch {}
  return undefined;
}

/** How Pi was installed, which decides how it updates. */
export function installKind(): "managed" | "npm" | "other" | "missing" {
  if (!piBin()) return "missing";
  if (existsSync(join(agentDir(), "install", "managed-install.json"))) return "managed";
  return packageRoot()?.includes(`${"node_modules"}`) ? "npm" : "other";
}

/** A Node.js binary for the SDK helper: Pi's own (managed installs), else the one on PATH, else Bun. */
export function nodeBin(): string {
  const piNode = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "pi-node", "current", "bin", "node");
  if (existsSync(piNode)) return piNode;
  return Bun.which("node", { PATH: `${process.env.PATH ?? ""}:${join(homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin` }) ?? process.execPath;
}

/** Environment for Pi child processes: its bin dir on PATH, as its launcher does. */
export function piEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  const extra = [join(homedir(), ".local", "bin"), dirname(nodeBin())];
  env.PATH = [...extra, env.PATH ?? ""].join(":");
  return env;
}

async function output(cmd: string[], timeoutMs = 20_000): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: piEnv() });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, out: out.trim(), err: err.trim() };
}

export async function installedVersion(): Promise<string | undefined> {
  const bin = piBin();
  if (!bin) return undefined;
  const r = await output([bin, "--version"]).catch(() => undefined);
  return r?.code === 0 ? r.out.split("\n").pop()?.trim() : undefined;
}

let latest: { version?: string; error?: string; at: number } | undefined;

export function forgetLatestVersion(): void { latest = undefined; }

/** The newest published Pi, from npm (cached for an hour unless `fresh`). */
export async function latestVersion(fresh = false): Promise<{ version?: string; error?: string }> {
  if (!fresh && latest && Date.now() - latest.at < 60 * 60 * 1000) return latest;
  try {
    const res = await fetch(`https://registry.npmjs.org/${PI_PACKAGE}/latest`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`npm answered HTTP ${res.status}`);
    latest = { version: ((await res.json()) as { version?: string }).version, at: Date.now() };
  } catch (err) {
    latest = { error: `Couldn't check for updates: ${(err as Error).message}`, at: Date.now() };
  }
  return latest;
}

/** -1, 0 or 1 for dotted versions ("1.10.0" > "1.9.2"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export interface PiStatus {
  installed: boolean;
  bin?: string;
  version?: string;
  latest?: string;
  updateAvailable: boolean;
  checkError?: string;
  kind: ReturnType<typeof installKind>;
  agentDir: string;
  node: string;
}

export async function status(fresh = false): Promise<PiStatus> {
  const [version, newest] = await Promise.all([installedVersion(), latestVersion(fresh)]);
  return {
    installed: !!version,
    bin: piBin(),
    version,
    latest: newest.version,
    updateAvailable: !!version && !!newest.version && compareVersions(newest.version, version) > 0,
    checkError: newest.error,
    kind: installKind(),
    agentDir: agentDir(),
    node: nodeBin(),
  };
}
