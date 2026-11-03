// Carry an existing HTTP response over a socket. All admission, auth, replay and device routing
// still go through the original HTTP handler. Disconnecting cancels the watcher, never its agent.
import type { ServerWebSocket } from "bun";
import { previewWebsocket } from "./preview";
import { streamPath } from "../shared/streamTransport";

export interface StreamSocketData {
  kind: "stream";
  request: Request;
  base: string;
  authorize: (request: Request) => Response | undefined;
  ctrl: AbortController;
  started: boolean;
  credit?: number;
  resume?: () => void;
}

export const streamWebsocket = {
  async message(ws: ServerWebSocket<StreamSocketData>, message: string | Buffer) {
    if (ws.data.started) {
      try {
        const frame = JSON.parse(String(message));
        if (frame.type !== "credit" || !Number.isInteger(frame.count) || frame.count < 1 || frame.count > 16) throw new Error("Invalid credit");
        ws.data.credit = Math.min(16, (ws.data.credit ?? 0) + frame.count);
        ws.data.resume?.();
      } catch { ws.close(1008, "Only one request per stream"); }
      return;
    }
    ws.data.started = true;
    const { ctrl, request } = ws.data;
    try {
      if (ws.data.authorize(request)) { ws.close(1008, "Sign in again"); return; }
      const input = JSON.parse(String(message));
      if (typeof input.path !== "string" || typeof input.method !== "string" || !streamPath(input.path, input.method) || (input.body !== undefined && typeof input.body !== "string")) {
        ws.close(1008, "Invalid stream request"); return;
      }
      const target = new URL(ws.data.base);
      const path = new URL(input.path, target);
      target.pathname = path.pathname;
      target.search = path.search;
      // Forward only the credentials from the authenticated upgrade. The client cannot choose
      // upstream hosts, credentials or arbitrary request headers.
      const headers = new Headers({ "content-type": "application/json" });
      for (const key of ["cookie", "host", "origin"]) {
        const value = request.headers.get(key);
        if (value) headers.set(key, value);
      }
      const res = await fetch(target, { method: input.method, headers, body: input.method === "POST" ? input.body : undefined, signal: ctrl.signal, redirect: "manual" });
      const responseHeaders: Record<string, string> = {};
      for (const key of ["content-type", "x-openchat-run", "retry-after"]) {
        const value = res.headers.get(key);
        if (value) responseHeaders[key] = value;
      }
      ws.send(JSON.stringify({ type: "headers", status: res.status, headers: responseHeaders }));
      if (res.body) {
        const decoder = new TextDecoder();
        for await (const chunk of res.body) {
          if (ctrl.signal.aborted) return;
          // A window of sixteen 64 KiB frames bounds slow readers while pipelining token
          // updates: streaming speed must not depend on a round trip for every token.
          for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
            if (!ws.data.credit && !ctrl.signal.aborted) await new Promise<void>((resolve) => {
              const resume = () => { ws.data.resume = undefined; ctrl.signal.removeEventListener("abort", resume); resolve(); };
              ws.data.resume = resume;
              ctrl.signal.addEventListener("abort", resume, { once: true });
            });
            if (ctrl.signal.aborted) return;
            ws.data.credit = (ws.data.credit ?? 1) - 1;
            const text = decoder.decode(chunk.subarray(offset, offset + 64 * 1024), { stream: true });
            if (text) ws.send(JSON.stringify({ type: "data", text }));
            else ws.data.credit++;
          }
        }
        const text = decoder.decode();
        if (text) ws.send(JSON.stringify({ type: "data", text }));
      }
      ws.send(JSON.stringify({ type: "end" }));
      ws.close(1000);
    } catch {
      if (!ctrl.signal.aborted) ws.close(1011, "Stream disconnected");
    } finally {
      ctrl.abort();
    }
  },
  close(ws: ServerWebSocket<StreamSocketData>) { ws.data.ctrl.abort(); },
};

type PreviewData = Parameters<typeof previewWebsocket.open>[0]["data"];
type SocketData = StreamSocketData | PreviewData;
const isStream = (ws: ServerWebSocket<SocketData>): ws is ServerWebSocket<StreamSocketData> => "kind" in ws.data && ws.data.kind === "stream";
export const appWebsocket = {
  // Large image attachments keep the HTTP handler's existing request size limit.
  maxPayloadLength: 128 * 1024 * 1024,
  idleTimeout: 120,
  open(ws: ServerWebSocket<SocketData>) { if (!isStream(ws)) previewWebsocket.open(ws as ServerWebSocket<PreviewData>); },
  message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
    if (isStream(ws)) void streamWebsocket.message(ws, message);
    else previewWebsocket.message(ws as ServerWebSocket<PreviewData>, message);
  },
  close(ws: ServerWebSocket<SocketData>) {
    if (isStream(ws)) streamWebsocket.close(ws);
    else previewWebsocket.close(ws as ServerWebSocket<PreviewData>);
  },
};
