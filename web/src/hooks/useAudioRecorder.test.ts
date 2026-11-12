import { describe, expect, test } from 'bun:test';

if (!(globalThis as any).document) {
  (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' };
}
if (!(globalThis as any).window) {
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {}, isSecureContext: true, matchMedia: () => ({ matches: false }) };
}

const {
  RECORDER_MIME_CANDIDATES,
  audioFileExtension,
  clockLabel,
  computeTimeDomainRms,
  createRecorderEngine,
  insertTranscript,
  recorderMime,
  resolveRecordedMime,
  shouldDiscardTake,
} = await import('./useAudioRecorder');

describe('MIME selection and audio helpers', () => {
  test('recorderMime probes MIME types in exact priority order', () => {
    expect([...RECORDER_MIME_CANDIDATES]).toEqual([
      'audio/webm;codecs=opus',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ]);

    const realMR = (globalThis as any).MediaRecorder;
    const probed: string[] = [];
    (globalThis as any).MediaRecorder = {
      isTypeSupported: (t: string) => {
        probed.push(t);
        return t === 'audio/mp4;codecs=mp4a.40.2' || t === 'audio/mp4';
      },
    };
    try {
      expect(recorderMime()).toBe('audio/mp4;codecs=mp4a.40.2');
      expect(probed).toEqual(['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2']);

      probed.length = 0;
      (globalThis as any).MediaRecorder = {
        isTypeSupported: (t: string) => {
          probed.push(t);
          return false;
        },
      };
      expect(recorderMime()).toBe('');
      expect(probed).toEqual([...RECORDER_MIME_CANDIDATES]);
    } finally {
      (globalThis as any).MediaRecorder = realMR;
    }
  });

  test('resolveRecordedMime respects recorder/chosen/chunk types and falls back to mp4 on Safari/iOS', () => {
    expect(resolveRecordedMime('audio/mp4', 'audio/webm', '')).toBe('audio/mp4');
    expect(resolveRecordedMime('', 'audio/webm;codecs=opus', 'audio/webm')).toBe('audio/webm;codecs=opus');
    expect(resolveRecordedMime('', '', 'audio/ogg')).toBe('audio/ogg');

    const safariNav = {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
      maxTouchPoints: 5,
    };
    const chromeNav = {
      userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36',
      platform: 'Linux',
      maxTouchPoints: 5,
    };
    expect(resolveRecordedMime('', '', '', safariNav)).toBe('audio/mp4');
    expect(resolveRecordedMime('', '', '', chromeNav)).toBe('audio/webm');
  });

  test('audioFileExtension, computeTimeDomainRms, and clockLabel', () => {
    expect(audioFileExtension('audio/mp4;codecs=mp4a.40.2')).toBe('m4a');
    expect(audioFileExtension('audio/ogg;codecs=opus')).toBe('ogg');
    expect(audioFileExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioFileExtension('audio/wav')).toBe('wav');

    const silence = new Uint8Array(64).fill(128);
    expect(computeTimeDomainRms(silence)).toBe(0);

    const speech = new Uint8Array(64);
    for (let i = 0; i < speech.length; i++) speech[i] = i % 2 === 0 ? 160 : 96;
    expect(computeTimeDomainRms(speech)).toBeCloseTo(0.25, 4);

    expect(clockLabel(0)).toBe('0:00');
    expect(clockLabel(65)).toBe('1:05');
  });
});

describe('createRecorderEngine', () => {
  function setupRecorderEnv(opts?: {
    supportedMimes?: string[];
    sampleByteValue?: (i: number) => number;
    throwOnStart?: boolean;
  }) {
    const events: string[] = [];
    const tracks: any[] = [];
    const createdRecorders: any[] = [];
    const createdContexts: any[] = [];
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    let nextRafId = 1;

    const realNav = (globalThis as any).navigator;
    const realMR = (globalThis as any).MediaRecorder;
    const realAudioCtx = (globalThis as any).AudioContext;
    const realRAF = (globalThis as any).requestAnimationFrame;
    const realCAF = (globalThis as any).cancelAnimationFrame;

    class FakeTrack {
      stopped = false;
      onended: (() => void) | null = null;
      stop() {
        this.stopped = true;
        events.push('track.stop');
      }
    }

    class FakeMediaStream {
      tracks = [new FakeTrack()];
      constructor() {
        tracks.push(...this.tracks);
      }
      getTracks() {
        return this.tracks;
      }
    }

    class FakeAnalyser {
      fftSize = 16;
      frequencyBinCount = 8;
      smoothingTimeConstant = 0.75;
      disconnected = false;
      getByteTimeDomainData(arr: Uint8Array) {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = opts?.sampleByteValue ? opts.sampleByteValue(i) : 128;
        }
      }
      disconnect() {
        this.disconnected = true;
      }
    }

    class FakeAudioContext {
      state: 'suspended' | 'running' | 'closed' = 'suspended';
      closed = false;
      resumed = false;
      analyser = new FakeAnalyser();
      sourceDisconnected = false;
      constructor() {
        events.push('AudioContext.new');
        createdContexts.push(this);
      }
      async resume() {
        this.resumed = true;
        this.state = 'running';
        events.push('AudioContext.resume');
      }
      createMediaStreamSource() {
        return {
          connect: () => events.push('source.connect'),
          disconnect: () => {
            this.sourceDisconnected = true;
          },
        };
      }
      createAnalyser() {
        return this.analyser;
      }
      async close() {
        this.closed = true;
        this.state = 'closed';
        events.push('AudioContext.close');
      }
    }

    class FakeMediaRecorder {
      static isTypeSupported(t: string) {
        return opts?.supportedMimes ? opts.supportedMimes.includes(t) : t === 'audio/webm;codecs=opus';
      }
      state: 'inactive' | 'recording' = 'inactive';
      mimeType: string;
      options: any;
      startTimeslice: number | undefined;
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      constructor(_stream: any, options?: any) {
        this.options = options;
        this.mimeType = options?.mimeType ?? '';
        createdRecorders.push(this);
      }
      start(timeslice?: number) {
        this.startTimeslice = timeslice;
        events.push(`recorder.start(${timeslice})`);
        if (opts?.throwOnStart) throw new Error('Hardware start failed');
        this.state = 'recording';
      }
      stop() {
        events.push('recorder.stop');
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['hello-audio'], { type: this.mimeType || 'audio/webm' }) });
        this.onstop?.();
      }
    }

    (globalThis as any).navigator = {
      userAgent: 'Mozilla/5.0 Chrome/128.0.0.0',
      mediaDevices: {
        getUserMedia: async () => {
          events.push('getUserMedia');
          return new FakeMediaStream();
        },
      },
    };
    (globalThis as any).MediaRecorder = FakeMediaRecorder;
    (globalThis as any).AudioContext = FakeAudioContext;
    (globalThis as any).requestAnimationFrame = (fn: FrameRequestCallback) => {
      const id = nextRafId++;
      rafCallbacks.set(id, fn);
      return id;
    };
    (globalThis as any).cancelAnimationFrame = (id: number) => {
      rafCallbacks.delete(id);
      events.push('cancelAnimationFrame');
    };

    return {
      events,
      tracks,
      createdRecorders,
      createdContexts,
      rafCallbacks,
      restore() {
        (globalThis as any).navigator = realNav;
        (globalThis as any).MediaRecorder = realMR;
        (globalThis as any).AudioContext = realAudioCtx;
        (globalThis as any).requestAnimationFrame = realRAF;
        (globalThis as any).cancelAnimationFrame = realCAF;
      },
    };
  }

  test('creates & resumes AudioContext before getUserMedia, tracks speech gate, and cleans up on stop', async () => {
    const env = setupRecorderEnv({
      supportedMimes: ['audio/mp4'],
      sampleByteValue: (i) => (i % 2 === 0 ? 170 : 86),
    });
    const states: string[] = [];
    const engine = createRecorderEngine({
      onState: (s) => states.push(s),
    });
    try {
      const ok = await engine.start();
      expect(ok).toBe(true);
      expect(states).toEqual(['recording']);
      // AudioContext must be constructed and resumed BEFORE getUserMedia resolves (iOS gesture rule).
      expect(env.events.indexOf('AudioContext.new')).toBeLessThan(env.events.indexOf('getUserMedia'));
      expect(env.events.indexOf('AudioContext.resume')).toBeLessThan(env.events.indexOf('getUserMedia'));
      expect(env.createdRecorders[0].startTimeslice).toBe(1000);
      expect(env.createdRecorders[0].options).toEqual({ mimeType: 'audio/mp4' });

      const result = await engine.stop();
      expect(result).not.toBeNull();
      expect(result!.mimeType).toBe('audio/mp4');
      expect(result!.hadSpeech).toBe(true);
      expect(result!.peakRms).toBeGreaterThan(0.2);
      expect(result!.durationMs).toBeGreaterThanOrEqual(0);
      expect(env.tracks[0].stopped).toBe(true);
      expect(env.createdContexts[0].closed).toBe(true);
      expect(states).toEqual(['recording', 'idle']);
    } finally {
      engine.dispose();
      env.restore();
    }
  });

  test('omits mimeType option when no candidate matches and flags pure silence', async () => {
    const env = setupRecorderEnv({
      supportedMimes: [],
      sampleByteValue: () => 128,
    });
    const engine = createRecorderEngine();
    try {
      expect(await engine.start()).toBe(true);
      expect(env.createdRecorders[0].options).toBeUndefined();

      const result = await engine.stop();
      expect(result).not.toBeNull();
      expect(result!.hadSpeech).toBe(false);
      expect(result!.peakRms).toBe(0);
    } finally {
      engine.dispose();
      env.restore();
    }
  });

  test('handles recorder.start() throw and recorder.onerror without hanging or staying stuck', async () => {
    const env1 = setupRecorderEnv({ throwOnStart: true });
    let err1: string | null = null;
    const engine1 = createRecorderEngine({ onError: (e) => (err1 = e) });
    try {
      expect(await engine1.start()).toBe(false);
      expect(err1!).toContain('Hardware start failed');
      expect(env1.tracks[0].stopped).toBe(true);
      expect(env1.createdContexts[0].closed).toBe(true);
    } finally {
      engine1.dispose();
      env1.restore();
    }

    const env2 = setupRecorderEnv();
    const states2: string[] = [];
    let err2: string | null = null;
    const engine2 = createRecorderEngine({
      onState: (s) => states2.push(s),
      onError: (e) => (err2 = e),
    });
    try {
      expect(await engine2.start()).toBe(true);
      env2.createdRecorders[0].onerror?.({ error: new Error('Mic unplugged') });
      expect(err2!).toBe('Mic unplugged');
      expect(states2).toEqual(['recording', 'idle']);
      expect(env2.tracks[0].stopped).toBe(true);
      expect(env2.createdContexts[0].closed).toBe(true);
    } finally {
      engine2.dispose();
      env2.restore();
    }
  });

  test('handles unexpected track.onended, cancel(), and dispose() + revive() cleanly', async () => {
    const env = setupRecorderEnv();
    const states: string[] = [];
    const engine = createRecorderEngine({ onState: (s) => states.push(s) });
    try {
      expect(await engine.start()).toBe(true);
      // Unexpected track end stops recorder and cleans up rather than leaving UI stuck in 'recording'.
      env.tracks[0].onended?.();
      expect(states).toEqual(['recording', 'idle']);
      expect(env.createdContexts[0].closed).toBe(true);

      // Start again and cancel(): stop() returns null and resources are released.
      expect(await engine.start()).toBe(true);
      engine.cancel();
      expect(states).toEqual(['recording', 'idle', 'recording', 'idle']);

      // Simulate React StrictMode unmount/remount: dispose() then revive() allows recording again.
      engine.dispose();
      expect(await engine.start()).toBe(false);
      engine.revive();
      expect(await engine.start()).toBe(true);
      const res = await engine.stop();
      expect(res).not.toBeNull();
    } finally {
      engine.dispose();
      env.restore();
    }
  });
});

describe('VoiceInput pure helpers', () => {
  test('insertTranscript preserves existing draft and adds smart spacing around cursor', () => {
    expect(insertTranscript('', '  hello world  ', null)).toEqual({ text: 'hello world', cursor: 11 });
    expect(insertTranscript('hello', 'world', { start: 5, end: 5 })).toEqual({ text: 'hello world', cursor: 11 });
    expect(insertTranscript('hello', 'world', { start: 0, end: 0 })).toEqual({ text: 'world hello', cursor: 5 });
    expect(insertTranscript('say foo bar', 'hi', { start: 4, end: 7 })).toEqual({ text: 'say hi bar', cursor: 6 });
    expect(insertTranscript('Wait,', 'listen.', { start: 5, end: 5 })).toEqual({ text: 'Wait, listen.', cursor: 13 });
    expect(insertTranscript('hello.', 'hey', { start: 5, end: 5 })).toEqual({ text: 'hello hey.', cursor: 9 });
  });

  test('shouldDiscardTake guards <300ms accidental taps and silent takes', () => {
    const blob = new Blob(['x'], { type: 'audio/webm' });
    expect(shouldDiscardTake({ blob, mimeType: 'audio/webm', durationMs: 220, peakRms: 0.2, hadSpeech: true })).toBe('too-short');
    expect(shouldDiscardTake({ blob, mimeType: 'audio/webm', durationMs: 1200, peakRms: 0.002, hadSpeech: false })).toBe('silent');
    expect(shouldDiscardTake({ blob, mimeType: 'audio/webm', durationMs: 1200, peakRms: 0.12, hadSpeech: true })).toBeNull();
  });
});
