import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { isIOS } from '../platform';

/**
 * Voice memos through MediaRecorder + Web Audio metering.
 *
 * This is the offline-safe path: the browser records an audio blob and the server transcribes it locally, so it works
 * on a plane and on iOS Safari, where the Web Speech API needs a network round trip and is often missing entirely.
 * The microphone is only opened on an explicit user gesture, and every track, timer, AudioContext, and animation
 * frame is torn down on stop, cancel, unmount, or page hide.
 */
type RecorderState = 'idle' | 'recording';

interface RecordingResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
  peakRms: number;
  hadSpeech: boolean;
}

interface AudioRecorder {
  state: RecorderState;
  seconds: number;
  error: string | null;
  supported: boolean;
  analyser: AnalyserNode | null;
  analyserRef: RefObject<AnalyserNode | null>;
  start: () => Promise<boolean>;
  /** Stops and resolves with the recording metrics + blob, or null if it was cancelled or empty. */
  stop: () => Promise<RecordingResult | null>;
  cancel: () => void;
}

/** Prefer Opus/WebM where supported, falling back cleanly to AAC/MP4 for Safari/iOS. */
export const RECORDER_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

/** Minimum normalized RMS (~ -36 dBFS) to count as speech rather than silence/ambient hiss. */
const SPEECH_RMS_THRESHOLD = 0.015;
const MIN_TAKE_DURATION_MS = 300;

export interface TextSelection {
  start: number;
  end: number;
}

/**
 * Insert transcribed text cleanly at the saved cursor/selection, adding smart spacing so surrounding words
 * never fuse together and existing draft edits are preserved.
 */
export function insertTranscript(
  draft: string,
  transcript: string,
  selection?: TextSelection | null,
): { text: string; cursor: number } {
  const clean = transcript.trim();
  if (!clean) {
    const end = selection ? Math.max(0, Math.min(draft.length, selection.end)) : draft.length;
    return { text: draft, cursor: end };
  }
  if (!selection) {
    if (!draft.trim()) return { text: clean, cursor: clean.length };
    const prefix = draft.replace(/\s*$/, ' ');
    return { text: prefix + clean, cursor: prefix.length + clean.length };
  }
  const start = Math.max(0, Math.min(draft.length, selection.start));
  const end = Math.max(start, Math.min(draft.length, selection.end));
  if (!draft.trim() && start === 0 && end === draft.length) {
    return { text: clean, cursor: clean.length };
  }
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const needLead = before.length > 0 && !/\s$/.test(before);
  const needTrail = after.length > 0 && !/^\s/.test(after) && !/^[.,!?;:)\]]/.test(after);
  const lead = needLead ? ' ' : '';
  const trail = needTrail ? ' ' : '';
  const text = `${before}${lead}${clean}${trail}${after}`;
  const cursor = before.length + lead.length + clean.length;
  return { text, cursor };
}

/** Guard accidental <300ms taps and pure-silence takes before uploading to STT. */
export function shouldDiscardTake(result: RecordingResult): 'too-short' | 'silent' | null {
  if (result.durationMs < MIN_TAKE_DURATION_MS) return 'too-short';
  if (!result.hadSpeech && result.peakRms < SPEECH_RMS_THRESHOLD) return 'silent';
  return null;
}

export function recorderMime(): string {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  for (const type of RECORDER_MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {}
  }
  return '';
}

function isSafariOrIOS(nav?: { userAgent?: string; platform?: string; maxTouchPoints?: number }): boolean {
  if (!nav) return false;
  if (isIOS(nav)) return true;
  const ua = nav.userAgent ?? '';
  return /AppleWebKit/i.test(ua) && !/Chrome|CriOS|Chromium|Edg|Firefox|FxiOS|OPR/i.test(ua);
}

export function resolveRecordedMime(
  recorderType?: string | null,
  chosenMime?: string | null,
  chunkType?: string | null,
  nav?: { userAgent?: string; platform?: string; maxTouchPoints?: number },
): string {
  const explicit = [recorderType, chosenMime, chunkType].find((v) => typeof v === 'string' && v.trim().length > 0);
  if (explicit) return explicit.trim();
  const targetNav = nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  return isSafariOrIOS(targetNav) ? 'audio/mp4' : 'audio/webm';
}

export function audioFileExtension(mime: string): string {
  const lower = mime.toLowerCase();
  if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return 'm4a';
  if (lower.includes('ogg') || lower.includes('oga')) return 'ogg';
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  return 'webm';
}

export function computeTimeDomainRms(samples: Uint8Array): number {
  if (!samples.length) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const centered = (samples[i] - 128) / 128;
    sumSq += centered * centered;
  }
  return Math.sqrt(sumSq / samples.length);
}

function isRecorderSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

interface RecorderEngineCallbacks {
  onState?: (state: RecorderState) => void;
  onSeconds?: (seconds: number | ((prev: number) => number)) => void;
  onError?: (error: string | null) => void;
  onAnalyser?: (analyser: AnalyserNode | null) => void;
}

interface RecorderEngine {
  readonly analyser: AnalyserNode | null;
  readonly isActiveOrStarting: boolean;
  start: () => Promise<boolean>;
  stop: () => Promise<RecordingResult | null>;
  cancel: () => void;
  revive: () => void;
  dispose: () => void;
}

export function createRecorderEngine(cb: RecorderEngineCallbacks = {}): RecorderEngine {
  let rec: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: Blob[] = [];
  let ticker: ReturnType<typeof setInterval> | null = null;
  let stopSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  let rafId: number | null = null;
  let finish: ((result: RecordingResult | null) => void) | null = null;
  let discard = false;
  let disposed = false;
  let starting = false;
  let cancelledStart = false;

  let audioCtx: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let analyserNode: AnalyserNode | null = null;
  let timeDomainBuf: Uint8Array<ArrayBuffer> | null = null;
  let hasMeter = false;
  let startedAt = 0;
  let peakRms = 0;
  let noiseFloor = Infinity;
  let hadSpeech = false;

  function sampleAnalyser() {
    if (!analyserNode || !timeDomainBuf) return;
    try {
      analyserNode.getByteTimeDomainData(timeDomainBuf);
    } catch {
      return;
    }
    const rms = computeTimeDomainRms(timeDomainBuf);
    if (rms > peakRms) peakRms = rms;
    if (rms < SPEECH_RMS_THRESHOLD * 2) {
      noiseFloor = noiseFloor === Infinity ? rms : Math.min(noiseFloor * 0.995 + rms * 0.005, rms + 0.01);
    }
    const floor = noiseFloor === Infinity ? 0 : Math.min(noiseFloor, 0.04);
    const gate = Math.max(SPEECH_RMS_THRESHOLD, floor * 1.6);
    if (rms >= gate) hadSpeech = true;
  }

  function stopMeterLoop() {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId);
    }
    rafId = null;
  }

  function teardown() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    if (stopSafetyTimer) clearTimeout(stopSafetyTimer);
    stopSafetyTimer = null;
    stopMeterLoop();

    if (rec) {
      rec.ondataavailable = null;
      rec.onstop = null;
      rec.onerror = null;
    }
    rec = null;

    for (const t of stream?.getTracks() ?? []) {
      t.onended = null;
      try {
        t.stop();
      } catch {}
    }
    stream = null;

    try {
      sourceNode?.disconnect();
    } catch {}
    sourceNode = null;
    try {
      analyserNode?.disconnect();
    } catch {}
    analyserNode = null;
    timeDomainBuf = null;
    hasMeter = false;

    const ctx = audioCtx;
    audioCtx = null;
    if (ctx && typeof ctx.close === 'function') {
      try {
        void ctx.close().catch(() => {});
      } catch {}
    }

    if (!disposed) {
      cb.onAnalyser?.(null);
      cb.onState?.('idle');
      cb.onSeconds?.(0);
    }
  }

  async function start(): Promise<boolean> {
    if (starting || rec || disposed) return false;
    cb.onError?.(null);
    if (!isRecorderSupported()) {
      cb.onError?.(
        typeof window !== 'undefined' && !window.isSecureContext
          ? 'Microphone recording requires HTTPS (or localhost). Open Hermes Duet over HTTPS or Tailscale.'
          : 'Recording is not available in this browser.',
      );
      return false;
    }

    starting = true;
    cancelledStart = false;

    // Synchronously instantiate & resume AudioContext inside the user gesture BEFORE awaiting getUserMedia,
    // otherwise iOS Safari breaks the gesture chain and leaves AudioContext suspended.
    const AudioCtx =
      (typeof window !== 'undefined' && (window.AudioContext || (window as any).webkitAudioContext)) ||
      (globalThis as any).AudioContext;
    let ctx: AudioContext | null = null;
    if (AudioCtx) {
      try {
        ctx = new AudioCtx();
        audioCtx = ctx;
        if (ctx && ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          void ctx.resume().catch(() => {});
        }
      } catch {
        ctx = null;
        audioCtx = null;
      }
    }

    try {
      const media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (disposed || cancelledStart) {
        for (const t of media.getTracks()) {
          try {
            t.stop();
          } catch {}
        }
        teardown();
        return false;
      }

      const chosenMime = recorderMime();
      const r = new MediaRecorder(media, chosenMime ? { mimeType: chosenMime } : undefined);
      stream = media;
      rec = r;
      chunks = [];
      discard = false;
      peakRms = 0;
      noiseFloor = Infinity;
      hadSpeech = false;

      if (ctx && typeof ctx.createMediaStreamSource === 'function' && typeof ctx.createAnalyser === 'function') {
        try {
          if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
            void ctx.resume().catch(() => {});
          }
          const src = ctx.createMediaStreamSource(media);
          const node = ctx.createAnalyser();
          node.fftSize = 256;
          node.smoothingTimeConstant = 0.75;
          src.connect(node);
          sourceNode = src;
          analyserNode = node;
          timeDomainBuf = new Uint8Array(node.fftSize);
          hasMeter = true;
          if (!disposed) cb.onAnalyser?.(node);
        } catch {
          hasMeter = false;
        }
      } else {
        hasMeter = false;
      }

      r.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      r.onstop = () => {
        const wasDiscarded = discard;
        sampleAnalyser();
        const firstChunkType = chunks[0]?.type;
        const resolvedMime = resolveRecordedMime(r.mimeType, chosenMime, firstChunkType);
        const blob = new Blob(chunks, { type: resolvedMime });
        const durationMs = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;
        const finalPeakRms = peakRms;
        const finalHadSpeech = hasMeter ? hadSpeech : true;
        chunks = [];
        const pendingFinish = finish;
        finish = null;
        teardown();
        if (wasDiscarded || blob.size === 0) {
          pendingFinish?.(null);
        } else {
          pendingFinish?.({ blob, mimeType: resolvedMime, durationMs, peakRms: finalPeakRms, hadSpeech: finalHadSpeech });
        }
      };

      r.onerror = (ev: any) => {
        const msg = ev?.error?.message || ev?.message || 'Recording interrupted.';
        chunks = [];
        const pendingFinish = finish;
        finish = null;
        teardown();
        if (!disposed) cb.onError?.(msg);
        pendingFinish?.(null);
      };

      const onTrackEnded = () => {
        if (rec !== r) return;
        if (r.state === 'recording') {
          try {
            r.stop();
            return;
          } catch {}
        }
        const pendingFinish = finish;
        finish = null;
        teardown();
        if (!disposed) cb.onError?.('Microphone disconnected during recording.');
        pendingFinish?.(null);
      };
      for (const t of media.getTracks()) {
        t.onended = onTrackEnded;
      }

      try {
        r.start(1000);
      } catch (startErr) {
        teardown();
        throw startErr;
      }

      startedAt = Date.now();
      cb.onState?.('recording');
      cb.onSeconds?.(0);
      ticker = setInterval(() => cb.onSeconds?.((s) => s + 1), 1000);

      if (hasMeter && typeof requestAnimationFrame === 'function') {
        const loop = () => {
          if (rec !== r) return;
          sampleAnalyser();
          rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);
      }
      return true;
    } catch (e: any) {
      teardown();
      if (!disposed) {
        cb.onError?.(
          /denied|not allowed/i.test(String(e?.name ?? e?.message))
            ? 'Microphone access is off. Allow it in Settings → Hermes Duet → Microphone.'
            : `Could not record: ${e?.message ?? e}`,
        );
      }
      return false;
    } finally {
      starting = false;
    }
  }

  async function stop(): Promise<RecordingResult | null> {
    const r = rec;
    if (!r || finish) return null;
    if (r.state === 'inactive') {
      teardown();
      return null;
    }
    sampleAnalyser();
    return new Promise<RecordingResult | null>((resolve) => {
      finish = resolve;
      stopSafetyTimer = setTimeout(() => {
        if (finish !== resolve) return;
        finish = null;
        teardown();
        resolve(null);
      }, 1500);
      try {
        r.stop();
      } catch {
        if (stopSafetyTimer) clearTimeout(stopSafetyTimer);
        stopSafetyTimer = null;
        finish = null;
        teardown();
        resolve(null);
      }
    });
  }

  function cancel() {
    discard = true;
    cancelledStart = true;
    const r = rec;
    if (!r) {
      if (!starting) teardown();
      return;
    }
    if (r.state === 'inactive') {
      const pending = finish;
      finish = null;
      teardown();
      pending?.(null);
      return;
    }
    try {
      r.stop();
    } catch {
      const pending = finish;
      finish = null;
      teardown();
      pending?.(null);
    }
  }

  function revive() {
    disposed = false;
    cancelledStart = false;
    discard = false;
  }

  function dispose() {
    disposed = true;
    cancelledStart = true;
    discard = true;
    const pending = finish;
    finish = null;
    pending?.(null);
    teardown();
  }

  return {
    get analyser() {
      return analyserNode;
    },
    get isActiveOrStarting() {
      return !!rec || starting;
    },
    start,
    stop,
    cancel,
    revive,
    dispose,
  };
}

export function useAudioRecorder(): AudioRecorder {
  const supported = isRecorderSupported();
  const [state, setState] = useState<RecorderState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const engineRef = useRef<RecorderEngine | null>(null);

  if (!engineRef.current) {
    engineRef.current = createRecorderEngine({
      onState: setState,
      onSeconds: setSeconds,
      onError: setError,
      onAnalyser: (node) => {
        analyserRef.current = node;
        setAnalyser(node);
      },
    });
  }

  useEffect(() => {
    const engine = engineRef.current!;
    engine.revive();
    return () => {
      engine.dispose();
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && engineRef.current?.isActiveOrStarting) {
        engineRef.current.cancel();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const start = useCallback(() => engineRef.current!.start(), []);
  const stop = useCallback(() => engineRef.current!.stop(), []);
  const cancel = useCallback(() => engineRef.current!.cancel(), []);

  return { state, seconds, error, supported, analyser, analyserRef, start, stop, cancel };
}

/** "0:07" for the recording hint. */
export function clockLabel(total: number): string {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
