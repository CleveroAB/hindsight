'use client';

// Voice dictation for a composer — shared by the empty-state composer (a new
// strategy) and the chat's refine input. Wraps the browser's Web Speech API
// (SpeechRecognition): finalized phrases are handed to the caller to append to
// the draft text, interim (still-being-recognized) words are exposed for a
// live preview line. Everything runs in the browser; no audio leaves the
// machine except via the browser vendor's own recognition service.
//
// Experimental: SpeechRecognition ships in Chrome/Edge/Safari but not Firefox,
// so `supported` gates rendering the mic button at all.

import { useCallback, useEffect, useRef, useState } from 'react';

// lib.dom.d.ts still doesn't declare SpeechRecognition (it's webkit-prefixed
// in every browser that has it), so declare the slice of it we use.
interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Join a finalized transcript chunk onto existing draft text. */
export function appendTranscript(existing: string, chunk: string): string {
  const text = chunk.trim();
  if (!text) return existing;
  if (!existing) return text;
  return /\s$/.test(existing) ? existing + text : `${existing} ${text}`;
}

export interface UseDictation {
  /** False until mount, and on browsers without SpeechRecognition (Firefox). */
  supported: boolean;
  listening: boolean;
  /** Words recognized so far but not yet finalized — show as a live preview. */
  interim: string;
  /** Human-readable failure (mic permission denied, etc.), or null. */
  error: string | null;
  toggle: () => void;
  stop: () => void;
}

export function useDictation(
  onFinal: (text: string) => void,
  disabled = false,
): UseDictation {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  // Keep the latest callback without making toggle/stop unstable.
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  // Detected post-mount so the server render (no `window`) matches hydration.
  useEffect(() => {
    setSupported(getRecognitionCtor() !== null);
  }, []);

  const stop = useCallback(() => {
    recRef.current?.stop();
    setListening(false);
    setInterim('');
  }, []);

  const toggle = useCallback(() => {
    if (recRef.current) {
      stop();
      return;
    }
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const result = e.results[i];
        if (result.isFinal) onFinalRef.current(result[0].transcript);
        else interimText += result[0].transcript;
      }
      setInterim(interimText.trim());
    };
    rec.onerror = (e) => {
      // 'no-speech' and 'aborted' are routine (silence timeout, our own stop);
      // surfacing them as errors would just be noise.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError('Microphone access was denied. Allow it in the browser to dictate.');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        setError('Dictation stopped unexpectedly. Tap the mic to try again.');
      }
    };
    // Fires after stop(), errors, and the browser's own silence timeout alike —
    // the one reliable place to leave the listening state.
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      setInterim('');
    };

    setError(null);
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      recRef.current = null;
      setError('Couldn’t start dictation in this browser.');
    }
  }, [stop]);

  // A composer that gets disabled mid-dictation (run started, agent blocked)
  // shouldn't keep the mic hot.
  useEffect(() => {
    if (disabled) stop();
  }, [disabled, stop]);

  useEffect(
    () => () => {
      recRef.current?.abort();
      recRef.current = null;
    },
    [],
  );

  return { supported, listening, interim, error, toggle, stop };
}
