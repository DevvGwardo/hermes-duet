import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CardData } from '../shared/types';
import { config } from './config';
import { UserError } from './errors';
import { briefSpeech, cleanTranscript, speak, sttTarget, transcribeFile, ttsTarget } from './audio';

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

  test('drops non-speech tags', () => {
    expect(cleanTranscript('[BLANK_AUDIO]\n[Music] hello there [applause]')).toBe('hello there');
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
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
    const long = brief({ entries: Array.from({ length: 5 }, (_, i) => ({ title: 'x'.repeat(2000), detail: 'y'.repeat(2000) })) });
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