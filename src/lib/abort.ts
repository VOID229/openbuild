import { streamFetch } from "./streamTransport";
/** Stop waiting even when an operation (workspace setup, a stalled transport) ignores cancellation. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const finish = (fn: () => void) => {
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    // Attach both handlers even if already aborted: a late rejection must still be observed.
    promise.then((value) => finish(() => resolve(value)), (err) => finish(() => reject(err)));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** How long a request waits for the server's answer (its headers) before giving up. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** A bound on receiving response headers, not the lifetime of a streaming response body. */
export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, ms = REQUEST_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, ctrl.signal]) : ctrl.signal;
  const timer = setTimeout(() => ctrl.abort(new DOMException("The server didn't respond in time", "TimeoutError")), ms);
  try {
    signal.throwIfAborted();
    return await abortable(streamFetch(input, { ...init, signal }), signal);
  } finally {
    clearTimeout(timer);
  }
}
