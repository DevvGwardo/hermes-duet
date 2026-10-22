import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config';

/** API key: explicit env first, then the gateway's own ~/.hermes/.env (read-only). */
function apiKey(): string {
  if (config.hermesKey) return config.hermesKey;
  const envPath = join(config.hermesHome, '.env');
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, 'utf8').match(/^\s*API_SERVER_KEY\s*=\s*['"]?([^'"\n]+)['"]?\s*$/m);
    if (m) return m[1].trim();
  }
  return '';
}

const key = apiKey();
const SESSION_KEY = config.sessionScope;

function headers(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    'x-hermes-session-key': SESSION_KEY,
    ...extra,
  };
}

export class HermesError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
  const res = await fetch(`${config.hermesUrl}${path}`, {
    method,
    headers: headers(extra),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new HermesError(res.status, data?.error?.message ?? data?.error ?? text.slice(0, 300) ?? res.statusText);
  return data as T;
}

export interface RunEvent {
  event: string;
  run_id?: string;
  seq?: number;
  [k: string]: any;
}

export const hermes = {
  hasKey: () => !!key,

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${config.hermesUrl}/health`, { signal: AbortSignal.timeout(4000) });
      return res.ok;
    } catch {
      return false;
    }
  },

  startRun(p: { input: string; session_id: string; instructions: string; idempotencyKey: string }) {
    return req<{ run_id: string; status: string }>(
      'POST',
      '/v1/runs',
      { input: p.input, session_id: p.session_id, instructions: p.instructions, model: config.hermesModel },
      { 'idempotency-key': p.idempotencyKey },
    );
  },

  getRun(runId: string) {
    return req<{
      status: string;
      output?: string;
      error?: any;
      pending_controls?: any[];
      execution_generation?: number;
      admission_id?: string;
    }>(
      'GET',
      `/v1/runs/${encodeURIComponent(runId)}`,
    );
  },

  stop: (runId: string) => req('POST', `/v1/runs/${encodeURIComponent(runId)}/stop`, {}),
  /** Acknowledge a run whose owner died (gateway restart) so Hermes unpauses its session. */
  resolveUnknown: (runId: string, admission_id: string, execution_generation: number) =>
    req('POST', `/v1/runs/${encodeURIComponent(runId)}/resolve-unknown`, { admission_id, execution_generation }),
  steer: (runId: string, text: string) => req<{ accepted: boolean }>('POST', `/v1/runs/${encodeURIComponent(runId)}/steer`, { input: text }),
  approve: (runId: string, request_id: string, execution_generation: number, choice: 'once' | 'deny') =>
    req('POST', `/v1/runs/${encodeURIComponent(runId)}/approval`, { request_id, execution_generation, choice }),
  clarify: (runId: string, request_id: string, execution_generation: number, answer: string) =>
    req('POST', `/v1/runs/${encodeURIComponent(runId)}/clarify`, { request_id, execution_generation, answer }),

  /**
   * Stream a run's events. Resolves when the stream ends (terminal event or disconnect).
   * Frames are `id: <seq>` + `data: {"event": ...}`; resume with ?last_seq.
   */
  async events(runId: string, lastSeq: number, onEvent: (ev: RunEvent) => void, signal: AbortSignal): Promise<void> {
    const url = `${config.hermesUrl}/v1/runs/${encodeURIComponent(runId)}/events${lastSeq > 0 ? `?last_seq=${lastSeq}` : ''}`;
    const res = await fetch(url, { headers: { ...headers(), accept: 'text/event-stream' }, signal });
    if (!res.ok || !res.body) throw new HermesError(res.status, `events ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep).replace(/^\r?\n\r?\n/, '');
        let data = '';
        let id: number | undefined;
        let name: string | undefined;
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '');
          else if (line.startsWith('id:')) id = Number(line.slice(3).trim());
          else if (line.startsWith('event:')) name = line.slice(6).trim();
        }
        if (!data) continue;
        try {
          const ev = JSON.parse(data) as RunEvent;
          if (!ev.event && name) ev.event = name;
          if (ev.seq === undefined && id !== undefined && !Number.isNaN(id)) ev.seq = id;
          onEvent(ev);
        } catch {}
      }
    }
  },
};

export const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted']);
