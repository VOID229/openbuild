// Only operator-configured destinations: the browser cannot turn this into an arbitrary proxy.
const MAX_BYTES = 8 * 1024 * 1024;
let active = false;
export function whisperUrl(connection: string): URL {
  const raw = connection === "lan" ? process.env.OPENBUILD_WHISPER_LAN_URL : connection === "tailscale" ? process.env.OPENBUILD_WHISPER_TAILSCALE_URL : undefined;
  if (!raw) throw new Error(`Whisper ${connection === "tailscale" ? "Tailscale" : "LAN"} endpoint isn't configured on this server.`);
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid Whisper server URL.");
  return url;
}
const failure = (error: unknown, status = 502) => Response.json({ error: error instanceof Error ? error.message : "Whisper request failed." }, { status });

export async function checkWhisper(req: Request): Promise<Response> {
  try {
    const base = whisperUrl(new URL(req.url).searchParams.get("connection") ?? "lan");
    const response = await fetch(new URL("health", base.href.replace(/\/?$/, "/")), { signal: AbortSignal.any([req.signal, AbortSignal.timeout(5000)]), redirect: "error" });
    if (!response.ok || (await response.json() as { status?: string }).status !== "ok") throw new Error("Whisper isn't ready.");
    return Response.json({ ok: true });
  } catch (error) { return failure(error); }
}

export async function transcribe(req: Request): Promise<Response> {
  if (active) return failure(new Error("Whisper is busy. Try again shortly."), 429);
  active = true;
  try {
    const base = whisperUrl(new URL(req.url).searchParams.get("connection") ?? "lan");
    if (req.headers.get("content-type") !== "audio/wav") return failure(new Error("Expected WAV audio."), 415);
    if (!req.body) return failure(new Error("Missing audio."), 400);
    const chunks: Uint8Array[] = [];
    const reader = req.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          void reader.cancel().catch(() => {});
          return failure(new Error("Recording is too large."), 413);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (size < 44) return failure(new Error("Recording is empty."), 400);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "audio/wav" }), "dictation.wav");
    form.append("response_format", "json");
    const response = await fetch(new URL("inference", base.href.replace(/\/?$/, "/")), {
      method: "POST", body: form, redirect: "error", signal: AbortSignal.any([req.signal, AbortSignal.timeout(90_000)]),
    });
    if (!response.ok) throw new Error(`Whisper returned HTTP ${response.status}.`);
    const result = await response.json() as { text?: unknown };
    if (typeof result.text !== "string") throw new Error("Whisper returned an invalid transcript.");
    return Response.json({ text: result.text.trim() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
  finally { active = false; }
}
