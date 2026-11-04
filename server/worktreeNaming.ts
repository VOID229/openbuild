// Only the one-time temporary branch may be renamed. The checkout's path never changes.
const pending = new Set<string>();
export const temporaryWorktreeBranch = () => `openbuild/tmp-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

export async function renameTemporaryBranch(cwd: string, expected: string, name: string): Promise<string | null> {
  if (!/^openbuild\/tmp-[a-f0-9]{12}$/.test(expected) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 48 || pending.has(cwd)) return null;
  pending.add(cwd);
  const git = async (...args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const timer = setTimeout(() => proc.kill(), 30_000);
    const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { out: out.trim(), code };
  };
  try {
    if ((await git("branch", "--show-current")).out !== expected) return null;
    // A published branch may already have a PR. Leave its identity alone.
    if ((await git("for-each-ref", "--format=%(upstream)", `refs/heads/${expected}`)).out) return null;
    if ((await git("for-each-ref", "--format=%(refname)", `refs/remotes/*/${expected}`)).out) return null;
    const branch = `openbuild/${name}`;
    // No force: collisions keep the temporary branch rather than replacing existing work.
    return (await git("branch", "-m", expected, branch)).code === 0 ? branch : null;
  } finally {
    pending.delete(cwd);
  }
}
