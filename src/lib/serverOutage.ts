import { create } from "zustand";

/** True while the server has stayed unreachable past a brief blip. LocalAccess keeps this current. */
export const useServerOutage = create(() => ({ outage: false }));

/**
 * Fired on window when the server answers again after LocalAccess found it unreachable (a restart,
 * a dropped tunnel). Whatever is waiting out the outage on a backoff (reply streams, OpenBots, the
 * outbox, the thread list) goes at once instead of at its next retry.
 */
export const SERVER_BACK = "openbuild:server-back";

let probe: (() => void) | undefined;
/** LocalAccess's probe of the server, for suspectOutage. */
export function setOutageProbe(fn: (() => void) | undefined) {
  probe = fn;
}
/** A long-lived connection to the server dropped: have LocalAccess look now rather than at its next poll. */
export function suspectOutage() {
  probe?.();
}

/** Wait `ms`, or less if the server comes back (or `signal` aborts) first. */
export function waitForServer(ms: number, signal?: AbortSignal): Promise<void> {
  const target = typeof window === "undefined" ? undefined : window;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      target?.removeEventListener(SERVER_BACK, done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    target?.addEventListener(SERVER_BACK, done);
    signal?.addEventListener("abort", done, { once: true });
  });
}
