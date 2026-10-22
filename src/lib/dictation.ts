import { useCallback, useEffect, useRef, useState } from "react";
import { useWhisperDictation } from "./useWhisperDictation";
import type { Settings } from "./types";

/**
 * Dictation via the Web Speech API. A web page can't open the OS dictation UI itself, but in Safari
 * (macOS / iOS) `SpeechRecognition` is backed by Apple's own speech engine — the same one behind
 * system dictation — so this is the closest thing to it. Chrome and Edge use their own services.
 */

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface RecognitionEvent {
  readonly results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

const Ctor: RecognitionCtor | undefined =
  typeof window === "undefined"
    ? undefined
    : ((window as unknown as { SpeechRecognition?: RecognitionCtor }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition);

export const dictationSupported = Boolean(Ctor);

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone access was denied. Allow it in your browser settings to dictate.",
  "service-not-allowed": "Dictation isn't available here. On a Mac, check that Dictation is on in System Settings › Keyboard.",
  "audio-capture": "No microphone found.",
  network: "Dictation needs a network connection in this browser.",
};

/**
 * `onText(transcript)` is called with everything heard so far in the current session (interim
 * results included), so the caller can splice it after whatever was in the box when it started.
 */
export function useDictation(onText: (transcript: string) => void, onError: (message: string) => void, options?: Settings["dictation"]) {
  const whisper = useWhisperDictation(onText, onError, options?.connection ?? "lan");
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);
  const handlers = useRef({ onText, onError });
  handlers.current = { onText, onError };

  const stop = useCallback(() => rec.current?.stop(), []);

  const start = useCallback(() => {
    if (!Ctor || rec.current) return;
    const r = new Ctor();
    r.lang = navigator.language;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let transcript = "";
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i]![0].transcript;
      handlers.current.onText(transcript);
    };
    r.onerror = (e) => {
      if (e.error !== "aborted" && e.error !== "no-speech") handlers.current.onError(ERRORS[e.error] ?? "Dictation stopped unexpectedly.");
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      rec.current = null;
      handlers.current.onError("Couldn't start dictation.");
    }
  }, []);

  const cancel = useCallback(() => { rec.current?.abort(); rec.current = null; setListening(false); }, []);
  useEffect(() => { cancel(); whisper.cancel(); }, [options?.enabled]);
  useEffect(() => () => rec.current?.abort(), []);

  return options?.enabled ? whisper : { listening, start, stop, cancel, busy: false };
}
