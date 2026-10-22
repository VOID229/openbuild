import { afterEach, describe, expect, test } from "bun:test";
import { checkWhisper, transcribe, whisperUrl } from "../server/dictation";
import { pcmWav } from "../src/lib/whisper";

const originalFetch = globalThis.fetch;
const lan = process.env.OPENBUILD_WHISPER_LAN_URL;
const tail = process.env.OPENBUILD_WHISPER_TAILSCALE_URL;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (lan === undefined) delete process.env.OPENBUILD_WHISPER_LAN_URL; else process.env.OPENBUILD_WHISPER_LAN_URL = lan;
  if (tail === undefined) delete process.env.OPENBUILD_WHISPER_TAILSCALE_URL; else process.env.OPENBUILD_WHISPER_TAILSCALE_URL = tail;
});
const request = (body: Blob, connection = "lan") => new Request(`http://localhost/api/dictation/transcribe?connection=${connection}`, { method: "POST", body, headers: { "Content-Type": "audio/wav" } });

describe("private dictation", () => {
  test("destinations are operator configured, never supplied by the browser", () => {
    delete process.env.OPENBUILD_WHISPER_TAILSCALE_URL;
    expect(() => whisperUrl("tailscale")).toThrow("isn't configured");
    expect(() => whisperUrl("https://attacker.example")).toThrow();
    process.env.OPENBUILD_WHISPER_LAN_URL = "file:///etc/passwd";
    expect(() => whisperUrl("lan")).toThrow("Invalid");
  });
  test("PCM WAV has a valid header and clamped signed samples", async () => {
    const view = new DataView(await pcmWav(new Float32Array([-2, 0, 2])).arrayBuffer());
    expect(view.byteLength).toBe(50);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44, true)).toBe(-32768);
    expect(view.getInt16(48, true)).toBe(32767);
  });
  test("checks health through the selected endpoint", async () => {
    process.env.OPENBUILD_WHISPER_TAILSCALE_URL = "http://100.64.0.1:8179";
    globalThis.fetch = (async (url: any) => {
      expect(String(url)).toBe("http://100.64.0.1:8179/health");
      return Response.json({ status: "ok" });
    }) as typeof fetch;
    expect((await checkWhisper(new Request("http://localhost/api/dictation/check?connection=tailscale"))).status).toBe(200);
  });
  test("forwards WAV as multipart and returns only transcript", async () => {
    process.env.OPENBUILD_WHISPER_LAN_URL = "http://127.0.0.1:8178";
    globalThis.fetch = (async (url: any, options: any) => {
      expect(String(url)).toBe("http://127.0.0.1:8178/inference");
      expect(options.redirect).toBe("error");
      expect(options.body.get("file").type).toBe("audio/wav");
      expect(options.body.get("response_format")).toBe("json");
      return Response.json({ text: " hello ", secret: "not forwarded" });
    }) as typeof fetch;
    expect(await (await transcribe(request(pcmWav(new Float32Array(100))))).json()).toEqual({ text: "hello" });
  });
  test("rejects oversized audio and resets the concurrency guard", async () => {
    process.env.OPENBUILD_WHISPER_LAN_URL = "http://127.0.0.1:8178";
    expect((await transcribe(request(new Blob([new Uint8Array(8 * 1024 * 1024 + 1)])))).status).toBe(413);
    expect((await transcribe(request(new Blob([])))).status).toBe(400);
  });
  test("rejects invalid upstream transcripts", async () => {
    process.env.OPENBUILD_WHISPER_LAN_URL = "http://127.0.0.1:8178";
    globalThis.fetch = (async () => Response.json({ text: 42 })) as unknown as typeof fetch;
    expect((await transcribe(request(pcmWav(new Float32Array(100))))).status).toBe(502);
  });
});
