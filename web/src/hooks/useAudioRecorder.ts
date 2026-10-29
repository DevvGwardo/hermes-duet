import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice memos through MediaRecorder.
 *
 * This is the offline-safe path: the browser records an audio blob and the server transcribes it locally, so it works
 * on a plane and on iOS Safari, where the Web Speech API needs a network round trip and is often missing entirely.
 * The microphone is only opened on an explicit tap, and every track is stopped when recording ends or the component
 * goes away.
 */
export type RecorderState = 'idle' | 'recording';

export interface AudioRecorder {
  state: RecorderState;
  seconds: number;
  error: string | null;
  supported: boolean;
  start: () => Promise<boolean>;
  /** Stops and resolves with the recording, or null if it was cancelled or empty. */
  stop: () => Promise<Blob | null>;
  cancel: () => void;
}

/** Safari records mp4/aac, Chrome and Android prefer webm/opus. The first one this browser supports wins. */
const CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

export function recorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {}
  }
  return '';
}

export function useAudioRecorder(): AudioRecorder {
  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  const [state, setState] = useState<RecorderState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const finish = useRef<((blob: Blob | null) => void) | null>(null);
  const discard = useRef(false);

  const teardown = useCallback(() => {
    if (ticker.current) clearInterval(ticker.current);
    ticker.current = null;
    for (const t of stream.current?.getTracks() ?? []) t.stop();
    stream.current = null;
    rec.current = null;
    setState('idle');
    setSeconds(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    setError(null);
    if (!supported) {
      setError('Recording is not available in this browser.');
      return false;
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mimeType = recorderMime();
      const r = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
      stream.current = media;
      rec.current = r;
      chunks.current = [];
      discard.current = false;
      r.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.current.push(e.data);
      };
      r.onstop = () => {
        const wasDiscarded = discard.current;
        const blob = new Blob(chunks.current, { type: r.mimeType || mimeType || 'audio/webm' });
        chunks.current = [];
        teardown();
        finish.current?.(wasDiscarded || blob.size === 0 ? null : blob);
        finish.current = null;
      };
      r.start(1000);
      setState('recording');
      setSeconds(0);
      ticker.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      return true;
    } catch (e: any) {
      teardown();
      setError(
        /denied|not allowed/i.test(String(e?.name ?? e?.message))
          ? 'Microphone access is off. Allow it in Settings → Hermes Duet → Microphone.'
          : `Could not record: ${e?.message ?? e}`,
      );
      return false;
    }
  }, [supported, teardown]);

  const stop = useCallback(async () => {
    const r = rec.current;
    if (!r) return null;
    return new Promise<Blob | null>((resolve) => {
      finish.current = resolve;
      try {
        r.stop();
      } catch {
        teardown();
        resolve(null);
      }
    });
  }, [teardown]);

  const cancel = useCallback(() => {
    discard.current = true;
    const r = rec.current;
    if (!r) return;
    try {
      r.stop();
    } catch {
      teardown();
    }
  }, [teardown]);

  return { state, seconds, error, supported, start, stop, cancel };
}

/** "0:07" for the recording hint. */
export function clockLabel(total: number): string {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}