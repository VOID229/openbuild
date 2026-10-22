import { useCallback, useEffect, useRef, useState } from "react";
import { recordingWav, whisperRequest, type WhisperConnection } from "./whisper";

type Session = { controller: AbortController; recorder?: MediaRecorder; stream?: MediaStream; timer?: ReturnType<typeof setTimeout> };

export function useWhisperDictation(onText: (text: string) => void, onError: (error: string) => void, connection: WhisperConnection) {
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const handlers = useRef({ onText, onError });
  handlers.current = { onText, onError };
  const session = useRef<Session | null>(null);
  const cancel = useCallback(() => {
    const s = session.current;
    session.current = null;
    s?.controller.abort();
    clearTimeout(s?.timer);
    if (s?.recorder?.state === "recording") s.recorder.stop();
    s?.stream?.getTracks().forEach((track) => track.stop());
    setListening(false);
    setBusy(false);
  }, []);
  const stop = useCallback(() => {
    const s = session.current;
    if (s?.recorder?.state === "recording") s.recorder.stop();
  }, []);
  const start = useCallback(async () => {
    if (session.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError("Microphone recording needs HTTPS (or localhost) and a supported browser.");
      return;
    }
    const s: Session = { controller: new AbortController() };
    session.current = s;
    setBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (s.controller.signal.aborted) { stream.getTracks().forEach((track) => track.stop()); return; }
      s.stream = stream;
      const recorder = new MediaRecorder(stream);
      s.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => { cancel(); handlers.current.onError("Microphone recording failed."); };
      recorder.onstop = async () => {
        clearTimeout(s.timer);
        stream.getTracks().forEach((track) => track.stop());
        if (s.controller.signal.aborted) return;
        setListening(false);
        setBusy(true);
        try {
          const wav = await recordingWav(new Blob(chunks, { type: recorder.mimeType }));
          if (s.controller.signal.aborted) return;
          const result = await whisperRequest("transcribe", connection, wav, s.controller.signal);
          if (!s.controller.signal.aborted) handlers.current.onText(result.text ?? "");
        } catch (error) {
          if (!s.controller.signal.aborted) handlers.current.onError(error instanceof Error ? error.message : "Transcription failed.");
        } finally {
          if (session.current === s) { session.current = null; setBusy(false); }
        }
      };
      recorder.start();
      setBusy(false);
      setListening(true);
      s.timer = setTimeout(stop, 120_000);
    } catch (error) {
      if (!s.controller.signal.aborted) {
        cancel();
        handlers.current.onError(error instanceof Error ? error.message : "Couldn't open the microphone.");
      }
    }
  }, [connection, cancel, stop]);
  useEffect(() => cancel, [cancel, connection]);
  return { listening, busy, start, stop, cancel };
}
