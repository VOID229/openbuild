// Runs a test scenario as `bun -e <script>` in a child process of its own.
//
// Every child gets tests/subprocess-preload.ts: Bun 1.3.8 can stall while it loads typebox's large
// module graph asynchronously in a fresh eval process, and the stalled child then waits for bun:test
// to SIGTERM it at the deadline (exit 143). stdout and stderr are both read while the child runs, so
// a chatty child never blocks on a full pipe either.
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");
export const SUBPROCESS_PRELOAD = join(import.meta.dir, "subprocess-preload.ts");

type Env = Record<string, string | undefined>;

export type ScriptOptions = {
  /** Working directory; the repository root by default, so `./server/…` imports resolve. */
  cwd?: string;
  /** Replaces the inherited environment instead of adding to it. */
  replaceEnv?: boolean;
  stdin?: "ignore" | "pipe" | "inherit";
};

export type ScriptResult = { code: number; stdout: string; stderr: string; signal: string | null };

/** The command line for a preloaded `bun -e`, for a child the test drives itself. */
export function scriptCommand(script: string): string[] {
  return [process.execPath, "--preload", SUBPROCESS_PRELOAD, "-e", script];
}

function childEnv(env: Env | undefined, replace: boolean | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(replace ? { ...env } : { ...process.env, ...env }).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

/** Starts the script with piped output; `env` adds to (or with `replaceEnv`, replaces) process.env. */
export function startScript(script: string, env?: Env, options: ScriptOptions = {}) {
  return Bun.spawn(scriptCommand(script), {
    cwd: options.cwd ?? ROOT,
    env: childEnv(env, options.replaceEnv),
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Waits for a child from startScript, draining stdout and stderr together. */
export async function finished(child: ReturnType<typeof startScript>): Promise<ScriptResult> {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr, signal: child.signalCode };
}

/** Runs the script to its end; `env` adds to (or with `replaceEnv`, replaces) process.env. */
export function spawnScript(script: string, env?: Env, options?: ScriptOptions): Promise<ScriptResult> {
  return finished(startScript(script, env, options));
}

/** spawnScript, blocking. */
export function spawnScriptSync(script: string, env?: Env, options: Omit<ScriptOptions, "stdin"> = {}): ScriptResult {
  const child = Bun.spawnSync(scriptCommand(script), {
    cwd: options.cwd ?? ROOT,
    env: childEnv(env, options.replaceEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString(), signal: child.signalCode ?? null };
}
