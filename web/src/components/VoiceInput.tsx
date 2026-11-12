import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment } from '../../../shared/types';
import { api, HttpError } from '../api';
import {
  audioFileExtension,
  clockLabel,
  insertTranscript,
  shouldDiscardTake,
  useAudioRecorder,
  type TextSelection,
} from '../hooks/useAudioRecorder';
import { Icon } from '../ui';

export { insertTranscript, shouldDiscardTake, type TextSelection };

const HOLD_THRESHOLD_MS = 250;
const SLIDE_CANCEL_PX = 60;
const SLIDE_LOCK_PX = 50;
const DEFAULT_MAX_RECORD_SECONDS = 180;

function getSpeechRecognitionCtor(): any {
  if (typeof window === 'undefined') return undefined;
  return (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
}

export type VoiceMode = 'idle' | 'holding' | 'locked' | 'listening' | 'transcribing';
export type HoldFeedback = 'none' | 'cancel' | 'lock';

export interface FailedVoiceTake {
  blob: Blob;
  mimeType: string;
  objectUrl: string;
  attachment?: Attachment;
  error: string;
  retrying: boolean;
}

function TrashIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M9 7V4.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 .5.5V7M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/** Live 60fps <canvas> audio level meter driven directly from AnalyserNode with zero React state updates. */
export function VoiceMeter({
  analyser,
  active,
  className,
}: {
  analyser: AnalyserNode | null;
  active: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const binCount = analyser?.frequencyBinCount ?? 0;
    const freqData = binCount > 0 ? new Uint8Array(binCount) : null;
    const fftSize = analyser?.fftSize ?? 0;
    const timeData = fftSize > 0 ? new Uint8Array(fftSize) : null;

    let raf = 0;
    let alive = true;
    const startMs = performance.now();

    const draw = () => {
      if (!alive) return;
      const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
      const w = canvas.clientWidth || 120;
      const h = canvas.clientHeight || 26;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      let hasFreq = false;
      if (analyser && freqData) {
        try {
          analyser.getByteFrequencyData(freqData);
          for (let i = 0; i < Math.min(freqData.length, 32); i++) {
            if (freqData[i] > 0) {
              hasFreq = true;
              break;
            }
          }
        } catch {}
      }

      let timeRms = 0;
      if (!hasFreq && analyser && timeData) {
        try {
          analyser.getByteTimeDomainData(timeData);
          let sum = 0;
          for (let i = 0; i < timeData.length; i++) {
            const c = (timeData[i] - 128) / 128;
            sum += c * c;
          }
          timeRms = Math.min(1, Math.sqrt(sum / timeData.length) * 3.2);
        } catch {}
      }

      const barW = 3;
      const gap = 3;
      const count = Math.max(8, Math.floor((w + gap) / (barW + gap)));
      const usedW = count * barW + (count - 1) * gap;
      const offsetX = Math.max(0, (w - usedW) / 2);
      const t = (performance.now() - startMs) / 1000;

      for (let i = 0; i < count; i++) {
        let level = 0.14;
        if (hasFreq && freqData) {
          // Speech fundamentals & formants sit mostly in the lower ~40% of FFT bins.
          const maxBin = Math.max(8, Math.floor(freqData.length * 0.45));
          const idx = Math.min(maxBin - 1, 1 + Math.floor((i / count) * (maxBin - 1)));
          level = Math.max(0.14, freqData[idx] / 255);
        } else if (timeRms > 0.02) {
          const wave = 0.55 + 0.45 * Math.sin(t * 9 + i * 0.65);
          level = Math.max(0.14, Math.min(1, timeRms * wave));
        } else if (!analyser) {
          level = 0.18 + 0.18 * (0.5 + 0.5 * Math.sin(t * 6 + i * 0.7));
        }

        const barH = Math.max(3, Math.round(level * (h - 4)));
        const x = offsetX + i * (barW + gap);
        const y = Math.round((h - barH) / 2);
        ctx.fillStyle = level > 0.45 ? '#ffd700' : 'rgba(255, 191, 0, 0.72)';
        ctx.fillRect(x, y, barW, barH);
      }

      ctx.restore();
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [analyser, active]);

  return <canvas ref={canvasRef} className={className ? `voice-meter ${className}` : 'voice-meter'} aria-hidden="true" />;
}

export interface UseVoiceDictationOptions {
  text: string;
  setText: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  hidden?: boolean;
  maxRecordSeconds?: number;
  allowAttachmentFallback?: boolean;
  canAttachMore?: () => boolean;
  onAttach?: (attachment: Attachment) => void;
}

export function useVoiceDictation({
  text,
  setText,
  textareaRef,
  disabled = false,
  hidden = false,
  maxRecordSeconds = DEFAULT_MAX_RECORD_SECONDS,
  allowAttachmentFallback = false,
  canAttachMore,
  onAttach,
}: UseVoiceDictationOptions) {
  const recorder = useAudioRecorder();
  const SpeechRecognitionCtor = getSpeechRecognitionCtor();
  const insecureOrigin = typeof window !== 'undefined' && !window.isSecureContext;
  const voiceVisible = recorder.supported || !!SpeechRecognitionCtor || insecureOrigin;

  const [mode, setMode] = useState<VoiceMode>('idle');
  const [holdFeedback, setHoldFeedback] = useState<HoldFeedback>('none');
  const [interimText, setInterimText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [failedTake, setFailedTake] = useState<FailedVoiceTake | null>(null);

  const modeRef = useRef<VoiceMode>('idle');
  modeRef.current = mode;
  const holdFeedbackRef = useRef<HoldFeedback>('none');
  holdFeedbackRef.current = holdFeedback;

  const gestureRef = useRef<'idle' | 'pending' | 'holding' | 'locked' | 'cancelled'>('idle');
  const pointerIdRef = useRef<number | null>(null);
  const startCoordsRef = useRef({ x: 0, y: 0 });
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const usedPointerRef = useRef(false);
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectionSnapshotRef = useRef<TextSelection | null>(null);
  const draftAtStartRef = useRef('');
  const textRef = useRef(text);
  textRef.current = text;

  const speechRecRef = useRef<any>(null);
  const speechAbortedRef = useRef(false);
  const finalizedIndicesRef = useRef<Set<number>>(new Set());
  const failedTakeUrlRef = useRef<string | null>(null);

  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 3200);
  }, []);

  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const replaceFailedTake = useCallback((next: FailedVoiceTake | null) => {
    if (failedTakeUrlRef.current && failedTakeUrlRef.current !== next?.objectUrl) {
      try {
        URL.revokeObjectURL(failedTakeUrlRef.current);
      } catch {}
    }
    failedTakeUrlRef.current = next?.objectUrl ?? null;
    setFailedTake(next);
  }, []);

  const snapshotSelection = useCallback(() => {
    const el = textareaRef.current;
    if (el && typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
      selectionSnapshotRef.current = { start: el.selectionStart, end: el.selectionEnd };
    }
  }, [textareaRef]);

  const applyTranscriptToDraft = useCallback(
    (transcript: string) => {
      const clean = transcript.trim();
      if (!clean) return;
      let nextCursor = 0;
      setText((cur) => {
        const el = textareaRef.current;
        const focused = typeof document !== 'undefined' && el && document.activeElement === el;
        let sel: TextSelection | null = null;
        if (focused && el && typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
          sel = { start: el.selectionStart, end: el.selectionEnd };
        } else if (cur === draftAtStartRef.current && selectionSnapshotRef.current) {
          sel = selectionSnapshotRef.current;
        }
        const res = insertTranscript(cur, clean, sel);
        nextCursor = res.cursor;
        selectionSnapshotRef.current = { start: nextCursor, end: nextCursor };
        draftAtStartRef.current = res.text;
        return res.text;
      });
      requestAnimationFrame(() => {
        if (modeRef.current !== 'idle') return;
        const el = textareaRef.current;
        if (el) {
          el.focus();
          try {
            el.setSelectionRange(nextCursor, nextCursor);
          } catch {}
        }
      });
    },
    [setText, textareaRef],
  );

  const stopSpeechRecognition = useCallback((abort = false) => {
    const r = speechRecRef.current;
    if (!r) return;
    speechAbortedRef.current = abort;
    try {
      if (abort && typeof r.abort === 'function') r.abort();
      else r.stop?.();
    } catch {}
  }, []);

  const cancel = useCallback(() => {
    clearHoldTimer();
    gestureRef.current = 'cancelled';
    pointerIdRef.current = null;
    setHoldFeedback('none');
    setInterimText('');
    if (modeRef.current === 'listening' || speechRecRef.current) {
      stopSpeechRecognition(true);
      speechRecRef.current = null;
      setMode('idle');
      setStatusMessage('Dictation cancelled.');
      return;
    }
    if (recorder.state === 'recording' || startingRef.current || modeRef.current === 'holding' || modeRef.current === 'locked') {
      recorder.cancel();
      setMode('idle');
      setStatusMessage('Recording cancelled.');
    }
  }, [clearHoldTimer, recorder, stopSpeechRecognition]);

  const confirm = useCallback(async () => {
    clearHoldTimer();
    pointerIdRef.current = null;
    setHoldFeedback('none');

    if (modeRef.current === 'listening' || speechRecRef.current) {
      stopSpeechRecognition(false);
      setMode('idle');
      setInterimText('');
      setStatusMessage('Dictation stopped.');
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }

    if (stoppingRef.current) return;

    // If getUserMedia is still awaiting permission/hardware, cancel it cleanly instead of letting it start invisibly.
    if (startingRef.current || recorder.state !== 'recording') {
      if (startingRef.current || modeRef.current === 'holding' || modeRef.current === 'locked') {
        cancel();
      }
      return;
    }

    stoppingRef.current = true;
    gestureRef.current = 'idle';
    try {
      const result = await recorder.stop();
      if (!result) {
        setMode('idle');
        return;
      }

      const discardReason = shouldDiscardTake(result);
      if (discardReason === 'too-short') {
        setMode('idle');
        showNotice('Hold a bit longer to record.');
        setStatusMessage('Recording too short.');
        return;
      }
      if (discardReason === 'silent') {
        setMode('idle');
        showNotice("Didn't hear any speech.");
        setStatusMessage('No speech detected.');
        return;
      }

      setMode('transcribing');
      setError(null);
      setNotice(null);
      setStatusMessage('Transcribing audio.');

      try {
        const res = await api.transcribe(result.blob, result.mimeType);
        const said = res.text.trim();
        if (res.error && !said) {
          const objectUrl = URL.createObjectURL(result.blob);
          replaceFailedTake({
            blob: result.blob,
            mimeType: result.mimeType,
            objectUrl,
            attachment: res.attachment,
            error: res.error,
            retrying: false,
          });
          setError(null);
          setStatusMessage('Transcription failed. You can retry, play back, or discard.');
          return;
        }
        if (!said) {
          const objectUrl = URL.createObjectURL(result.blob);
          replaceFailedTake({
            blob: result.blob,
            mimeType: result.mimeType,
            objectUrl,
            attachment: res.attachment,
            error: "Couldn't make out any words.",
            retrying: false,
          });
          setError(null);
          setStatusMessage('No words detected. You can retry, play back, or discard.');
          return;
        }
        // Dictation succeeded: insert text and clean up temporary upload on the server.
        if (res.error) setError(res.error);
        applyTranscriptToDraft(said);
        setStatusMessage('Transcription inserted.');
        void api.deleteUpload(res.attachment.id).catch(() => {});
      } catch (e: any) {
        const objectUrl = URL.createObjectURL(result.blob);
        replaceFailedTake({
          blob: result.blob,
          mimeType: result.mimeType,
          objectUrl,
          error: e?.message ?? 'Could not transcribe that memo.',
          retrying: false,
        });
        setError(null);
        setStatusMessage('Transcription failed. Saved locally for retry.');
      } finally {
        setMode('idle');
      }
    } finally {
      stoppingRef.current = false;
    }
  }, [applyTranscriptToDraft, cancel, clearHoldTimer, recorder, replaceFailedTake, showNotice, stopSpeechRecognition, textareaRef]);

  const startSpeechFallback = useCallback(() => {
    if (!SpeechRecognitionCtor) {
      setError(
        insecureOrigin
          ? 'Microphone recording requires HTTPS (or localhost). Open Hermes Duet over HTTPS or Tailscale.'
          : 'Voice input is not supported in this browser.',
      );
      return false;
    }
    setError(null);
    setNotice(null);
    snapshotSelection();
    draftAtStartRef.current = textRef.current;
    finalizedIndicesRef.current = new Set();
    speechAbortedRef.current = false;
    setInterimText('');

    try {
      const r = new SpeechRecognitionCtor();
      r.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
      r.interimResults = true;
      r.continuous = true;
      r.onresult = (e: any) => {
        let newlyFinal = '';
        let currentInterim = '';
        const startIdx = typeof e.resultIndex === 'number' ? e.resultIndex : 0;
        for (let i = startIdx; i < e.results.length; i++) {
          const result = e.results[i];
          const transcript = result?.[0]?.transcript ?? '';
          if (result?.isFinal) {
            if (!finalizedIndicesRef.current.has(i)) {
              finalizedIndicesRef.current.add(i);
              newlyFinal += transcript;
            }
          } else {
            currentInterim += transcript;
          }
        }
        if (newlyFinal.trim()) {
          applyTranscriptToDraft(newlyFinal);
        }
        setInterimText(currentInterim.trim());
      };
      r.onend = () => {
        if (speechRecRef.current === r) speechRecRef.current = null;
        setInterimText('');
        setMode((m) => (m === 'listening' ? 'idle' : m));
      };
      r.onerror = (e: any) => {
        if (speechRecRef.current === r) speechRecRef.current = null;
        setInterimText('');
        setMode('idle');
        const code = String(e?.error ?? '');
        if (speechAbortedRef.current || code === 'aborted') return;
        if (code === 'not-allowed' || code === 'service-not-allowed') {
          setError(
            insecureOrigin
              ? 'Microphone is blocked on insecure HTTP. Open Hermes Duet over HTTPS or localhost.'
              : 'Microphone access is off. Allow it in your browser settings.',
          );
        } else if (code === 'no-speech') {
          showNotice("Didn't hear any speech.");
        } else if (code === 'audio-capture') {
          setError('No microphone was found.');
        } else if (code === 'network') {
          setError('Browser dictation needs a network connection.');
        } else {
          setError(`Dictation failed (${code || 'unknown error'}).`);
        }
      };
      speechRecRef.current = r;
      r.start();
      setMode('listening');
      setStatusMessage('Listening for speech.');
      return true;
    } catch (e: any) {
      speechRecRef.current = null;
      setMode('idle');
      setError(e?.message ?? 'Could not start speech recognition.');
      return false;
    }
  }, [SpeechRecognitionCtor, applyTranscriptToDraft, insecureOrigin, showNotice, snapshotSelection]);

  const startRecorderSession = useCallback(
    async (initialMode: 'pending' | 'locked') => {
      if (disabled || startingRef.current || stoppingRef.current || modeRef.current === 'transcribing') return false;
      setError(null);
      setNotice(null);

      if (!recorder.supported) {
        gestureRef.current = 'idle';
        return startSpeechFallback();
      }

      snapshotSelection();
      draftAtStartRef.current = textRef.current;
      startingRef.current = true;
      gestureRef.current = initialMode;
      if (initialMode === 'locked') {
        setMode('locked');
        setStatusMessage('Recording started.');
      }

      const ok = await recorder.start();
      startingRef.current = false;
      if (!ok) {
        clearHoldTimer();
        gestureRef.current = 'idle';
        setMode('idle');
        setHoldFeedback('none');
        return false;
      }
      if ((gestureRef.current as string) === 'cancelled' || (gestureRef.current as string) === 'idle') {
        recorder.cancel();
        setMode('idle');
        return false;
      }
      return true;
    },
    [clearHoldTimer, disabled, recorder, snapshotSelection, startSpeechFallback],
  );

  const toggle = useCallback(() => {
    if (disabled || modeRef.current === 'transcribing') return;
    if (modeRef.current === 'locked' || modeRef.current === 'holding' || modeRef.current === 'listening') {
      void confirm();
      return;
    }
    void startRecorderSession('locked');
  }, [confirm, disabled, startRecorderSession]);

  const retryFailed = useCallback(async () => {
    const take = failedTake;
    if (!take || take.retrying) return;
    replaceFailedTake({ ...take, retrying: true });
    setError(null);
    setStatusMessage('Retrying transcription.');
    try {
      let res: { text: string; attachment: Attachment; error?: string };
      if (take.attachment?.id) {
        try {
          res = await api.retryTranscribe(take.attachment.id);
        } catch (err) {
          if (err instanceof HttpError && err.status === 404) {
            res = await api.transcribe(take.blob, take.mimeType);
          } else {
            throw err;
          }
        }
      } else {
        res = await api.transcribe(take.blob, take.mimeType);
      }

      const said = res.text.trim();
      if (res.error && !said) {
        replaceFailedTake({
          ...take,
          attachment: res.attachment,
          error: res.error,
          retrying: false,
        });
        setStatusMessage('Retry failed.');
        return;
      }
      if (!said) {
        replaceFailedTake({
          ...take,
          attachment: res.attachment,
          error: "Couldn't make out any words.",
          retrying: false,
        });
        setStatusMessage('No words detected.');
        return;
      }
      if (res.error) setError(res.error);
      applyTranscriptToDraft(said);
      replaceFailedTake(null);
      setStatusMessage('Transcription inserted.');
      void api.deleteUpload(res.attachment.id).catch(() => {});
    } catch (e: any) {
      replaceFailedTake({
        ...take,
        error: e?.message ?? 'Could not transcribe that memo.',
        retrying: false,
      });
      setStatusMessage('Retry failed.');
    }
  }, [applyTranscriptToDraft, failedTake, replaceFailedTake]);

  const attachFailed = useCallback(async () => {
    const take = failedTake;
    if (!take || take.retrying || !allowAttachmentFallback || !onAttach) return;
    if (canAttachMore && !canAttachMore()) {
      setError('Up to six files per message.');
      return;
    }
    if (take.attachment) {
      onAttach(take.attachment);
      replaceFailedTake(null);
      setError(null);
      setStatusMessage('Audio clip attached.');
      return;
    }
    replaceFailedTake({ ...take, retrying: true });
    try {
      const ext = audioFileExtension(take.mimeType);
      const file = new File([take.blob], `voice-memo.${ext}`, { type: take.mimeType });
      const { attachment } = await api.upload(file);
      if (canAttachMore && !canAttachMore()) {
        void api.deleteUpload(attachment.id).catch(() => {});
        replaceFailedTake({ ...take, attachment, retrying: false });
        setError('Up to six files per message.');
        return;
      }
      onAttach(attachment);
      replaceFailedTake(null);
      setError(null);
      setStatusMessage('Audio clip attached.');
    } catch (e: any) {
      replaceFailedTake({
        ...take,
        error: e?.message ?? 'Could not upload that audio clip.',
        retrying: false,
      });
    }
  }, [allowAttachmentFallback, canAttachMore, failedTake, onAttach, replaceFailedTake]);

  const discardFailed = useCallback(() => {
    const take = failedTake;
    if (!take) return;
    replaceFailedTake(null);
    setError(null);
    setStatusMessage('Recording discarded.');
    if (take.attachment?.id) {
      void api.deleteUpload(take.attachment.id).catch(() => {});
    }
  }, [failedTake, replaceFailedTake]);

  // Cancel active mic/speech when hidden (tab switch) or page becomes hidden.
  useEffect(() => {
    if (hidden) cancel();
  }, [hidden, cancel]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    const onVis = () => {
      if (document.visibilityState === 'hidden' && speechRecRef.current) {
        cancel();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [cancel]);

  // Safety cap so a forgotten recording doesn't fill disk or hold battery.
  useEffect(() => {
    if (recorder.state !== 'recording' || recorder.seconds < maxRecordSeconds) return;
    void confirm();
  }, [recorder.seconds, recorder.state, maxRecordSeconds, confirm]);

  // Keep UI synchronized if MediaRecorder ends unexpectedly (track disconnect / error).
  useEffect(() => {
    if (
      (mode === 'holding' || mode === 'locked') &&
      recorder.state === 'idle' &&
      !startingRef.current &&
      !stoppingRef.current &&
      gestureRef.current !== 'pending'
    ) {
      clearHoldTimer();
      gestureRef.current = 'idle';
      setHoldFeedback('none');
      setMode('idle');
    }
  }, [clearHoldTimer, mode, recorder.state]);

  // Cleanup SpeechRecognition, timers, and object URLs on unmount.
  useEffect(
    () => () => {
      clearHoldTimer();
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      if (speechRecRef.current) {
        speechAbortedRef.current = true;
        try {
          speechRecRef.current.abort?.() ?? speechRecRef.current.stop?.();
        } catch {}
        speechRecRef.current = null;
      }
      if (failedTakeUrlRef.current) {
        try {
          URL.revokeObjectURL(failedTakeUrlRef.current);
        } catch {}
        failedTakeUrlRef.current = null;
      }
    },
    [clearHoldTimer],
  );

  const micButtonProps = {
    type: 'button' as const,
    disabled: disabled || mode === 'transcribing',
    'aria-label':
      mode === 'holding' || mode === 'locked'
        ? 'Stop recording and transcribe'
        : mode === 'listening'
          ? 'Stop dictation'
          : recorder.supported
            ? 'Voice memo (tap to toggle, hold to talk)'
            : 'Dictate',
    'aria-pressed': mode === 'holding' || mode === 'locked' || mode === 'listening',
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      usedPointerRef.current = true;
      if (disabled || modeRef.current === 'transcribing') return;
      if (modeRef.current === 'locked' || modeRef.current === 'listening') {
        void confirm();
        return;
      }
      if (!recorder.supported) {
        void startSpeechFallback();
        return;
      }
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {}
      pointerIdRef.current = e.pointerId;
      startCoordsRef.current = { x: e.clientX, y: e.clientY };
      setHoldFeedback('none');
      clearHoldTimer();
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        if (gestureRef.current === 'pending') {
          gestureRef.current = 'holding';
          setMode('holding');
          setStatusMessage('Recording. Release to transcribe, slide left to cancel, slide up to lock.');
        }
      }, HOLD_THRESHOLD_MS);
      void startRecorderSession('pending');
    },
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (pointerIdRef.current !== e.pointerId) return;
      if (gestureRef.current !== 'pending' && gestureRef.current !== 'holding') return;
      const dx = e.clientX - startCoordsRef.current.x;
      const dy = e.clientY - startCoordsRef.current.y;
      if (dx < -SLIDE_CANCEL_PX) {
        if (holdFeedbackRef.current !== 'cancel') setHoldFeedback('cancel');
      } else if (dy < -SLIDE_LOCK_PX) {
        clearHoldTimer();
        gestureRef.current = 'locked';
        pointerIdRef.current = null;
        setHoldFeedback('none');
        setMode('locked');
        setStatusMessage('Recording locked.');
        try {
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        } catch {}
      } else if (holdFeedbackRef.current !== 'none') {
        setHoldFeedback('none');
      }
    },
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (pointerIdRef.current !== e.pointerId) return;
      clearHoldTimer();
      pointerIdRef.current = null;
      try {
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        }
      } catch {}
      const dx = e.clientX - startCoordsRef.current.x;
      if (gestureRef.current === 'locked') {
        setHoldFeedback('none');
        return;
      }
      if (holdFeedbackRef.current === 'cancel' || dx < -SLIDE_CANCEL_PX) {
        cancel();
        return;
      }
      if (gestureRef.current === 'pending') {
        gestureRef.current = 'locked';
        setHoldFeedback('none');
        setMode('locked');
        setStatusMessage('Recording locked. Tap check to transcribe.');
        return;
      }
      if (gestureRef.current === 'holding') {
        void confirm();
      }
    },
    onPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (pointerIdRef.current !== e.pointerId) return;
      clearHoldTimer();
      pointerIdRef.current = null;
      if (gestureRef.current === 'pending' || gestureRef.current === 'holding') {
        cancel();
      }
    },
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => {
      if (usedPointerRef.current && e.detail !== 0) {
        usedPointerRef.current = false;
        return;
      }
      usedPointerRef.current = false;
      toggle();
    },
  };

  return {
    voiceVisible,
    mode,
    holdFeedback,
    interimText,
    seconds: recorder.seconds,
    analyser: recorder.analyser,
    isRecording: mode === 'holding' || mode === 'locked' || recorder.state === 'recording',
    isListening: mode === 'listening',
    isActive: mode === 'holding' || mode === 'locked' || mode === 'listening',
    isTranscribing: mode === 'transcribing',
    notice,
    error: error || recorder.error,
    statusMessage,
    failedTake,
    micButtonProps,
    snapshotSelection,
    confirm,
    cancel,
    toggle,
    retryFailed,
    attachFailed,
    discardFailed,
    clearError: () => setError(null),
  };
}

export function VoiceHoldHud({
  seconds,
  analyser,
  holdFeedback,
}: {
  seconds: number;
  analyser: AnalyserNode | null;
  holdFeedback: HoldFeedback;
}) {
  return (
    <div className={`voice-hold-hud ${holdFeedback !== 'none' ? `is-${holdFeedback}` : ''}`} aria-hidden="true">
      <span className="voice-rec-timer">
        <span className="rec-dot" />
        <span className="voice-clock">{clockLabel(seconds)}</span>
      </span>
      <VoiceMeter analyser={analyser} active className="voice-hold-meter" />
      <span className="voice-hold-hint">
        {holdFeedback === 'cancel' ? 'Release to cancel' : holdFeedback === 'lock' ? 'Release to lock' : '← Cancel · ↑ Lock'}
      </span>
    </div>
  );
}

export function VoiceLockedBar({
  mode,
  seconds,
  analyser,
  interimText,
  onCancel,
  onConfirm,
}: {
  mode: VoiceMode;
  seconds: number;
  analyser: AnalyserNode | null;
  interimText?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isSpeech = mode === 'listening';
  return (
    <div className="voice-locked-bar" role="region" aria-label={isSpeech ? 'Dictation controls' : 'Recording controls'}>
      <button type="button" className="icon-btn voice-cancel-btn" onClick={onCancel} aria-label="Discard recording" title="Discard (Esc)">
        <TrashIcon size={18} />
      </button>
      <span className="voice-rec-timer">
        <span className="rec-dot" aria-hidden="true" />
        <span className="voice-clock">{isSpeech ? 'Listening' : clockLabel(seconds)}</span>
      </span>
      {isSpeech ? (
        <span className="voice-interim" title={interimText || 'Listening…'}>
          {interimText || 'Speak now…'}
        </span>
      ) : (
        <VoiceMeter analyser={analyser} active />
      )}
      <button
        type="button"
        className="icon-btn voice-confirm-btn"
        onClick={onConfirm}
        aria-label={isSpeech ? 'Finish dictation' : 'Stop and transcribe'}
        title="Transcribe (↵)"
      >
        <Icon.check size={19} />
      </button>
    </div>
  );
}

export function VoiceRetryCard({
  take,
  allowAttach,
  canAttach,
  onRetry,
  onAttach,
  onDiscard,
}: {
  take: FailedVoiceTake;
  allowAttach?: boolean;
  canAttach?: boolean;
  onRetry: () => void;
  onAttach?: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="voice-retry" role="alert">
      <div className="voice-retry-head">
        <span className="voice-retry-msg">{take.error}</span>
        <button type="button" className="icon-btn voice-retry-close" onClick={onDiscard} aria-label="Discard failed recording" title="Discard">
          <Icon.close size={15} />
        </button>
      </div>
      <div className="voice-retry-body">
        <audio controls preload="metadata" src={take.objectUrl} />
        <div className="voice-retry-actions">
          <button type="button" className="hint-action" disabled={take.retrying} onClick={onRetry}>
            {take.retrying ? 'Retrying…' : 'Retry'}
          </button>
          {allowAttach && onAttach && (
            <button
              type="button"
              className="hint-action muted-action"
              disabled={take.retrying || canAttach === false}
              onClick={onAttach}
              title={canAttach === false ? 'Up to six files per message.' : 'Attach raw audio clip'}
            >
              Attach clip
            </button>
          )}
          <button type="button" className="hint-action muted-action" disabled={take.retrying} onClick={onDiscard}>
            Discard
          </button>
        </div>
      </div>
    </div>
  );
}

export function VoiceHints({
  isTranscribing,
  notice,
  error,
  statusMessage,
}: {
  isTranscribing: boolean;
  notice: string | null;
  error: string | null;
  statusMessage: string;
}) {
  return (
    <>
      <div className="sr-only" aria-live="polite">
        {statusMessage}
      </div>
      {isTranscribing && (
        <div className="composer-hint" aria-live="polite">
          Transcribing on this machine…
        </div>
      )}
      {notice && !isTranscribing && (
        <div className="composer-hint" aria-live="polite">
          {notice}
        </div>
      )}
      {error && (
        <div className="composer-hint error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
