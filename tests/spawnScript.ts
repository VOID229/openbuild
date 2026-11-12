// Runs a test scenario as `bun -e <script>` in a child process of its own.
//
// Every child gets tests/subprocess-preload.ts: Bun 1.3.8 can stall while it loads typebox's large
// module graph asynchronously in a fresh eval process, and the stalled child then waits for bun:test
// to SIGTERM it at the deadline (exit 143). stdout and stderr are both read while the child runs, so
// a chatty child never blocks on a full pipe either. A child that ends that way logs how long it ran
// and the tail of its stderr, to tell a stall from slow work. The preload marks on that stderr how
// far the child got (OPENBUILD_PRELOAD_TRACE); the marks are left out of the stderr a test sees.
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
    Object.entries({ ...(replace ? env : { ...process.env, ...env }), OPENBUILD_PRELOAD_TRACE: "1" }).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

/** One mark from tests/subprocess-preload.ts, up to and with its newline. */
const PRELOAD_MARK = /\[subprocess-preload\][^\n]*\n/g;

/** Each child from startScript: its script, and when it started. */
const launches = new WeakMap<object, { script: string; started: number }>();

/** The child's result with the preload's marks taken out of its stderr; a SIGTERMed one is logged with them. */
function settle(script: string, raw: ScriptResult, started: number | undefined): ScriptResult {
  reportTerminated(script, raw, started);
  return { ...raw, stderr: raw.stderr.replace(PRELOAD_MARK, "") };
}

/** Diagnostic only: a child SIGTERMed (exit 143) says how long it ran and what it last wrote to stderr. */
function reportTerminated(script: string, result: ScriptResult, started: number | undefined) {
  if (result.code !== 143 && result.signal !== "SIGTERM") return;
  const ran = started === undefined ? "unknown time" : `${((performance.now() - started) / 1000).toFixed(1)} s`;
  const tail = result.stderr.trimEnd().split("\n").slice(-20).join("\n") || "(empty)";
  console.error(`[spawnScript] child ended with exit 143 (SIGTERM) after ${ran}: ${script.trim().split("\n")[0]?.slice(0, 120)}\n--- stderr tail ---\n${tail}\n---`);
}

/** Starts the script with piped output; `env` adds to (or with `replaceEnv`, replaces) process.env. */
export function startScript(script: string, env?: Env, options: ScriptOptions = {}) {
  const child = Bun.spawn(scriptCommand(script), {
    cwd: options.cwd ?? ROOT,
    env: childEnv(env, options.replaceEnv),
    stdin: options.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  launches.set(child, { script, started: performance.now() });
  return child;
}

/** Waits for a child from startScript, draining stdout and stderr together. */
export async function finished(child: ReturnType<typeof startScript>): Promise<ScriptResult> {
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const launch = launches.get(child);
  return settle(launch?.script ?? "", { code, stdout, stderr, signal: child.signalCode }, launch?.started);
}

/** Runs the script to its end; `env` adds to (or with `replaceEnv`, replaces) process.env. */
export function spawnScript(script: string, env?: Env, options?: ScriptOptions): Promise<ScriptResult> {
  return finished(startScript(script, env, options));
}

/** spawnScript, blocking. */
export function spawnScriptSync(script: string, env?: Env, options: Omit<ScriptOptions, "stdin"> = {}): ScriptResult {
  const started = performance.now();
  const child = Bun.spawnSync(scriptCommand(script), {
    cwd: options.cwd ?? ROOT,
    env: childEnv(env, options.replaceEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  return settle(script, { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString(), signal: child.signalCode ?? null }, started);
}
