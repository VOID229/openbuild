// WebSockets do not occupy the browser's small HTTP/1 connection pool. Keep each response's
// existing byte stream and recovery semantics; never repeat a POST after it was sent on a socket.
import { streamPath } from "../../shared/streamTransport";

export function streamFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  if (typeof window === "undefined" || !window.location?.href || typeof WebSocket === "undefined" || typeof input !== "string") return fetch(input, init);
  const url = new URL(input, window.location.href);
  const method = (init.method ?? "GET").toUpperCase();
  if (url.origin !== window.location.origin || !streamPath(url.pathname + url.search, method) || (init.body !== undefined && typeof init.body !== "string")) return fetch(input, init);
  const signal = init.signal;
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<Response>((resolve, reject) => {
    const target = new URL("/api/stream", window.location.href);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    try { socket = new WebSocket(target); } catch { resolve(fetch(url, init)); return; }
    let sent = false;
    let received = false;
    let finished = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    let credits = 16;
    const grant = () => {
      if (!finished && credits && (controller?.desiredSize ?? 0) > 0 && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "credit", count: credits }));
        credits = 0;
      }
    };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (received) controller?.error(error); else reject(error);
      socket.close();
    };
    const abort = () => fail(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    // Compatibility with older servers/proxies is safe only before sending a request.
    const fallback = () => {
      if (finished) return;
      if (sent) { fail(new Error("Stream disconnected")); return; }
      finished = true;
      cleanup();
      socket.close();
      resolve(fetch(url, init));
    };
    const timer = setTimeout(fallback, 3000);
    signal?.addEventListener("abort", abort, { once: true });
    socket.onopen = () => {
      if (finished) { socket.close(); return; }
      clearTimeout(timer);
      sent = true;
      socket.send(JSON.stringify({ path: url.pathname + url.search, method, body: init.body }));
    };
    socket.onmessage = (event) => {
      if (finished) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === "headers" && !received) {
          received = true;
          const body = new ReadableStream<Uint8Array>({
            start(c) { controller = c; grant(); },
            pull() { grant(); },
            cancel() { if (!finished) { finished = true; cleanup(); socket.close(); } },
          }, { highWaterMark: 256 * 1024, size: (chunk) => chunk?.byteLength ?? 0 });
          // Response forbids bodies for these statuses.
          resolve(new Response([204, 205, 304].includes(message.status) ? null : body, { status: message.status, headers: message.headers }));
        } else if (message.type === "data" && received && typeof message.text === "string") {
          controller!.enqueue(encoder.encode(message.text));
          credits++;
          grant();
        } else if (message.type === "end" && received) {
          finished = true;
          cleanup();
          controller!.close();
          socket.close();
        } else throw new Error("Invalid stream response");
      } catch (error) { fail(error); }
    };
    socket.onerror = fallback;
    socket.onclose = fallback;
  });
}
