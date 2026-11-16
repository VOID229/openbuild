// Variables the user's own shell sets up. The server runs as a service, so it never read the user's
// shell profile: a key exported from ~/.bashrc or ~/.zshrc (the way fx's custom providers are set up)
// is in every terminal but not here. This asks the user's login shell for just the named variables.
import { homedir } from "node:os";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MARK = "__openbuild_shell_env__";

/**
 * The named variables as an interactive login shell of the user's sets them. Names it leaves unset or
 * empty are missing from the result. Never throws: a shell that fails or takes too long gives {}.
 */
export async function shellVariables(names: string[], timeoutMs = 8000): Promise<Record<string, string>> {
  const wanted = [...new Set(names)].filter((n) => NAME.test(n));
  if (!wanted.length || process.platform === "win32") return {};
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  // Profile scripts may print a banner: everything before the marker is theirs. "$NAME" reads the
  // same in sh, bash, zsh and fish.
  const script = `printf '\\0%s\\0' ${MARK}; printf '%s\\0' ${wanted.map((n) => `"$${n}"`).join(" ")}`;
  try {
    const proc = Bun.spawn([shell, "-i", "-l", "-c", script], { cwd: homedir(), stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, TERM: "dumb" } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A profile can leave a background job holding stdout open after the shell is gone: stop waiting then too.
    const out = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise<string>((resolve) => (timer = setTimeout(() => (proc.kill(), resolve("")), timeoutMs))),
    ]);
    clearTimeout(timer);
    const parts = out.split("\0");
    const at = parts.lastIndexOf(MARK);
    if (at < 0) return {};
    const values: Record<string, string> = {};
    wanted.forEach((name, i) => {
      const value = parts[at + 1 + i];
      if (value) values[name] = value;
    });
    return values;
  } catch {
    return {};
  }
}
