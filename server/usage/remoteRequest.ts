const TIMEOUT_MS = 10_000;
const ADDRESS_TIMEOUT_MS = 4_000;

/** A single deadline covers every address AND reading the response body. */
export async function requestUsage<T>(urls: string[], path: string, token: string, timeoutMs = TIMEOUT_MS, init: RequestInit = {}, addressTimeoutMs = ADDRESS_TIMEOUT_MS): Promise<T> {
  // Never replay a mutation automatically, even with an operation ID. A caller may explicitly
  // retry the same operation after inspecting an uncertain response.
  const readOnly = ["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase());
  const deadline = Date.now() + timeoutMs;
  let last = "it's unreachable";
  for (const base of urls) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(addressTimeoutMs, remaining)),
      });
      if (res.status === 404 || res.status === 403)
        throw Object.assign(new Error("its OpenBuild doesn't report usage yet. Update it there."), { final: true });
      if (!res.ok) {
        const body = await res.json().catch(() => undefined);
        last = body?.error ? String(body.error) : `it answered HTTP ${res.status}`;
        if (!readOnly) throw Object.assign(new Error(last), { final: true });
        continue;
      }
      return await res.json() as T;
    } catch (err) {
      if ((err as { final?: boolean }).final) throw err;
      if (!readOnly) throw new Error("Reset response unconfirmed. Retry only the same operation ID.");
      last = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError"
        ? "it didn't answer in time" : "it's unreachable";
    }
  }
  throw new Error(last);
}
