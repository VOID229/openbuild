export type WhisperConnection = "lan" | "tailscale";

export async function whisperRequest(path: "check" | "transcribe", connection: WhisperConnection, body?: Blob, signal?: AbortSignal) {
  const response = await fetch(`/api/dictation/${path}?connection=${connection}`, {
    method: body ? "POST" : "GET", body, signal,
    headers: body ? { "Content-Type": "audio/wav" } : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Couldn't connect to Whisper.");
  return result as { ok?: boolean; text?: string };
}

/** Mono 16-bit PCM; Whisper expects 16 kHz WAV, regardless of the browser's recording format. */
export function pcmWav(samples: Float32Array, sampleRate = 16000): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const tag = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  tag(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, value * (value < 0 ? 32768 : 32767), true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export async function recordingWav(blob: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const audio = await context.decodeAudioData(await blob.arrayBuffer());
    if (!audio.length || audio.duration > 125) throw new Error("Record up to two minutes at a time.");
    const offline = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000);
    const source = offline.createBufferSource();
    source.buffer = audio;
    source.connect(offline.destination);
    source.start();
    return pcmWav((await offline.startRendering()).getChannelData(0));
  } finally { await context.close(); }
}
