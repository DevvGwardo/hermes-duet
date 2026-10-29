// Speech in and out, entirely local by default.
//
// Voice memos are transcribed by a local engine (whisper.cpp, or anything that speaks the OpenAI transcription shape
// at a URL you point us at); the morning brief can be listened to through macOS `say` (converted to AAC so phones can
// play it), Piper, or an OpenAI-compatible TTS endpoint. Nothing is uploaded anywhere unless DUET_STT_URL /
// DUET_TTS_URL says so.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CardData } from '../shared/types';
import { config } from './config';

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
    const [cmd, ...args] = custom.split(/\s+/);
    // `{file}` expands per transcription; a template without it gets the path appended.
    return { kind: 'cmd', cmd, args: args.includes('{file}') ? args : [...args, '{file}'] };
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
    const [cmd, ...args] = custom.split(/\s+/);
    return { kind: 'cmd', cmd, args };
  }
  if (platform === 'darwin') return { kind: 'say' };
  return { kind: 'none', reason: 'No text-to-speech engine. Set DUET_TTS_CMD (Piper: "piper --model en_US-lessac-medium.onnx --output_file {out}") or DUET_TTS_URL.' };
}

const NOISE = /\[(blank_audio|silence|music|applause|inaudible|no speech)[^\]]*\]/gi;
const TIMESTAMP = /^\s*\[?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\]?\s*/;
const BRACKET_TIME = /\[\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\]/g;

/**
 * Whisper output as something worth putting in the composer: drop timestamps and non-speech tags, then reflow into
 * one paragraph (a voice memo is one utterance, not a document). Empty means it heard nothing.
 */
export function cleanTranscript(raw: string): string {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(TIMESTAMP, '').replace(BRACKET_TIME, ''))
    .join('\n')
    .replace(NOISE, '');
  return lines
    .split(/\n{2,}/)
    .map((p) =>
      p
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .filter(Boolean)
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

function hasCommand(cmd: string) {
  try {
    return !!Bun.which(cmd);
  } catch {
    return false;
  }
}

/** A local engine must not hang a request forever. */
const STT_TIMEOUT_MS = 180_000;

async function runCommand(cmd: string, args: string[], stdin?: string): Promise<{ out: string; err: string; code: number }> {
  const proc = Bun.spawn([cmd, ...args], {
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), STT_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out, err, code };
  } finally {
    clearTimeout(timer);
  }
}

/** Transcribe a stored audio file with whatever local engine is configured. Returns '' when it heard nothing. */
export async function transcribeFile(path: string): Promise<string> {
  const target = sttTarget(process.env, hasCommand);
  if (target.kind === 'none') throw new Error(target.reason);
  if (target.kind === 'cmd') {
    const args = target.args.map((a) => a.replaceAll('{file}', path));
    const { out, err, code } = await runCommand(target.cmd, args);
    if (code !== 0) throw new Error(`Transcription failed: ${(err || out).trim().slice(-200) || `exit ${code}`}`);
    return cleanTranscript(out);
  }
  const form = new FormData();
  form.append('file', new Blob([readFileSync(path)]), basename(path));
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
}

const ttsDir = () => join(config.dataDir, 'tts');

/**
 * Synthesize text to a cached audio file. The cache key covers the engine, so changing voice or model makes a new
 * file instead of replaying the old one.
 */
export async function speak(text: string): Promise<{ path: string; mime: string }> {
  const target = ttsTarget(process.env, process.platform);
  if (target.kind === 'none') throw new Error(target.reason);
  const spokenText = spoken(text);
  if (!spokenText) throw new Error('nothing to say');
  const key = Bun.hash(`${JSON.stringify(target)}\n${spokenText}`).toString(36);
  const dir = ttsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = target.kind === 'http' ? '.mp3' : target.kind === 'say' ? '.m4a' : process.env.DUET_TTS_EXT?.trim() || '.wav';
  const out = join(dir, `${key}${ext}`);
  const mime = ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : ext === '.ogg' ? 'audio/ogg' : 'audio/wav';
  if (existsSync(out)) return { path: out, mime };

  if (target.kind === 'say') {
    const aiff = join(dir, `${key}.aiff`);
    const said = await runCommand('say', ['-o', aiff, spokenText]);
    if (said.code !== 0) throw new Error(`say failed: ${said.err.trim().slice(-200) || `exit ${said.code}`}`);
    // AIFF is not reliably playable on phones; AAC/M4A is.
    const conv = await runCommand('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', aiff, out]);
    rmSync(aiff, { force: true });
    if (conv.code !== 0) throw new Error(`afconvert failed: ${conv.err.trim().slice(-200) || `exit ${conv.code}`}`);
  } else if (target.kind === 'cmd') {
    const hasOut = target.args.some((a) => a.includes('{out}'));
    const hasText = target.args.some((a) => a.includes('{text}'));
    const args = target.args.map((a) => a.replaceAll('{out}', out).replaceAll('{text}', spokenText));
    if (!hasOut) args.push(out);
    const ran = await runCommand(target.cmd, args, hasText ? '' : spokenText);
    if (ran.code !== 0) throw new Error(`TTS command failed: ${ran.err.trim().slice(-200) || `exit ${ran.code}`}`);
  } else {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(target.key ? { authorization: `Bearer ${target.key}` } : {}) },
      body: JSON.stringify({ model: target.model, voice: target.voice, input: spokenText, response_format: 'mp3' }),
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`TTS failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    writeFileSync(out, new Uint8Array(await res.arrayBuffer()), { mode: 0o600 });
  }
  chmodSync(out, 0o600);
  return { path: out, mime };
}