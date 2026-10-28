export interface PairCandidate {
  base: string;
  name: string;
  machine?: string;
  deviceId?: string;
}

/** GET /api/pair/info. Keep retries for transient failures, but make them cancellable. */
export async function probePairing(base: string, signal?: AbortSignal): Promise<PairCandidate | undefined> {
  const url = base.replace(/\/$/, "");
  for (let attempt = 0; attempt < 2 && !signal?.aborted; attempt++) {
    try {
      const timeout = AbortSignal.timeout(900);
      const res = await fetch(`${url}/api/pair/info`, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.ok) {
        const info = (await res.json()) as { pending?: boolean; name?: string; machine?: string; deviceId?: string; claimed?: boolean };
        if (!info?.pending || info.claimed) return undefined;
        return { base: url, name: info.name || base, machine: info.machine, deviceId: info.deviceId };
      }
      await res.body?.cancel();
    } catch {}
    if (attempt === 0 && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 150);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }
  return undefined;
}

type Probe = (base: string, signal: AbortSignal) => Promise<PairCandidate | undefined>;

/** Yield responsive hosts immediately, without waiting for a batch or the whole subnet.
 * A rolling, bounded pool keeps sockets under control. Closing the iterator cancels probes.
 */
export async function* discoverPairing(
  bases: string[],
  probe: Probe = probePairing,
  concurrency = 64,
): AsyncGenerator<PairCandidate> {
  const unique = [...new Set(bases)];
  const controller = new AbortController();
  const pending = new Map<number, Promise<{ index: number; candidate?: PairCandidate }>>();
  const seen = new Set<string>();
  let next = 0;
  const fill = () => {
    while (next < unique.length && pending.size < Math.max(1, concurrency)) {
      const index = next++;
      pending.set(index, Promise.resolve().then(() => probe(unique[index]!, controller.signal))
        .then((candidate) => ({ index, candidate }), () => ({ index })));
    }
  };
  try {
    fill();
    while (pending.size) {
      const { index, candidate } = await Promise.race(pending.values());
      pending.delete(index);
      fill();
      if (!candidate) continue;
      const key = candidate.deviceId || candidate.base;
      if (seen.has(key)) continue;
      seen.add(key);
      yield candidate;
    }
  } finally {
    controller.abort();
  }
}
