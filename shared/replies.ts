// A reply runs on the server apart from the request that started it (server/runs.ts), so closing
// the tab, reloading or a network blip only drops the connection watching it. The app keeps a
// reply's ReplyStream on its message and uses it to find the reply again and pick it back up.
//
// The local server keeps replies in memory. The hosted relay keeps no state between requests, so it
// writes each reply to the sync service (convex/streams.ts) as it goes, encrypted with the reply's
// own key: a random key made by the browser, sent along with the request and kept on the message
// (which syncs end-to-end encrypted). The sync service never sees it.
import type { StreamEvent } from "./types";

export interface ReplyStream {
  /** Random id, which is also what lets someone read or stop the reply. */
  id: string;
  /** Where it runs: "hosted" (the website's relay) or the local server's id (see /api/config). */
  via: string;
  /** Hosted only: the key its saved copy is encrypted with (base64url, 32 bytes). */
  key?: string;
}

/** `via` of a reply Pi is running outside OpenBuild (a terminal, a subagent): there's nothing to pick
 *  back up, the server re-reads it from Pi's transcript as it goes (server/pi/discovery.ts). */
export const EXTERNAL_VIA = "external";

const ID = /^[A-Za-z0-9_-]{16,64}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
export const isStreamId = (id: unknown): id is string => typeof id === "string" && ID.test(id);
/** What a chat request carries about its reply: `{ id, key? }`. */
export const isStreamRef = (s: unknown): s is { id: string; key?: string } =>
  !!s && typeof s === "object" && isStreamId((s as any).id) && ((s as any).key === undefined || (typeof (s as any).key === "string" && KEY.test((s as any).key)));

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

export const newStreamKey = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

const importKey = (key: string) => crypto.subtle.importKey("raw", fromB64url(key), "AES-GCM", false, ["encrypt", "decrypt"]);
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Encrypt a batch of events for the saved copy, bound to the reply's id. */
export async function sealEvents(key: string, id: string, events: StreamEvent[]): Promise<{ iv: ArrayBuffer; data: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`openchat reply ${id}`) }, await importKey(key), enc.encode(JSON.stringify(events)));
  return { iv: iv.buffer, data };
}

export async function openEvents(key: string, id: string, iv: ArrayBuffer, data: ArrayBuffer): Promise<StreamEvent[]> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`openchat reply ${id}`) }, await importKey(key), data);
  return JSON.parse(dec.decode(plain)) as StreamEvent[];
}

/** Parse an NDJSON body into events (blank heartbeat lines are skipped). */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line) as StreamEvent;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) yield JSON.parse(buf) as StreamEvent;
  } finally {
    reader.releaseLock();
  }
}
