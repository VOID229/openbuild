interface RemoteAnswer {
  ok: boolean;
  status?: number;
  body?: any;
  error?: string;
  base?: string;
}

/** Call a paired device directly with its token, trying each saved address. */
export async function remoteRequest(device: { urls: string[]; token: string }, path: string, method: "GET" | "POST", signal?: AbortSignal): Promise<RemoteAnswer> {
  // Status reads can race addresses; control requests stay sequential to avoid duplicate actions.
  if (method === "GET" && device.urls.length > 1) {
    const controller = new AbortController();
    try {
      return await Promise.any(device.urls.map(async base => {
        const answer = await remoteRequest({ ...device, urls: [base] }, path, method, controller.signal);
        if (!answer.ok && answer.status !== 401) throw answer;
        return answer;
      }));
    } catch (error) {
      const failures = (error as AggregateError).errors as RemoteAnswer[];
      return failures.find(answer => answer.status) ?? failures[0] ?? { ok: false, error: "no address answered" };
    } finally {
      controller.abort();
    }
  }
  let failure: RemoteAnswer | undefined;
  for (const base of device.urls) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
        method,
        headers: { authorization: `Bearer ${device.token}` },
        signal: AbortSignal.any([AbortSignal.timeout(method === "GET" ? 2000 : 8000), ...(signal ? [signal] : [])]),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 401)
        return { ok: false, status: 401, body, base, error: "the other device no longer trusts this pairing; unpair and pair again" };
      if (res.ok) return { ok: true, status: res.status, body, base };
      failure = { ok: false, status: res.status, body, base, error: `HTTP ${res.status}` };
    } catch (err) {
      failure = { ok: false, error: (err as Error).message, base };
    }
  }
  return failure ?? { ok: false, error: "no address saved for this device" };
}

