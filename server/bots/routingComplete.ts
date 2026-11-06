import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piBin, piEnv } from '../pi/install';
import { routingFlags } from './extensions';

/** Isolated completion retaining the bot's selected provider extensions, with tools denied. */
export async function routingComplete(model: string, system: string, prompt: string, signal: AbortSignal): Promise<string> {
  const bin = piBin();
  if (!bin) throw new Error('Pi is not installed');
  const cwd = await mkdtemp(join(tmpdir(), 'openbuild-routing-'));
  try {
    signal.throwIfAborted();
    const proc = Bun.spawn([bin, '-p', '--no-session', ...routingFlags(), ...(model ? ['--model', model] : []), '--thinking', 'off', '--system-prompt', system, '--append-system-prompt', '', '--', prompt], { cwd, env: piEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const kill = () => proc.kill();
    signal.addEventListener('abort', kill, { once: true });
    try {
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      signal.throwIfAborted();
      if (code) throw new Error(err.slice(-500));
      return out.trim();
    } finally { signal.removeEventListener('abort', kill); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
