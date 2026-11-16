// Variables the user's own shell sets up. The server runs as a service, so it never read the user's
// shell profile: a key exported from ~/.bashrc or ~/.zshrc (the way fx's custom providers are set up)
// is in every terminal but not here. This asks the user's login shell for just the named variables.
import { homedir } from "node:os";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MARK = "__openbuild_shell_env__";

/** More than a profile's banner and the values could ever be: a stream past this is something else writing. */
const MAX_OUTPUT = 1 << 20;
/** How long to keep reading once the shell is gone: its own output is in the pipe by then. */
const AFTER_EXIT = 250;

/**
 * The named variables as an interactive login shell of the user's sets them. Names it leaves unset or
 * empty are missing from the result. Never throws: a shell that fails or takes too long gives {}.
 *
 * The shell runs in a process group of its own, and the whole group is killed once the lookup ends:
 * a profile that starts a background job (which inherits stdout) can't keep the read going or
 * outlive the lookup.
 */
export async function shellVariables(names: string[], timeoutMs = 8000): Promise<Record<string, string>> {
  const wanted = [...new Set(names)].filter((n) => NAME.test(n));
  if (!wanted.length || process.platform === "win32") return {};
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  // Profile scripts may print a banner: everything before the marker is theirs. "$NAME" reads the
  // same in sh, bash, zsh and fish.
  const script = `printf '\\0%s\\0' ${MARK}; printf '%s\\0' ${wanted.map((n) => `"$${n}"`).join(" ")}`;
  const spawn = () => Bun.spawn([shell, "-i", "-l", "-c", script], { cwd: homedir(), stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, TERM: "dumb" }, detached: true });
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn();
  } catch {
    // No shell to run (SHELL names something that isn't there).
    return {};
  }
  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const deadline = setTimeout(stop, timeoutMs);
  void proc.exited.then(() => setTimeout(stop, AFTER_EXIT).unref());
  const read = (async () => {
    while (size <= MAX_OUTPUT) {
      const { done, value } = await reader.read();
      if (done) return;
      chunks.push(value);
      size += value.length;
    }
  })().catch(() => {});
  await Promise.race([read, stopped]);
  clearTimeout(deadline);
  // Nothing the profile started outlives the lookup, and nothing it left writing is read any further.
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
  proc.kill("SIGKILL");
  void reader.cancel().catch(() => {});

  const parts = Buffer.concat(chunks).toString("utf8").split("\0");
  const at = parts.lastIndexOf(MARK);
  if (at < 0) return {};
  const values: Record<string, string> = {};
  wanted.forEach((name, i) => {
    const value = parts[at + 1 + i];
    if (value) values[name] = value;
  });
  return values;
}
