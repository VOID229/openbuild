const TIMEOUT_MS = 10_000;
const ADDRESS_TIMEOUT_MS = 4_000;

/** A single deadline covers every address AND reading the response body. */
export async function requestUsage<T>(urls: string[], path: string, token: string, timeoutMs = TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "it's unreachable";
  for (const base of urls) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(Math.min(ADDRESS_TIMEOUT_MS, remaining)),
      });
      if (res.status === 404 || res.status === 403)
        throw Object.assign(new Error("its OpenBuild doesn't report usage yet. Update it there."), { final: true });
      if (!res.ok) {
        last = `it answered HTTP ${res.status}`;
        continue;
      }
      return await res.json() as T;
    } catch (err) {
      if ((err as { final?: boolean }).final) throw err;
      last = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError"
        ? "it didn't answer in time" : "it's unreachable";
    }
  }
  throw new Error(last);
}
