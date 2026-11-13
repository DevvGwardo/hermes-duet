// Speech in and out, entirely local by default.
//
// Voice memos are transcribed by a local engine (whisper.cpp, or anything that speaks the OpenAI transcription shape
// at a URL you point us at); the morning brief can be listened to through macOS `say` (converted to AAC so phones can
// play it), Piper, or an OpenAI-compatible TTS endpoint. Nothing is uploaded anywhere unless DUET_STT_URL /
// DUET_TTS_URL says so.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { CardData } from '../shared/types';
import { config } from './config';
import { UserError } from './errors';
import { execCommand, hasCommand } from './exec';
import { normalizeMime } from './uploads';
import { splitArgs } from './vault';

type Env = Record<string, string | undefined>;

/** A command template split into argv, with placeholders left for the caller to fill in. */
export type CommandTarget = { kind: 'cmd'; cmd: string; args: string[] };

export type SttTarget =
  | CommandTarget
  | { kind: 'http'; url: string; model: string; key: string }
  | { kind: 'none'; reason: string };

/**
 * Where transcription comes from. An explicit URL wins (an OpenAI-compatible endpoint, a Hermes host, a whisper
 * server); then an explicit command; then a whisper.cpp binary on PATH. The command template uses {file}; without it
 * the path is appended, which is what both whisper.cpp and most wrappers expect.
 */
export function sttTarget(env: Env, has: (cmd: string) => boolean): SttTarget {
  const url = env.DUET_STT_URL?.trim();
  if (url) return { kind: 'http', url, model: env.DUET_STT_MODEL?.trim() || 'whisper-1', key: env.DUET_STT_KEY?.trim() || '' };
  const custom = env.DUET_STT_CMD?.trim();
  if (custom) {
    const [cmd = '', ...args] = splitArgs(custom);
    if (cmd) {
      // `{file}` expands per transcription; a template without it gets the path appended.
      return { kind: 'cmd', cmd, args: args.includes('{file}') ? args : [...args, '{file}'] };
    }
  }
  for (const cmd of ['whisper-cli', 'whisper-cpp']) {
    if (has(cmd)) return { kind: 'cmd', cmd, args: ['-f', '{file}', '-nt', '-np'] };
  }
  return {
    kind: 'none',
    reason: 'No speech-to-text engine. Install whisper.cpp (brew install whisper-cpp), then set DUET_STT_CMD="whisper-cli -m /path/ggml-base.en.bin -f {file} -nt" or point DUET_STT_URL at an OpenAI-compatible /audio/transcriptions.',
  };
}

export type TtsTarget =
  | CommandTarget
  | { kind: 'say' }
  | { kind: 'http'; url: string; model: string; voice: string; key: string }
  | { kind: 'none'; reason: string };

/** Where the spoken brief comes from: an explicit endpoint, an explicit command, else macOS `say`. */
export function ttsTarget(env: Env, platform: string): TtsTarget {
  const url = env.DUET_TTS_URL?.trim();
  if (url) return { kind: 'http', url, model: env.DUET_TTS_MODEL?.trim() || 'tts-1', voice: env.DUET_TTS_VOICE?.trim() || 'alloy', key: env.DUET_TTS_KEY?.trim() || '' };
  const custom = env.DUET_TTS_CMD?.trim();
  if (custom) {
    const [cmd = '', ...args] = splitArgs(custom);
    if (cmd) return { kind: 'cmd', cmd, args };
  }
  if (platform === 'darwin') return { kind: 'say' };
  return { kind: 'none', reason: 'No text-to-speech engine. Set DUET_TTS_CMD (Piper: "piper --model en_US-lessac-medium.onnx --output_file {out}") or DUET_TTS_URL.' };
}

const NON_SPEECH_BODY =
  '(?:blank[_ ]?audio|silence|music|applause|inaudible|no[_ ]?speech|laughter|laughing|laughs|sighs?|coughs?|coughing|clears?\\s+throat|noise|background\\s+noise|cheering|clapping|crying|sobbing|snoring|groans?|gasps?|panting|breathing|footsteps|static|beeps?|chimes?|ringing|buzzing|humming|whistling|wind|rain|thunder|unintelligible|indistinct|foreign|speaking\\s+foreign\\s+language|sound(?:\\s+of\\s+[^)\\]]+)?|♪+)';
const BRACKET_NOISE = new RegExp(`\\[${NON_SPEECH_BODY}[^\\]]*\\]`, 'gi');
const PAREN_NOISE = new RegExp(`\\(${NON_SPEECH_BODY}(?:\\s+[^)]*)?\\)`, 'gi');
const MUSIC_NOTES = /♪+/g;
const SUBTITLE_ARTIFACT =
  /(?:^|\s)(?:subtitles?|captions?|transcribed|captioned)\s+by\b[^\n]*?(?=[.!?](?:\s|$)|$)[.!?]?|(?:^|(?<=[.!?]\s)|\n)(?:[^.!?\n]|\.(?!\s))*?\bamara\.org\b[^\n]*?(?=[.!?](?:\s|$)|$)[.!?]?/gi;
const REPEATED_PHRASE = /(\b[\p{L}\p{N}']+(?:\s+[\p{L}\p{N}']+){0,7}\b)(?:[.,!?;]*\s+\1\b){2,}([.,!?]*)/giu;
const TIMESTAMP = /^\s*\[?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\]?\s*/;
const BRACKET_TIME = /\[\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\]/g;

/**
 * Whisper output as something worth putting in the composer: drop timestamps, non-speech tags, subtitle artifacts,
 * and repeated-phrase silence hallucinations, then reflow into paragraphs. Empty means it heard nothing.
 */
export function cleanTranscript(raw: string): string {
  const cleaned = String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(TIMESTAMP, '').replace(BRACKET_TIME, ''))
    .join('\n')
    .replace(BRACKET_NOISE, ' ')
    .replace(PAREN_NOISE, ' ')
    .replace(MUSIC_NOTES, ' ')
    .replace(SUBTITLE_ARTIFACT, ' ');
  return cleaned
    .split(/\n{2,}/)
    .map((p) =>
      p
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(REPEATED_PHRASE, '$1$2')
        .replace(/\s+([.,!?;:])/g, '$1')
        .trim(),
    )
    .filter((p) => Boolean(p) && /[\p{L}\p{N}]/u.test(p))
    .join('\n\n')
    .trim();
}

const MAX_SPEECH = 4000;

/** Markdown-ish card text read aloud: no headings, bullets or links, just sentences a person can follow. */
const spoken = (s: string) =>
  String(s ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

/** What "Listen" says for a brief card: the headline, each decision with its detail, then what is being watched. */
export function briefSpeech(card: CardData): string {
  const parts: string[] = [];
  parts.push(spoken(card.title) || 'Your brief.');
  if (card.body) parts.push(spoken(card.body));
  const entries = card.entries ?? [];
  if (entries.length) {
    parts.push(entries.length === 1 ? 'One thing needs you.' : `${entries.length} things need you.`);
    entries.forEach((e, i) => {
      const detail = e.detail ? ` ${spoken(e.detail)}` : '';
      parts.push(`Number ${i + 1}: ${spoken(e.title)}.${detail}`);
    });
  }
  const watching = card.watching ?? [];
  if (watching.length) parts.push(`Watching: ${watching.map((w) => spoken(w.detail ? `${w.title}, ${w.detail}` : w.title)).join('. ')}.`);
  return parts.join('\n\n').slice(0, MAX_SPEECH);
}

// ---------------------------------------------------------------------------
// Runtime: spawning the engine, caching the audio
// ---------------------------------------------------------------------------

/** A local engine must not hang a request forever. */
const STT_TIMEOUT_MS = 180_000;

const runCommand = (cmd: string, args: string[], stdin?: string) => execCommand(cmd, args, { timeoutMs: STT_TIMEOUT_MS, stdin });

let audioHas: (cmd: string) => boolean = hasCommand;
let audioRunner: (cmd: string, args: string[], stdin?: string) => Promise<{ out: string; err: string; code: number }> = runCommand;

export function __setAudioHas(next: (cmd: string) => boolean): (cmd: string) => boolean {
  const prev = audioHas;
  audioHas = next;
  return prev;
}

export function __setAudioRunner(next: typeof runCommand): typeof runCommand {
  const prev = audioRunner;
  audioRunner = next;
  return prev;
}

export function audioDiagnostics(env: Env = process.env, platform: string = process.platform) {
  return {
    stt: sttTarget(env, audioHas),
    tts: ttsTarget(env, platform),
    ffmpeg: audioHas('ffmpeg'),
  };
}

const EXT_TO_MIME: Record<string, string> = {
  '.webm': 'audio/webm',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.3gp': 'audio/3gpp',
};

const MIME_TO_EXT: Record<string, string> = {
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/ogg': '.ogg',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/3gpp': '.3gp',
};

const tempNonce = () => `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

/** Transcribe a stored audio file with whatever local engine is configured. Returns '' when it heard nothing. */
export async function transcribeFile(path: string, mime?: string): Promise<string> {
  const target = sttTarget(process.env, audioHas);
  if (target.kind === 'none') throw new UserError(target.reason, 503);
  const ext = extname(path).toLowerCase();

  if (target.kind === 'cmd') {
    let inputPath = path;
    let tmpWav: string | null = null;
    try {
      if (ext !== '.wav') {
        if (!audioHas('ffmpeg')) {
          throw new UserError(
            'ffmpeg is required to transcode non-WAV audio for local STT. Install ffmpeg or use WAV audio or an HTTP STT endpoint (DUET_STT_URL).',
            503,
          );
        }
        tmpWav = join(dirname(path), `.stt-${basename(path, ext).replace(/^\.+/, '') || 'audio'}-${tempNonce()}.wav`);
        const conv = await audioRunner('ffmpeg', ['-y', '-i', path, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav]);
        if (conv.code !== 0) {
          throw new Error(`Audio transcoding failed: ${(conv.err || conv.out).trim().slice(-200) || `exit ${conv.code}`}`);
        }
        inputPath = tmpWav;
      }
      const args = target.args.map((a) => a.replaceAll('{file}', inputPath));
      const { out, err, code } = await audioRunner(target.cmd, args);
      if (code !== 0) throw new Error(`Transcription failed: ${(err || out).trim().slice(-200) || `exit ${code}`}`);
      return cleanTranscript(out);
    } finally {
      if (tmpWav) rmSync(tmpWav, { force: true });
    }
  }

  let sendPath = path;
  let tmpM4a: string | null = null;
  let remuxed = false;
  try {
    if ((ext === '.m4a' || ext === '.mp4') && audioHas('ffmpeg')) {
      tmpM4a = join(dirname(path), `.stt-remux-${basename(path, ext).replace(/^\.+/, '') || 'audio'}-${tempNonce()}.m4a`);
      try {
        const remux = await audioRunner('ffmpeg', ['-y', '-i', path, '-c', 'copy', '-movflags', '+faststart', tmpM4a]);
        if (remux.code === 0 && existsSync(tmpM4a) && statSync(tmpM4a).size > 0) {
          sendPath = tmpM4a;
          remuxed = true;
        }
      } catch {
        // Best-effort remux: fall back to the original file if ffmpeg errors.
      }
    }
    const cleanMime = normalizeMime(mime);
    const sendExt = remuxed ? '.m4a' : ext || MIME_TO_EXT[cleanMime] || '.webm';
    const sendMime = remuxed ? 'audio/mp4' : cleanMime || EXT_TO_MIME[sendExt] || 'application/octet-stream';
    const base = basename(path, ext).replace(/^\.+/, '') || 'audio';
    const form = new FormData();
    form.append('file', new Blob([readFileSync(sendPath)], { type: sendMime }), `${base}${sendExt}`);
    form.append('model', target.model);
    form.append('response_format', 'json');
    const res = await fetch(target.url, {
      method: 'POST',
      headers: target.key ? { authorization: `Bearer ${target.key}` } : undefined,
      body: form,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${text.slice(0, 200)}`);
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return cleanTranscript(typeof json?.text === 'string' ? json.text : text);
  } finally {
    if (tmpM4a) rmSync(tmpM4a, { force: true });
  }
}

const ttsDir = () => join(config.dataDir, 'tts');
const inFlightSpeak = new Map<string, Promise<{ path: string; mime: string }>>();

const TTS_VOICE_RE = /^[A-Za-z0-9._-]{1,40}$/;

/**
 * Synthesize text to a cached audio file. The cache key covers the engine and voice, so changing voice or model
 * makes a new file instead of replaying the old one.
 */
export async function speak(text: string, opts?: { voice?: string }): Promise<{ path: string; mime: string }> {
  const target = ttsTarget(process.env, process.platform);
  if (target.kind === 'none') throw new UserError(target.reason, 503);
  const spokenText = spoken(text);
  if (!spokenText) throw new UserError('nothing to say', 400);
  const rawVoice = opts?.voice?.trim() ?? '';
  if (rawVoice && !TTS_VOICE_RE.test(rawVoice)) throw new UserError('invalid tts voice', 400);
  const voice = rawVoice || undefined;
  const key = createHash('sha256').update(`${JSON.stringify(target)}\n${voice ?? ''}\n${spokenText}`).digest('hex').slice(0, 16);
  const dir = ttsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = target.kind === 'http' ? '.mp3' : target.kind === 'say' ? '.m4a' : process.env.DUET_TTS_EXT?.trim() || '.wav';
  const out = join(dir, `${key}${ext}`);
  const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : ext === '.ogg' ? 'audio/ogg' : 'audio/wav';
  if (existsSync(out)) return { path: out, mime };
  const existing = inFlightSpeak.get(out);
  if (existing) return existing;

  const synth = (async () => {
    const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const tmpOut = join(dir, `.${key}.${nonce}${ext}.tmp`);
    const tmpAiff = join(dir, `.${key}.${nonce}.aiff.tmp`);
    try {
      if (target.kind === 'say') {
        const sayArgs = voice ? ['-v', voice, '-o', tmpAiff, spokenText] : ['-o', tmpAiff, spokenText];
        const said = await audioRunner('say', sayArgs);
        if (said.code !== 0) throw new Error(`say failed: ${said.err.trim().slice(-200) || `exit ${said.code}`}`);
        // AIFF is not reliably playable on phones; AAC/M4A is.
        const conv = await audioRunner('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', tmpAiff, tmpOut]);
        if (conv.code !== 0) throw new Error(`afconvert failed: ${conv.err.trim().slice(-200) || `exit ${conv.code}`}`);
      } else if (target.kind === 'cmd') {
        const hasOut = target.args.some((a) => a.includes('{out}'));
        const hasText = target.args.some((a) => a.includes('{text}'));
        const args = target.args.map((a) => a.replaceAll('{out}', tmpOut).replaceAll('{text}', spokenText));
        if (!hasOut) args.push(tmpOut);
        const ran = await audioRunner(target.cmd, args, hasText ? '' : spokenText);
        if (ran.code !== 0) throw new Error(`TTS command failed: ${ran.err.trim().slice(-200) || `exit ${ran.code}`}`);
      } else {
        const res = await fetch(target.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(target.key ? { authorization: `Bearer ${target.key}` } : {}) },
          body: JSON.stringify({ model: target.model, voice: voice ?? target.voice, input: spokenText, response_format: 'mp3' }),
          signal: AbortSignal.timeout(STT_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`TTS failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
        writeFileSync(tmpOut, new Uint8Array(await res.arrayBuffer()), { mode: 0o600 });
      }
      if (!existsSync(tmpOut)) throw new Error('TTS produced no output file');
      chmodSync(tmpOut, 0o600);
      renameSync(tmpOut, out);
      chmodSync(out, 0o600);
      return { path: out, mime };
    } finally {
      rmSync(tmpAiff, { force: true });
      rmSync(tmpOut, { force: true });
    }
  })();

  inFlightSpeak.set(out, synth);
  try {
    return await synth;
  } finally {
    if (inFlightSpeak.get(out) === synth) inFlightSpeak.delete(out);
  }
}