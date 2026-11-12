import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CardData } from '../shared/types';
import { config } from './config';
import {
  __setAudioHas,
  __setAudioRunner,
  audioDiagnostics,
  briefSpeech,
  cleanTranscript,
  speak,
  sttTarget,
  transcribeFile,
  ttsTarget,
} from './audio';

const has = (present: string[]) => (cmd: string) => present.includes(cmd);

describe('sttTarget', () => {
  test('an explicit endpoint wins over everything', () => {
    const t = sttTarget({ DUET_STT_URL: 'http://localhost:8080/v1/audio/transcriptions', DUET_STT_CMD: 'whisper-cli -f {file}' }, has(['whisper-cli']));
    expect(t).toEqual({ kind: 'http', url: 'http://localhost:8080/v1/audio/transcriptions', model: 'whisper-1', key: '' });
  });

  test('reads model and key from the environment', () => {
    const t = sttTarget({ DUET_STT_URL: 'http://x/asr', DUET_STT_MODEL: 'large-v3', DUET_STT_KEY: 'k' }, has([]));
    expect(t).toEqual({ kind: 'http', url: 'http://x/asr', model: 'large-v3', key: 'k' });
  });

  test('a command template without {file} gets the path appended', () => {
    expect(sttTarget({ DUET_STT_CMD: 'my-stt --json' }, has([]))).toEqual({ kind: 'cmd', cmd: 'my-stt', args: ['--json', '{file}'] });
    expect(sttTarget({ DUET_STT_CMD: 'whisper-cli -m model.bin -f {file} -nt' }, has([]))).toEqual({
      kind: 'cmd',
      cmd: 'whisper-cli',
      args: ['-m', 'model.bin', '-f', '{file}', '-nt'],
    });
  });

  test('finds whisper.cpp on PATH', () => {
    expect(sttTarget({}, has(['whisper-cli']))).toEqual({ kind: 'cmd', cmd: 'whisper-cli', args: ['-f', '{file}', '-nt', '-np'] });
    expect(sttTarget({}, has(['whisper-cpp']))).toEqual({ kind: 'cmd', cmd: 'whisper-cpp', args: ['-f', '{file}', '-nt', '-np'] });
  });

  test('says what to install when there is nothing', () => {
    const t = sttTarget({}, has([]));
    expect(t.kind).toBe('none');
    if (t.kind === 'none') expect(t.reason).toMatch(/whisper|DUET_STT/);
  });
});

describe('cleanTranscript', () => {
  test('drops timestamps and keeps the words', () => {
    expect(cleanTranscript('[00:00:00.000 --> 00:00:02.400]  remind me to call the dentist')).toBe('remind me to call the dentist');
    expect(cleanTranscript('0:00:01.000 --> 0:00:03.000\nbuy milk')).toBe('buy milk');
  });

  test('drops non-speech tags and parenthetical annotations while keeping real parenthetical speech', () => {
    expect(cleanTranscript('[BLANK_AUDIO]\n[Music] hello there [applause]')).toBe('hello there');
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
    expect(cleanTranscript('(music) (applause) (laughter) (sighs) (silence)')).toBe('');
    expect(cleanTranscript('(laughter) Check section 2 (see appendix) please (sighs)')).toBe('Check section 2 (see appendix) please');
    expect(cleanTranscript('[inaudible] ♪ ♪ ...')).toBe('');
  });

  test('strips subtitle/amara artifacts and collapses repeated-phrase silence hallucinations without mangling real speech', () => {
    expect(cleanTranscript('Subtitles by the Amara.org community')).toBe('');
    expect(cleanTranscript('Meet at 3pm. Subtitles by Amara.org')).toBe('Meet at 3pm.');
    expect(cleanTranscript('Thank you. Thank you. Thank you. Thank you.')).toBe('Thank you.');
    expect(cleanTranscript('Thank you, thank you, thank you.')).toBe('Thank you.');
    expect(cleanTranscript('you you you you you')).toBe('you');
    expect(cleanTranscript('I really really need to check the server logs and check the database.')).toBe(
      'I really really need to check the server logs and check the database.',
    );
    expect(cleanTranscript('Call me at 555 555 5555 tomorrow.')).toBe('Call me at 555 555 5555 tomorrow.');
  });

  test('reflows a wrapped paragraph and keeps real paragraphs', () => {
    expect(cleanTranscript('one two\nthree four\n\nfive')).toBe('one two three four\n\nfive');
  });

  test('empty input is empty output', () => {
    expect(cleanTranscript('')).toBe('');
    expect(cleanTranscript('   \n\n  ')).toBe('');
  });
});

describe('ttsTarget', () => {
  test('macOS falls back to say', () => {
    expect(ttsTarget({}, 'darwin')).toEqual({ kind: 'say' });
  });

  test('linux has no default, and says why', () => {
    const t = ttsTarget({}, 'linux');
    expect(t.kind).toBe('none');
    if (t.kind === 'none') expect(t.reason).toMatch(/DUET_TTS/);
  });

  test('an endpoint or a command wins over say', () => {
    expect(ttsTarget({ DUET_TTS_URL: 'http://x/tts', DUET_TTS_VOICE: 'shimmer' }, 'darwin')).toEqual({
      kind: 'http',
      url: 'http://x/tts',
      model: 'tts-1',
      voice: 'shimmer',
      key: '',
    });
    expect(ttsTarget({ DUET_TTS_CMD: 'piper --output_file {out}' }, 'darwin')).toEqual({ kind: 'cmd', cmd: 'piper', args: ['--output_file', '{out}'] });
  });
});

describe('briefSpeech', () => {
  const brief = (fields: Partial<CardData> = {}): CardData => ({ type: 'brief', title: 'Good morning. 2 things need you today.', status: 'info', ...fields });

  test('reads the headline, each decision and the watching list', () => {
    const text = briefSpeech(
      brief({
        entries: [
          { title: 'Reply to Dana about the lease', detail: 'She needs an answer today' },
          { title: 'Pay the health permit', draft: 'ignored' },
        ],
        watching: [{ title: 'Package arrives Thursday' }],
      }),
    );
    expect(text).toContain('2 things need you');
    expect(text).toContain('Number 1: Reply to Dana about the lease. She needs an answer today');
    expect(text).toContain('Number 2: Pay the health permit');
    expect(text).toContain('Watching: Package arrives Thursday');
  });

  test('strips markdown so it is not read out loud', () => {
    const text = briefSpeech(brief({ body: '## **Note** [the lease](https://example.com/x) is `signed`' }));
    expect(text).not.toContain('##');
    expect(text).not.toContain('**');
    expect(text).not.toContain('https://');
    expect(text).toContain('the lease');
  });

  test('a quiet morning is still a sentence', () => {
    expect(briefSpeech(brief({ title: 'Nothing needs you today', entries: [] }))).toBe('Nothing needs you today');
  });

  test('caps very long briefs', () => {
    const long = brief({ entries: Array.from({ length: 5 }, () => ({ title: 'x'.repeat(2000), detail: 'y'.repeat(2000) })) });
    expect(briefSpeech(long).length).toBeLessThanOrEqual(4000);
  });
});

describe('quoted Windows command paths & speak safety', () => {
  const savedEnv = {
    ttsCmd: process.env.DUET_TTS_CMD,
    ttsUrl: process.env.DUET_TTS_URL,
    sttCmd: process.env.DUET_STT_CMD,
    sttUrl: process.env.DUET_STT_URL,
  };
  const realFetch = globalThis.fetch;

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('DUET_TTS_CMD', savedEnv.ttsCmd);
    restore('DUET_TTS_URL', savedEnv.ttsUrl);
    restore('DUET_STT_CMD', savedEnv.sttCmd);
    restore('DUET_STT_URL', savedEnv.sttUrl);
    globalThis.fetch = realFetch;
  });

  test('sttTarget and ttsTarget preserve spaces inside quoted paths', () => {
    expect(sttTarget({ DUET_STT_CMD: '"C:\\Program Files\\Whisper\\whisper-cli.exe" -m "C:\\Models\\ggml base.bin" -f {file}' }, has([]))).toEqual({
      kind: 'cmd',
      cmd: 'C:\\Program Files\\Whisper\\whisper-cli.exe',
      args: ['-m', 'C:\\Models\\ggml base.bin', '-f', '{file}'],
    });
    expect(ttsTarget({ DUET_TTS_CMD: '"C:\\Program Files\\Piper\\piper.exe" --model m.onnx --output_file {out}' }, 'win32')).toEqual({
      kind: 'cmd',
      cmd: 'C:\\Program Files\\Piper\\piper.exe',
      args: ['--model', 'm.onnx', '--output_file', '{out}'],
    });
  });

  test('missing TTS engine throws UserError 503', async () => {
    if (process.platform === 'darwin') return;
    delete process.env.DUET_TTS_URL;
    delete process.env.DUET_TTS_CMD;
    await expect(speak('Hello there')).rejects.toMatchObject({ status: 503 });
  });

  test('speak deduplicates concurrent synthesis, writes atomically, and cleans temp files on failure', async () => {
    delete process.env.DUET_TTS_CMD;
    process.env.DUET_TTS_URL = 'http://tts.local/speak';
    const dir = join(config.dataDir, 'tts');
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      await Bun.sleep(20);
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }) as any;

    const unique = `concurrent test ${Date.now()} ${Math.random()}`;
    const [a, b] = await Promise.all([speak(unique), speak(unique)]);
    expect(fetches).toBe(1);
    expect(a.path).toBe(b.path);
    expect(Array.from(readFileSync(a.path))).toEqual([1, 2, 3, 4]);
    expect(readdirSync(dir).some((n) => n.endsWith('.tmp'))).toBe(false);

    // Failed synthesis leaves no .tmp or partial final file behind.
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as any;
    await expect(speak(`fail test ${Date.now()} ${Math.random()}`)).rejects.toThrow(/TTS failed/);
    expect(readdirSync(dir).some((n) => n.endsWith('.tmp'))).toBe(false);

    delete process.env.DUET_TTS_URL;
    process.env.DUET_STT_URL = 'http://stt.local/transcribe';
    globalThis.fetch = (async () => new Response(JSON.stringify({ text: '[00:00.000 --> 00:01.000]  hello world' }), { status: 200 })) as any;
    expect(await transcribeFile(a.path)).toBe('hello world');
  });
});

describe('transcribeFile transcoding, remuxing & diagnostics', () => {
  const savedEnv = {
    sttCmd: process.env.DUET_STT_CMD,
    sttUrl: process.env.DUET_STT_URL,
    sttModel: process.env.DUET_STT_MODEL,
    sttKey: process.env.DUET_STT_KEY,
    ttsCmd: process.env.DUET_TTS_CMD,
    ttsUrl: process.env.DUET_TTS_URL,
  };
  const realFetch = globalThis.fetch;
  let tempDir: string | null = null;
  let prevHas: ((cmd: string) => boolean) | null = null;
  let prevRunner: Parameters<typeof __setAudioRunner>[0] | null = null;

  afterEach(() => {
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('DUET_STT_CMD', savedEnv.sttCmd);
    restore('DUET_STT_URL', savedEnv.sttUrl);
    restore('DUET_STT_MODEL', savedEnv.sttModel);
    restore('DUET_STT_KEY', savedEnv.sttKey);
    restore('DUET_TTS_CMD', savedEnv.ttsCmd);
    restore('DUET_TTS_URL', savedEnv.ttsUrl);
    globalThis.fetch = realFetch;
    if (prevHas) {
      __setAudioHas(prevHas);
      prevHas = null;
    }
    if (prevRunner) {
      __setAudioRunner(prevRunner);
      prevRunner = null;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('transcodes non-WAV input to 16kHz mono PCM WAV for whisper-cli and deletes temp WAV in finally', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'duet-audio-transcode-'));
    const input = join(tempDir, 'memo.webm');
    writeFileSync(input, new Uint8Array([1, 2, 3, 4]));
    delete process.env.DUET_STT_URL;
    delete process.env.DUET_STT_CMD;

    const calls: { cmd: string; args: string[] }[] = [];
    let wavPathSeen = '';
    prevHas = __setAudioHas((cmd) => cmd === 'whisper-cli' || cmd === 'ffmpeg');
    prevRunner = __setAudioRunner(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'ffmpeg') {
        wavPathSeen = args.at(-1)!;
        writeFileSync(wavPathSeen, new Uint8Array([82, 73, 70, 70]));
        return { out: '', err: '', code: 0 };
      }
      expect(cmd).toBe('whisper-cli');
      expect(args).toContain(wavPathSeen);
      expect(existsSync(wavPathSeen)).toBe(true);
      return { out: '[00:00.000 --> 00:01.000]  transcoded speech', err: '', code: 0 };
    });

    const text = await transcribeFile(input, 'audio/webm');
    expect(text).toBe('transcoded speech');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.cmd).toBe('ffmpeg');
    expect(calls[0]!.args.slice(0, 9)).toEqual(['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le']);
    expect(wavPathSeen.endsWith('.wav')).toBe(true);
    expect(existsSync(wavPathSeen)).toBe(false);

    // Even when whisper-cli fails, the temporary WAV file is deleted in finally.
    prevRunner = __setAudioRunner(async (cmd, args) => {
      if (cmd === 'ffmpeg') {
        wavPathSeen = args.at(-1)!;
        writeFileSync(wavPathSeen, new Uint8Array([1]));
        return { out: '', err: '', code: 0 };
      }
      return { out: '', err: 'whisper error', code: 1 };
    });
    await expect(transcribeFile(input, 'audio/webm')).rejects.toThrow(/Transcription failed/);
    expect(existsSync(wavPathSeen)).toBe(false);
  });

  test('skips ffmpeg when input for whisper-cli is already WAV', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'duet-audio-wav-'));
    const input = join(tempDir, 'memo.wav');
    writeFileSync(input, new Uint8Array([82, 73, 70, 70]));
    delete process.env.DUET_STT_URL;
    delete process.env.DUET_STT_CMD;

    const cmds: string[] = [];
    prevHas = __setAudioHas((cmd) => cmd === 'whisper-cli');
    prevRunner = __setAudioRunner(async (cmd, args) => {
      cmds.push(cmd);
      expect(args).toContain(input);
      return { out: 'native wav', err: '', code: 0 };
    });

    expect(await transcribeFile(input, 'audio/wav')).toBe('native wav');
    expect(cmds).toEqual(['whisper-cli']);
  });

  test('returns actionable UserError 503 when ffmpeg is missing for non-WAV local STT', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'duet-audio-noffmpeg-'));
    const input = join(tempDir, 'memo.m4a');
    writeFileSync(input, new Uint8Array([1, 2, 3]));
    delete process.env.DUET_STT_URL;
    delete process.env.DUET_STT_CMD;

    prevHas = __setAudioHas((cmd) => cmd === 'whisper-cli');
    await expect(transcribeFile(input, 'audio/mp4')).rejects.toMatchObject({
      status: 503,
      message: expect.stringMatching(/ffmpeg/i),
    });
  });

  test('remuxes m4a/mp4 with faststart for HTTP STT, sets accurate FormData file + MIME without manual Content-Type, and falls back on remux failure', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'duet-audio-http-'));
    const input = join(tempDir, 'safari.mp4');
    const origBytes = new Uint8Array([10, 20, 30, 40]);
    const remuxBytes = new Uint8Array([50, 60, 70, 80, 90]);
    writeFileSync(input, origBytes);
    process.env.DUET_STT_URL = 'https://stt.example/v1/audio/transcriptions';
    process.env.DUET_STT_KEY = 'secret-stt-key';

    let remuxTmp = '';
    prevHas = __setAudioHas((cmd) => cmd === 'ffmpeg');
    prevRunner = __setAudioRunner(async (cmd, args) => {
      expect(cmd).toBe('ffmpeg');
      expect(args.slice(0, 7)).toEqual(['-y', '-i', input, '-c', 'copy', '-movflags', '+faststart']);
      remuxTmp = args.at(-1)!;
      expect(remuxTmp.endsWith('.m4a')).toBe(true);
      writeFileSync(remuxTmp, remuxBytes);
      return { out: '', err: '', code: 0 };
    });

    let capturedFile: File | null = null;
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers;
      const form = init.body as FormData;
      capturedFile = form.get('file') as File;
      return new Response(JSON.stringify({ text: 'remuxed ok' }), { status: 200 });
    }) as any;

    expect(await transcribeFile(input, 'video/mp4')).toBe('remuxed ok');
    expect(existsSync(remuxTmp)).toBe(false);
    expect((capturedHeaders as Record<string, string>)['content-type']).toBeUndefined();
    expect((capturedHeaders as Record<string, string>)['Content-Type']).toBeUndefined();
    expect((capturedHeaders as Record<string, string>)['authorization']).toBe('Bearer secret-stt-key');
    expect(capturedFile!.name).toBe('safari.m4a');
    expect(capturedFile!.type).toBe('audio/mp4');
    expect(Array.from(new Uint8Array(await capturedFile!.arrayBuffer()))).toEqual(Array.from(remuxBytes));

    // When ffmpeg remux fails, fall back cleanly to the original file.
    prevRunner = __setAudioRunner(async () => ({ out: '', err: 'bad atom', code: 1 }));
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      capturedFile = form.get('file') as File;
      return new Response(JSON.stringify({ text: 'fallback ok' }), { status: 200 });
    }) as any;
    expect(await transcribeFile(input, 'video/mp4')).toBe('fallback ok');
    expect(capturedFile!.name).toBe('safari.mp4');
    expect(capturedFile!.type).toBe('video/mp4');
    expect(Array.from(new Uint8Array(await capturedFile!.arrayBuffer()))).toEqual(Array.from(origBytes));
  });

  test('audioDiagnostics reports stt, tts, and ffmpeg status', () => {
    prevHas = __setAudioHas((cmd) => cmd === 'ffmpeg' || cmd === 'whisper-cli');
    const diag = audioDiagnostics({}, 'linux');
    expect(diag.ffmpeg).toBe(true);
    expect(diag.stt).toMatchObject({ kind: 'cmd', cmd: 'whisper-cli' });
    expect(diag.tts.kind).toBe('none');
  });
});