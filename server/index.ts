import { chmodSync, createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { Item, Snapshot, TrackedFollowUp } from '../shared/types';
import { audioDiagnostics, briefSpeech, speak, transcribeFile } from './audio';
import { capabilities } from './capabilities';
import { channelInput, channelPatch } from './channels';
import { encodedPath, encodingHeaders, preferredEncoding } from './compress';
import { createPairCode, deviceCookie, deviceFor, internalToken, isHttps, pairBlocked, redeemPairCode, sameOrigin } from './auth';
import * as browser from './browser';
import { broadcast, sseResponse } from './bus';
import { listConnectors, testConnector } from './connectors';
import { config } from './config';
import { MAX_EDIT_BYTES } from '../shared/edit';
import { type AttachmentRow, attachments, channels, db, devices, files, followUps, items, kv, newId, pages, routines, settings, tasks, toAttachment, triggers, trustRules } from './db';
import { UserError } from './errors';
import { sleep } from './exec';
import { saveFileVersion } from './fileversions';
import { gateways, hermes } from './hermes';
import { MEMORY_MAX_BYTES, clearMemory, readMemory, writeMemory } from './memory';
import { idempotencyKey, idempotentInflight, idempotentItem, limits, rememberIdempotent, startIdempotentInflight, type SlidingWindow } from './limits';
import { HARD_BLOCKS } from './safety';
import { presence } from './presence';
import { hasSubscriptions, notify, publicKey, saveSubscription } from './push';
import { abortActiveRuns, actOnCard, agentState, cancelTask, checkHermesHealth, confirmTask, deliverableAction, deliverableApproval, executeTool, moveTaskChannel, recoverOrphans, removeRoutine, reopenTask, runBrief, runCheckin, runRoutineNow, saveRoutine, setRoutineEnabled, startConnectorWatch, startHermesWatch, startUserTask, steerTask, stopMain, stopPage, submitSystem, submitUser } from './runner';
import { ftsQuery, search } from './search';
import { startScheduler } from './scheduler';
import { suggestedConnectors } from './suggestions';
import { trustRuleFromInput } from './trust';
import { downloadsPrompt, inboundIp, meetingPrompt, webhookMatches, webhookPrompt, type WatchedFile } from './triggers';
import { checkMeetings, meetingPrepEnabled, recordWebhook, recordWebhookIp, startFolderWatch, webhookIpReady, webhookReady, webhookToken } from './triggers-runtime';
import { MAX_UPLOAD_BYTES, checkBodySize, deleteUnlinkedUpload, isAudioMime, normalizeMime, prune, saveUpload, uploadDir } from './uploads';
import { parseMultipartCapped, type MultipartResult } from './multipart';
import { readLogin, vaults } from './vault';

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    // Every JSON route carries thread content, device state or a secret-shaped response. Nothing here belongs in a
    // browser or proxy cache; the static assets keep their explicit immutable cache instead.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const err = (status: number, error: string) => json({ error }, status);

/** Refuse an expensive mutation when its device budget is spent; `retry-after` tells the client when to return. */
function tooMany(bucket: SlidingWindow, device: string, what: string): Response | null {
  const { allowed, retryAfterMs } = bucket.check(device);
  if (allowed) return null;
  return json({ error: `too many ${what}`, code: 'too_many', retry_after_ms: retryAfterMs }, 429, {
    'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
  });
}

/** Read raw request bytes with a hard byte cap, including chunked bodies that have no Content-Length. */
export async function readBytesCapped(req: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new UserError('body too large', 413);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new UserError('body too large', 413);
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Read a request body as UTF-8 text with a hard byte cap, including chunked bodies that have no Content-Length. */
export async function readTextCapped(req: Request, limit: number): Promise<string> {
  return new TextDecoder().decode(await readBytesCapped(req, limit));
}

async function body<T = any>(req: Request, limit = 256_000): Promise<T> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    throw new UserError('expected JSON', 400);
  }
  const text = await readTextCapped(req, limit);
  if (!text) return {} as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UserError('invalid json', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UserError('invalid json', 400);
  }
  return parsed as T;
}

/** Refuse an oversized body before it is buffered; the upload paths check the same limit per file. */
function tooLarge(req: Request, limit: number): boolean {
  const n = Number(req.headers.get('content-length') ?? 0);
  return Number.isFinite(n) && n > limit;
}

/** The build the phone is talking to (`/api/version`), so drift after an upgrade is visible. */
const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(join(config.root, 'package.json'), 'utf8')).version ?? '0');
  } catch {
    return '0';
  }
})();

/** One rule for a chat message, wherever it arrives from: the app, the CLI, or the MCP shim's loopback call. */
const MAX_MESSAGE = 20_000;
function messageText(raw: unknown, hasFiles: boolean): string {
  return String(raw ?? '').trim() || (hasFiles ? 'Here’s a file.' : '');
}

/**
 * What the phone is told when a route throws. Validation messages we wrote ourselves ("no such channel", "empty
 * message") are useful and stay; anything that looks like an errno path, a Hermes body or a stack fragment is replaced
 * with a code, and the detail is logged against a request id the user can quote.
 */
const ERROR_CODES: Record<number, string> = { 400: 'bad_request', 401: 'not_paired', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 429: 'too_many', 503: 'unavailable', 500: 'internal' };
export function apiError(e: any, path: string): Response {
  const msg = String(e?.message ?? e ?? 'error');
  // A message a validator wrote for the person using the app (see server/errors.ts) keeps its own status and wording.
  // The heuristic below would otherwise call "a channel name needs at least one letter or number" a 500, and its
  // path/JSON filter would drop "can't take image/avif" because of the slash.
  if (e instanceof UserError) {
    const code = ERROR_CODES[e.status] ?? 'error';
    return json({ error: e.message, code, request_id: newId().slice(-8) }, e.status);
  }
  // An errno or a raw Error is an internal failure even when its text happens to say "no such file".
  const status = /ENOENT|EACCES|EPERM|Error:/i.test(msg)
    ? 500
    : /\b(no such|not found)\b/i.test(msg)
      ? 404
      : /already|expected|invalid|bad|empty|too (large|long|many)|missing|refus/i.test(msg)
        ? 400
        : 500;
  const id = newId().slice(-8);
  if (status >= 500) console.error(`[api] ${id}`, path, e?.stack ?? e);
  const code = ERROR_CODES[status] ?? 'error';
  const safe =
    (status === 400 || status === 404) &&
    msg.length <= 140 &&
    // Anything with a path, JSON, markup or a stack frame is an internal detail, not a sentence for a phone screen.
    !/[/\\{}<>]|\bat\s+\S|ENOENT|EACCES|EPERM|Error:/i.test(msg);
  return json({ error: safe ? msg : code, code, request_id: id }, status);
}

/**
 * What each API path accepts, so a wrong method gets 405 + Allow instead of a 404 that reads like the route is gone.
 * Only used after no branch matched; unknown paths still 404.
 */
const API_METHODS: [RegExp, string[]][] = [
  [/^\/api\/health$/, ['GET']],
  [/^\/api\/version$/, ['GET']],
  [/^\/api\/pair$/, ['POST']],
  [/^\/api\/state$/, ['GET']],
  [/^\/api\/items$/, ['GET']],
  [/^\/api\/items\/[\w-]+$/, ['GET']],
  [/^\/api\/channels$/, ['GET', 'POST']],
  [/^\/api\/channels\/[\w-]+$/, ['DELETE']],
  [/^\/api\/channels\/[\w-]+\/seen$/, ['POST']],
  [/^\/api\/channels\/[\w-]+\/items$/, ['GET']],
  [/^\/api\/routines$/, ['GET', 'POST']],
  [/^\/api\/routines\/[\w-]+$/, ['DELETE']],
  [/^\/api\/routines\/[\w-]+\/(run|pause|resume)$/, ['POST']],
  [/^\/api\/search$/, ['GET']],
  [/^\/api\/connectors$/, ['GET']],
  [/^\/api\/connectors\/[\w-]+\/test$/, ['POST']],
  [/^\/api\/triggers$/, ['GET']],
  [/^\/api\/events$/, ['GET']],
  [/^\/api\/capabilities$/, ['GET']],
  [/^\/api\/suggestions$/, ['GET']],
  [/^\/api\/memory$/, ['GET', 'PUT', 'DELETE']],
  [/^\/api\/policy$/, ['GET']],
  [/^\/api\/browser\/ws$/, ['GET']],
  [/^\/api\/browser\/(status|tabs|vaults)$/, ['GET']],
  [/^\/api\/browser\/(open|input|viewport|autofill)$/, ['POST']],
  [/^\/api\/messages$/, ['POST']],
  [/^\/api\/tasks$/, ['GET', 'POST']],
  [/^\/api\/tasks\/[\w-]+\/cancel$/, ['POST']],
  [/^\/api\/tasks\/[\w-]+\/confirm$/, ['POST']],
  [/^\/api\/tasks\/[\w-]+\/reopen$/, ['POST']],
  [/^\/api\/tasks\/[\w-]+\/message$/, ['POST']],
  [/^\/api\/tasks\/[\w-]+\/channel$/, ['POST']],
  [/^\/api\/trust-rules$/, ['GET', 'POST']],
  [/^\/api\/trust-rules\/[\w-]+$/, ['DELETE']],
  [/^\/api\/followups$/, ['GET', 'POST']],
  [/^\/api\/followups\/[\w-]+$/, ['DELETE']],
  [/^\/api\/followups\/[\w-]+\/resolve$/, ['POST']],
  [/^\/api\/gateways$/, ['GET', 'POST']],
  [/^\/api\/gateways\/[\w-]+$/, ['DELETE']],
  [/^\/api\/gateways\/[\w-]+\/select$/, ['POST']],
  [/^\/api\/uploads$/, ['POST']],
  [/^\/api\/uploads\/[\w-]+$/, ['GET', 'DELETE']],
  [/^\/api\/audio\/transcribe$/, ['POST']],
  [/^\/api\/audio\/transcribe\/[\w-]+$/, ['POST']],
  [/^\/api\/cards\/[\w-]+\/act$/, ['POST']],
  [/^\/api\/deliverables\/[\w-]+\/(action|approval)$/, ['POST']],
  [/^\/api\/runs\/stop$/, ['POST']],
  [/^\/api\/pages\/[\w-]+$/, ['DELETE']],
  [/^\/api\/files\/[\w-]+\/meta$/, ['GET']],
  [/^\/api\/files\/[\w-]+$/, ['GET']],
  [/^\/api\/files\/[\w-]+\/versions$/, ['POST']],
  [/^\/api\/settings$/, ['PUT']],
  [/^\/api\/brief\/run$/, ['POST']],
  [/^\/api\/brief\/[\w-]+\/audio$/, ['GET']],
  [/^\/api\/push\/(key)$/, ['GET']],
  [/^\/api\/push\/(subscribe|test)$/, ['POST']],
  [/^\/api\/presence$/, ['POST']],
];
function methodNotAllowed(path: string, method: string): Response | null {
  const allowed = API_METHODS.find(([re]) => re.test(path))?.[1];
  if (!allowed || allowed.includes(method)) return null;
  return json({ error: 'method_not_allowed', code: 'method_not_allowed', allow: allowed }, 405, { allow: allowed.join(', ') });
}

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/**
 * What the agent is told about the files a message came with. Paths, not bytes: the model reads them with its own file
 * or vision tools, so a photo never has to be base64'd through the chat transcript.
 */
function attachmentNote(rows: AttachmentRow[]): string {
  if (!rows.length) return '';
  const lines = rows.map((r) => `- ${r.path} (${r.mime}, ${kb(r.size)})${isAudioMime(r.mime) ? ' — a voice memo the user recorded' : ''}`);
  return `\n\nThe user attached ${rows.length === 1 ? 'a file' : `${rows.length} files`} with this message:\n${lines.join('\n')}\nLook at them with your file or vision tools before answering.`;
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

// The app shell only loads its own bundle. Agent text is sanitized before rendering, and this is the second lock.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

/** Strip local paths, URLs/ports, markup and stack fragments from route-specific error responses. */
function safeRouteMessage(e: unknown, fallback: string): string {
  if (e instanceof UserError) return e.message;
  const msg = String((e as any)?.message ?? e ?? '');
  if (!msg || msg.length > 200) return fallback;
  if (
    /([/\\{}<>]|https?:\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b|\blocalhost\b|ENOENT|EACCES|EPERM|Error:\s|\bat\s+\S|stderr)/i.test(
      msg,
    )
  ) {
    return fallback;
  }
  return msg;
}

function safeAudioError(e: unknown): string {
  if (e instanceof UserError) return e.message;
  const msg = String((e as any)?.message ?? '');
  const httpCode = msg.match(/^Transcription failed \((\d{3})\):/);
  if (httpCode) return `Transcription failed (${httpCode[1]})`;
  return 'Transcription failed';
}

const activeChannel = (id: string) => {
  const ch = channels.get(id);
  return ch && ch.archived_at == null ? ch : null;
};

async function resolveIdempotent(scope: string): Promise<Item | null> {
  for (;;) {
    const previous = idempotentItem(scope);
    if (previous) return items.get(previous) ?? null;
    const pending = idempotentInflight(scope);
    if (!pending) return null;
    const settledId = await pending;
    if (settledId) {
      const hit = items.get(settledId);
      if (hit) return hit;
    }
  }
}

async function withIdempotentBody<T>(
  req: Request,
  scopePrefix: string,
  onDuplicate: (item: Item) => Response,
  fn: (rawBody: T, remember: (id: string) => void) => Promise<Response> | Response,
): Promise<Response> {
  // Check cached/in-flight idempotency before burning per-device quota, and re-check after await body().
  const idem = idempotencyKey(req);
  const scope = idem ? `${scopePrefix}${idem}` : null;
  if (scope) {
    const existing = await resolveIdempotent(scope);
    if (existing) return onDuplicate(existing);
  }
  const rawBody = await body<T>(req);
  if (scope) {
    const existing = await resolveIdempotent(scope);
    if (existing) return onDuplicate(existing);
  }
  const finishIdem = scope ? startIdempotentInflight(scope) : null;
  let createdId: string | null = null;
  try {
    return await fn(rawBody, (id) => {
      createdId = id;
      if (scope) rememberIdempotent(scope, id);
    });
  } finally {
    finishIdem?.(createdId);
  }
}

function resolveAttachments(raw: unknown): { ids: string[]; rows: AttachmentRow[] } | { error: Response } {
  if (raw && !Array.isArray(raw)) return { error: err(400, 'attachment_ids must be a list') };
  const ids = Array.isArray(raw) ? raw.slice(0, 6).map(String) : [];
  const rows = ids.map((id) => attachments.get(id)).filter((r): r is AttachmentRow => !!r);
  if (rows.length !== ids.length) return { error: err(400, 'unknown attachment') };
  return { ids, rows };
}

async function readMultipart(
  req: Request,
  fields: string[],
  missingMsg: string,
): Promise<{ bytes: Uint8Array; mp: MultipartResult } | { error: Response }> {
  let mp: MultipartResult;
  try {
    mp = await parseMultipartCapped(req.body!, req.headers.get('content-type'), MAX_UPLOAD_BYTES, fields, join(uploadDir(), 'incoming'));
  } catch (e) {
    if (e instanceof UserError && e.status === 413) return { error: err(413, e.message) };
    return { error: err(400, missingMsg) };
  }
  if (!mp.file) return { error: err(400, missingMsg) };
  try {
    return { bytes: new Uint8Array(readFileSync(mp.file.path)), mp };
  } finally {
    rmSync(mp.file.path, { force: true });
  }
}

async function transcribeResponse(path: string, mime: string, attachment: ReturnType<typeof toAttachment>, logLabel: string): Promise<Response> {
  try {
    const text = await transcribeFile(path, mime);
    return json({ text, attachment });
  } catch (e: any) {
    if (!(e instanceof UserError)) console.error(logLabel, e?.stack ?? e);
    return json({ error: safeAudioError(e), attachment, text: '' }, 503);
  }
}

// ---------- public app server (the tunnel points here) ----------
export async function handleApp(req: Request, server?: any): Promise<Response> {
  const url = new URL(req.url);
  // Strip trailing slashes so `/api/items/` hits `/api/items` instead of falling through to static HTML.
  const rawPath = url.pathname;
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;

  if (path !== '/api' && !path.startsWith('/api/')) return serveStatic(req, rawPath);

  // Liveness for Docker, launchd and anything else watching this process. It reveals nothing and needs no pairing.
  if (path === '/api/health' && req.method === 'GET') return json({ ok: true, at: Date.now() });
  // Which build the phone is talking to, so client/server drift after an upgrade is visible instead of mysterious.
  if (path === '/api/version' && req.method === 'GET') return json({ version: VERSION });

  if (path === '/api/pair' && req.method === 'POST') {
    try {
      // The brake is checked before the code is even looked at, and says how long the wait is instead of "invalid code".
      const brake = pairBlocked();
      if (brake.blocked) {
        return json({ error: 'too many tries', code: 'too_many', retry_after_ms: brake.waitMs }, 429, {
          'retry-after': String(Math.max(1, Math.ceil(brake.waitMs / 1000))),
        });
      }
      const { code } = await body<{ code?: string }>(req);
      const token = await redeemPairCode(String(code ?? ''), req.headers.get('user-agent') ?? 'device');
      if (!token) return err(401, 'invalid or expired code');
      return json({ ok: true }, 200, { 'set-cookie': deviceCookie(token, isHttps(req)) });
    } catch (e: any) {
      return apiError(e, path);
    }
  }

  /**
   * Webhook ingress for GitHub, Stripe, Zapier, n8n or a plain curl. It is called by the outside world, so it cannot
   * carry a device cookie; the unguessable token in the URL is the credential, and it is the only one accepted.
   */
  const hookMatch = path.match(/^\/api\/webhooks\/([\w-]{8,64})$/);
  if (hookMatch && req.method === 'POST') {
    // Rate-limit per source IP BEFORE checking the token so invalid token guesses cannot brute-force unrestrictedly.
    const ip = inboundIp(req, server?.requestIP?.(req)?.address);
    if (!webhookIpReady(ip)) return err(429, 'too many webhooks');
    recordWebhookIp(ip);
    // The token is the only credential on this route: count it, throttle it per source, and never log it.
    if (!webhookMatches(webhookToken(), hookMatch[1])) return err(401, 'bad webhook token');
    if (tooLarge(req, 256_000)) return err(413, 'payload too large');
    if (!webhookReady()) return err(429, 'too many webhooks');
    const kindRaw = url.searchParams.get('kind') ?? '';
    let payload: unknown = null;
    const type = req.headers.get('content-type') ?? '';
    // A chunked webhook has no Content-Length, so the header gate above is not the cap: read with one too.
    let raw: string;
    try {
      raw = await readTextCapped(req, 256_000);
    } catch {
      return err(413, 'payload too large');
    }
    if (type.includes('application/json')) {
      try {
        payload = raw ? JSON.parse(raw) : null;
      } catch {
        payload = null;
      }
    } else {
      payload = raw;
    }
    // GitHub names its event in a header; without it the URL's ?kind= is the label, else "webhook".
    const kind = (req.headers.get('x-github-event') ?? kindRaw ?? 'webhook').replace(/[^\w.-]/g, '').slice(0, 40) || 'webhook';
    recordWebhook();
    triggers.save({ id: `trigger-webhook-${kind}`, kind: 'webhook', config: { kind }, last_triggered_at: Date.now() });
    submitSystem(`Webhook received (${kind}).`, webhookPrompt(kind, payload, Date.now(), settings.get().timezone));
    return json({ ok: true, queued: true });
  }

  const device = await deviceFor(req);
  if (!device) return err(401, 'not paired');
  if (req.method !== 'GET' && !sameOrigin(req)) return err(403, 'bad origin');

  try {
    if (path === '/api/state' && req.method === 'GET') {
      const page = items.latest(150);
      const recentTasks = tasks.recent();
      const finishedTasks = recentTasks.filter((t) => ['done', 'failed', 'cancelled'].includes(t.status));
      const oldestFinishedAt = finishedTasks.length ? Math.min(...finishedTasks.map((t) => t.updated_at)) : Date.now() - 7 * 86400_000;
      const snap: Snapshot = {
        items: page.items,
        has_more: page.has_more,
        pending: items.pendingCards(),
        tasks: recentTasks,
        has_more_tasks: tasks.hasOlder(oldestFinishedAt),
        routines: routines.all(),
        files: files.all(),
        pages: pages.all(),
        channels: channels.all(),
        trust_rules: trustRules.all(),
        follow_ups: followUps.all(),
        gateways: gateways.list(),
        settings: settings.get(),
        agent: agentState(),
        push_enabled: hasSubscriptions(device),
      };
      return json(snap);
    }
    if (path === '/api/items' && req.method === 'GET') {
      const before = url.searchParams.get('before') ?? '';
      const channel = url.searchParams.get('channel') ?? '';
      if (channel && !activeChannel(channel)) return err(404, 'no such channel');
      if (!before) return json(items.latest(100, channel || undefined));
      return json(items.before(before, 100, channel || undefined));
    }
    const itemMatch = path.match(/^\/api\/items\/([\w-]+)$/);
    if (itemMatch && req.method === 'GET') {
      const item = items.get(itemMatch[1]);
      return item ? json({ item }) : err(404, 'no such item');
    }

    // ---- topic channels (see server/channels.ts) ----
    if (path === '/api/channels' && req.method === 'GET') return json({ channels: channels.all() });
    if (path === '/api/channels' && req.method === 'POST') {
      const rawBody = await body(req);
      // An `id` of a channel that is still open edits it (the sheet's save path); anything else creates.
      if (typeof (rawBody as any)?.id === 'string' && (rawBody as any).id) {
        const existing = activeChannel((rawBody as any).id);
        if (!existing) return err(404, 'no such channel');
        const channel = channels.update(existing.id, channelPatch(rawBody));
        broadcast({ type: 'channel', channel: channel! });
        return json({ channel });
      }
      const channel = channels.create(channelInput(rawBody));
      broadcast({ type: 'channel', channel });
      return json({ channel });
    }
    const channelMatch = path.match(/^\/api\/channels\/([\w-]+)$/);
    if (channelMatch && req.method === 'DELETE') {
      if (!channels.archive(channelMatch[1])) return err(404, 'no such channel');
      broadcast({ type: 'channel_removed', id: channelMatch[1] });
      return json({ ok: true });
    }
    const channelSeen = path.match(/^\/api\/channels\/([\w-]+)\/seen$/);
    if (channelSeen && req.method === 'POST') {
      if (!activeChannel(channelSeen[1])) return err(404, 'no such channel');
      channels.seen(channelSeen[1]);
      return json({ ok: true });
    }
    const channelItems = path.match(/^\/api\/channels\/([\w-]+)\/items$/);
    if (channelItems && req.method === 'GET') {
      if (!activeChannel(channelItems[1])) return err(404, 'no such channel');
      const before = url.searchParams.get('before') ?? '';
      if (before) return json(items.before(before, 100, channelItems[1]));
      return json(items.latest(100, channelItems[1]));
    }

    // ---- user-defined recurring routines ----
    if (path === '/api/routines' && req.method === 'GET') return json({ routines: routines.all() });
    if (path === '/api/routines' && req.method === 'POST') {
      // `id` edits (the sheet's save path) exactly like the tool's routine_id; anything else creates.
      const routine = saveRoutine(await body<Record<string, unknown>>(req));
      return json({ routine });
    }
    const routineMatch = path.match(/^\/api\/routines\/([\w-]+)$/);
    if (routineMatch && req.method === 'DELETE') {
      if (!removeRoutine(routineMatch[1])) return err(404, 'no such routine');
      return json({ ok: true });
    }
    const routineAction = path.match(/^\/api\/routines\/([\w-]+)\/(run|pause|resume)$/);
    if (routineAction && req.method === 'POST') {
      const id = routineAction[1];
      if (routineAction[2] === 'run') return json({ routine: runRoutineNow(id) });
      const routine = setRoutineEnabled(id, routineAction[2] === 'resume');
      if (!routine) return err(404, 'no such routine');
      return json({ routine });
    }

    // ---- global search over the thread, tasks, files and pages ----
    if (path === '/api/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const parsed = ftsQuery(q);
      if (!parsed) return json({ hits: [], terms: [] });
      return json({ hits: search(db, q, Number(url.searchParams.get('limit') ?? 20) || 20), terms: parsed.terms });
    }

    // ---- native connectors (see server/connectors.ts) ----
    if (path === '/api/connectors' && req.method === 'GET') return json({ connectors: await listConnectors() });
    const connectorTest = path.match(/^\/api\/connectors\/([\w-]+)\/test$/);
    if (connectorTest && req.method === 'POST') return json({ connector: await testConnector(connectorTest[1]) });

    // ---- event triggers ----
    if (path === '/api/triggers' && req.method === 'GET') {
      const base = config.publicUrl || `http://${req.headers.get('host') ?? `127.0.0.1:${config.port}`}`;
      return json({
        webhook_url: `${base.replace(/\/$/, '')}/api/webhooks/${webhookToken()}`,
        watch_dir: config.watchDir || null,
        meeting_lead_minutes: config.meetingLeadMinutes,
        triggers: triggers.all(),
      });
    }
    if (path === '/api/events' && req.method === 'GET') return sseResponse(req);
    if (path === '/api/capabilities' && req.method === 'GET') return json(await capabilities());
    // Read-only discovery: what is already connected, plus up to three suggestions the user can act on by hand.
    if (path === '/api/suggestions' && req.method === 'GET') {
      const [caps, connectors] = await Promise.all([capabilities(), listConnectors()]);
      return json({
        suggestions: suggestedConnectors({ capabilities: caps, connectors, channels: channels.all() }),
        connected: { toolsets: caps.toolsets, apps: caps.apps, connectors },
      });
    }

    // ---- memory: the context file the agent starts each turn with ----
    if (path === '/api/memory' && req.method === 'GET') return json(readMemory());
    if (path === '/api/memory' && req.method === 'PUT') {
      // The cap is on the text, not the JSON envelope: read a little past it so the size check below is what
      // answers 413, and a body too large to read is the same answer rather than a generic 400.
      let raw: string;
      try {
        raw = await readTextCapped(req, MEMORY_MAX_BYTES + 4096);
      } catch {
        return err(413, 'memory is too large');
      }
      let text: unknown;
      try {
        text = (raw ? JSON.parse(raw) : {})?.text;
      } catch {
        return err(400, 'expected JSON');
      }
      if (typeof text !== 'string') return err(400, 'text must be a string');
      return json(writeMemory(text));
    }
    if (path === '/api/memory' && req.method === 'DELETE') return json(clearMemory());

    // The deterministic trust floor around approvals: what is always refused, even with an approval card.
    if (path === '/api/policy' && req.method === 'GET') return json({ blocks: HARD_BLOCKS });

    // ---- live browser pane (see server/browser.ts) ----
    if (path === '/api/browser/ws' && req.method === 'GET') {
      if (!sameOrigin(req)) return err(403, 'bad origin');
      if (!server) return err(500, 'no websocket server');
      return server.upgrade(req, { data: { kind: 'browser' } }) ? (undefined as any) : err(400, 'upgrade failed');
    }
    if (path === '/api/browser/status' && req.method === 'GET') return json(browser.status());
    if (path === '/api/browser/tabs' && req.method === 'GET') return json({ tabs: await browser.buildTabs() });
    if (path === '/api/browser/open' && req.method === 'POST') return json({ tabs: await browser.open() });
    if (path === '/api/browser/input' && req.method === 'POST') {
      const evt = await body<Record<string, unknown>>(req);
      // browser.input validates and clamps the payload (normalizeInput); nothing raw reaches CDP.
      await browser.input(evt);
      return json({ ok: true });
    }
    if (path === '/api/browser/viewport' && req.method === 'POST') {
      const { mode } = await body<{ mode?: string }>(req);
      return json({ mode: await browser.setViewport(mode) });
    }
    if (path === '/api/browser/vaults' && req.method === 'GET') return json({ vaults: await vaults() });
    if (path === '/api/browser/autofill' && req.method === 'POST') {
      const { provider } = await body<{ provider?: string }>(req);
      const which = provider === '1password' || provider === 'bitwarden' ? provider : undefined;
      let host = '';
      try {
        host = await browser.currentHost();
        const origin = await browser.currentOrigin();
        const login = await readLogin(host, which);
        try {
          const filled = await browser.fillLogin(login.username, login.password, origin || host);
          if (!filled.pass) return err(400, `Found the ${login.vault} login for ${host}, but there is no password field on the page.`);
          return json({ host, vault: login.vault, filled });
        } finally {
          // The credentials live no longer than this request.
          login.password = '';
        }
      } catch (e: any) {
        if (e instanceof UserError) return err(e.status, e.message);
        const safe = safeRouteMessage(e, 'Autofill failed');
        if (safe === 'Autofill failed') console.error('[autofill]', e?.stack ?? e);
        return err(400, safe);
      }
    }

    if (path === '/api/messages' && req.method === 'POST') {
      return withIdempotentBody<{ text?: string; channel_id?: string; attachment_ids?: string[] }>(
        req,
        `${device}:`,
        (existing) => json({ item: existing, duplicate: true }),
        ({ text, channel_id, attachment_ids }, remember) => {
          if (channel_id && !activeChannel(String(channel_id))) return err(404, 'no such channel');
          const limited = tooMany(limits.messages, device, 'messages');
          if (limited) return limited;
          const att = resolveAttachments(attachment_ids);
          if ('error' in att) return att.error;
          const { ids, rows } = att;
          const t = messageText(text, rows.length > 0);
          if (!t) return err(400, 'empty message');
          if (t.length > MAX_MESSAGE) return err(400, 'message too long');
          const note = attachmentNote(rows);
          const item = submitUser(t, note ? `${t}${note}` : undefined, channel_id, rows.map(toAttachment));
          if (rows.length) attachments.link(ids, item.id);
          remember(item.id);
          return json({ item });
        },
      );
    }
    if (path === '/api/tasks' && req.method === 'GET') {
      const beforeParam = url.searchParams.get('before');
      const before = beforeParam ? Number(beforeParam) : Date.now();
      if (!Number.isFinite(before) || before <= 0) return err(400, 'invalid before cursor');
      const limit = Number(url.searchParams.get('limit') ?? 40) || 40;
      return json(tasks.older(before, limit));
    }
    if (path === '/api/tasks' && req.method === 'POST') {
      return withIdempotentBody<{ text?: string; channel_id?: string; attachment_ids?: string[] }>(
        req,
        `task:${device}:`,
        (existing) => {
          const task = existing.task_id ? tasks.get(existing.task_id) : undefined;
          return json({ item: existing, ...(task ? { task } : {}), duplicate: true });
        },
        ({ text, channel_id, attachment_ids }, remember) => {
          if (channel_id && !activeChannel(String(channel_id))) return err(404, 'no such channel');
          const limited = tooMany(limits.tasks, device, 'tasks');
          if (limited) return limited;
          const att = resolveAttachments(attachment_ids);
          if ('error' in att) return att.error;
          const { ids, rows } = att;
          const t = String(text ?? '').trim() || (rows.length ? 'Look at the file I attached.' : '');
          if (!t) return err(400, 'empty message');
          if (t.length > MAX_MESSAGE) return err(400, 'message too long');
          const started = startUserTask(t, channel_id, rows.map(toAttachment), attachmentNote(rows));
          if (rows.length) attachments.link(ids, started.item.id);
          remember(started.item.id);
          return json(started);
        },
      );
    }

    // ---- uploads, voice memos and spoken briefs (see server/uploads.ts, server/audio.ts) ----
    if (path === '/api/uploads' && req.method === 'POST') {
      const limited = tooMany(limits.uploads, device, 'uploads');
      if (limited) return limited;
      // Same ceiling as uploads.ts, enforced while streaming so chunked bodies are bounded too.
      if (tooLarge(req, MAX_UPLOAD_BYTES)) return err(413, 'that file is too large');
      const parsed = await readMultipart(req, ['file'], 'send the file in a "file" field');
      if ('error' in parsed) return parsed.error;
      const { bytes, mp } = parsed;
      return json({ attachment: saveUpload({ bytes, mime: normalizeMime(mp.fields.mime ?? mp.file!.mime), filename: String(mp.fields.name ?? mp.file!.filename) }) });
    }
    const uploadMatch = path.match(/^\/api\/uploads\/([\w-]+)$/);
    if (uploadMatch && req.method === 'GET') return serveUpload(req, uploadMatch[1]);
    if (uploadMatch && req.method === 'DELETE') {
      deleteUnlinkedUpload(uploadMatch[1]);
      return json({ ok: true, id: uploadMatch[1] });
    }

    if (path === '/api/audio/transcribe' && req.method === 'POST') {
      const limited = tooMany(limits.transcribe, device, 'transcriptions');
      if (limited) return limited;
      if (tooLarge(req, MAX_UPLOAD_BYTES)) return err(413, 'that recording is too large');
      let bytes: Uint8Array;
      let mime: string;
      if ((req.headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data')) {
        const parsed = await readMultipart(req, ['audio', 'file'], 'send the recording in an "audio" field');
        if ('error' in parsed) return parsed.error;
        bytes = parsed.bytes;
        mime = normalizeMime(parsed.mp.file!.mime);
      } else {
        try {
          bytes = await readBytesCapped(req, MAX_UPLOAD_BYTES);
        } catch (e) {
          if (e instanceof UserError && e.status === 413) return err(413, 'that recording is too large');
          throw e;
        }
        mime = normalizeMime(req.headers.get('content-type'));
      }
      // A missing or chunked content-length bypasses tooLarge; the hard cap on the buffered bytes is the real gate.
      try {
        checkBodySize(bytes.byteLength);
      } catch {
        return err(413, 'that recording is too large');
      }
      if (!isAudioMime(mime)) return err(400, 'send an audio recording');
      // The memo is kept even when transcription is unavailable, so it can be replayed and retried later.
      const attachment = saveUpload({ bytes, mime, filename: 'Voice memo' });
      const row = attachments.get(attachment.id)!;
      return transcribeResponse(row.path, row.mime, attachment, '[audio] transcribe failed');
    }

    const transcribeIdMatch = path.match(/^\/api\/audio\/transcribe\/([\w-]+)$/);
    if (transcribeIdMatch && req.method === 'POST') {
      const limited = tooMany(limits.transcribe, device, 'transcriptions');
      if (limited) return limited;
      const row = attachments.get(transcribeIdMatch[1]);
      if (!row) return err(404, 'attachment not found');
      if (!isAudioMime(row.mime)) return err(400, 'attachment is not audio');
      if (!existsSync(row.path)) return err(404, 'attachment file not found');
      return transcribeResponse(row.path, row.mime, toAttachment(row), '[audio] transcribe retry failed');
    }

    // "Listen" on the morning brief: synthesized once, then served from data/tts.
    const briefAudio = path.match(/^\/api\/brief\/([\w-]+)\/audio$/);
    if (briefAudio && req.method === 'GET') {
      const limited = tooMany(limits.briefAudio, device, 'brief audio requests');
      if (limited) return limited;
      const item = items.get(briefAudio[1]);
      if (!item?.card || item.card.type !== 'brief') return err(404, 'no such brief');
      const voiceParam = url.searchParams.get('voice');
      const voice = (voiceParam !== null ? voiceParam : settings.get().tts_voice) || undefined;
      const clip = await speak(briefSpeech(item.card), { voice });
      return serveRangedFile(req, clip.path, {
        'content-type': clip.mime,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      });
    }

    const cardMatch = path.match(/^\/api\/cards\/([\w-]+)\/act$/);
    if (cardMatch && req.method === 'POST') {
      const { action, value } = await body<{ action?: string; value?: string }>(req);
      const item = await actOnCard(cardMatch[1], String(action ?? ''), value);
      return json({ item });
    }

    if (path === '/api/runs/stop' && req.method === 'POST') {
      await stopMain();
      return json({ ok: true });
    }
    const taskMatch = path.match(/^\/api\/tasks\/([\w-]+)\/cancel$/);
    if (taskMatch && req.method === 'POST') {
      await cancelTask(taskMatch[1]);
      return json({ ok: true });
    }
    // The user's own completion is the real one; the agent's done only ever "looks done".
    const taskConfirm = path.match(/^\/api\/tasks\/([\w-]+)\/(confirm|reopen)$/);
    if (taskConfirm && req.method === 'POST') {
      const task = taskConfirm[2] === 'confirm' ? confirmTask(taskConfirm[1]) : reopenTask(taskConfirm[1]);
      return json({ task });
    }
    // Steering a running task mid-flight: the same budget as a chat message, the same cap, and a 409 — not a
    // silent queue — when the task has no live run to steer.
    const taskMessage = path.match(/^\/api\/tasks\/([\w-]+)\/message$/);
    if (taskMessage && req.method === 'POST') {
      const limited = tooMany(limits.messages, device, 'messages');
      if (limited) return limited;
      const { text } = await body<{ text?: string }>(req);
      const t = String(text ?? '');
      if (!t.trim()) return err(400, 'empty message');
      if (t.length > MAX_MESSAGE) return err(400, 'message too long');
      const { delivered } = await steerTask(taskMessage[1], t);
      return json({ task: tasks.get(taskMessage[1]), delivered });
    }
    const taskChannel = path.match(/^\/api\/tasks\/([\w-]+)\/channel$/);
    if (taskChannel && req.method === 'POST') {
      const { channel_id } = await body<{ channel_id?: string }>(req);
      const cid = String(channel_id ?? '').trim();
      if (!cid) return err(400, 'missing channel_id');
      return json({ task: moveTaskChannel(taskChannel[1], cid) });
    }

    // ---- "Don't ask again" trust rules (low-risk only) ----
    if (path === '/api/trust-rules' && req.method === 'GET') return json({ trust_rules: trustRules.all() });
    if (path === '/api/trust-rules' && req.method === 'POST') {
      const rawBody = await body<Record<string, unknown>>(req);
      const rule = trustRuleFromInput(rawBody, newId());
      trustRules.save(rule);
      broadcast({ type: 'trust_rule', rule });
      return json({ rule });
    }
    const trustRuleMatch = path.match(/^\/api\/trust-rules\/([\w-]+)$/);
    if (trustRuleMatch && req.method === 'DELETE') {
      if (!trustRules.remove(trustRuleMatch[1])) return err(404, 'no such trust rule');
      broadcast({ type: 'trust_rule_removed', id: trustRuleMatch[1] });
      return json({ ok: true });
    }

    // ---- tracked follow-ups (outbound threads awaiting reply) ----
    if (path === '/api/followups' && req.method === 'GET') return json({ follow_ups: followUps.all() });
    if (path === '/api/followups' && req.method === 'POST') {
      const rawBody = await body<Record<string, unknown>>(req);
      const title = String(rawBody.title ?? '').trim().slice(0, 160);
      if (!title) return err(400, 'missing title');
      const recipient = typeof rawBody.recipient === 'string' && rawBody.recipient.trim() ? rawBody.recipient.trim().slice(0, 140) : undefined;
      const destination = typeof rawBody.destination === 'string' && rawBody.destination.trim() ? rawBody.destination.trim().slice(0, 200) : undefined;
      const notes = typeof rawBody.notes === 'string' && rawBody.notes.trim() ? rawBody.notes.trim().slice(0, 500) : undefined;
      const channel_id = typeof rawBody.channel_id === 'string' && rawBody.channel_id.trim() ? rawBody.channel_id.trim() : null;
      if (channel_id && !activeChannel(channel_id)) return err(404, 'no such channel');
      const now = Date.now();
      let due_at = typeof rawBody.due_at === 'number' && Number.isFinite(rawBody.due_at) && rawBody.due_at > now ? Math.round(rawBody.due_at) : 0;
      if (!due_at) {
        const hrsRaw = typeof rawBody.due_hours === 'number' && Number.isFinite(rawBody.due_hours) ? rawBody.due_hours : 48;
        due_at = now + Math.round(Math.max(1, Math.min(2160, hrsRaw)) * 3600_000);
      }
      const followup: TrackedFollowUp = {
        id: newId(),
        title,
        ...(recipient ? { recipient } : {}),
        ...(destination ? { destination } : {}),
        channel_id,
        due_at,
        status: 'open',
        ...(notes ? { notes } : {}),
        created_at: now,
        updated_at: now,
      };
      followUps.save(followup);
      broadcast({ type: 'followup', followup });
      return json({ followup });
    }
    const followUpResolve = path.match(/^\/api\/followups\/([\w-]+)\/resolve$/);
    if (followUpResolve && req.method === 'POST') {
      const existing = followUps.get(followUpResolve[1]);
      if (!existing) return err(404, 'no such follow-up');
      const rawBody = await body<{ status?: string }>(req);
      const status = rawBody.status === 'dismissed' ? 'dismissed' : 'resolved';
      const now = Date.now();
      const updated: TrackedFollowUp = { ...existing, status, updated_at: now, resolved_at: now };
      followUps.save(updated);
      broadcast({ type: 'followup', followup: updated });
      return json({ followup: updated });
    }
    const followUpMatch = path.match(/^\/api\/followups\/([\w-]+)$/);
    if (followUpMatch && req.method === 'DELETE') {
      if (!followUps.remove(followUpMatch[1])) return err(404, 'no such follow-up');
      broadcast({ type: 'followup_removed', id: followUpMatch[1] });
      return json({ ok: true });
    }

    // ---- multi-gateway machine profiles ----
    if (path === '/api/gateways' && req.method === 'GET') return json(gateways.list());
    if (path === '/api/gateways' && req.method === 'POST') {
      const rawBody = await body<{ name?: string; url?: string }>(req);
      const { profile, state } = gateways.add({ name: String(rawBody.name ?? ''), url: String(rawBody.url ?? '') });
      broadcast({ type: 'gateways', gateways: state });
      return json({ profile, ...state });
    }
    const gatewaySelect = path.match(/^\/api\/gateways\/([\w-]+)\/select$/);
    if (gatewaySelect && req.method === 'POST') {
      const state = gateways.select(gatewaySelect[1]);
      broadcast({ type: 'gateways', gateways: state });
      void checkHermesHealth();
      return json(state);
    }
    const gatewayMatch = path.match(/^\/api\/gateways\/([\w-]+)$/);
    if (gatewayMatch && req.method === 'DELETE') {
      const state = gateways.remove(gatewayMatch[1]);
      broadcast({ type: 'gateways', gateways: state });
      void checkHermesHealth();
      return json(state);
    }
    const pageMatch = path.match(/^\/api\/pages\/([\w-]+)$/);
    if (pageMatch && req.method === 'DELETE') {
      await stopPage(pageMatch[1]);
      return json({ ok: true });
    }

    const fileMetaMatch = path.match(/^\/api\/files\/([\w-]+)\/meta$/);
    if (fileMetaMatch && req.method === 'GET') {
      const f = files.get(fileMetaMatch[1]);
      return f ? json({ file: f.entry }) : err(404, 'no such file');
    }

    const fileMatch = path.match(/^\/api\/files\/([\w-]+)$/);
    if (fileMatch && req.method === 'GET') return await serveFile(fileMatch[1], url.searchParams.has('download'));

    // ---- editing a delivered file: save the text as a new version, keeping the original ----
    const fileVersionMatch = path.match(/^\/api\/files\/([\w-]*)\/versions$/);
    if (fileVersionMatch && req.method === 'POST') {
      const existing = fileVersionMatch[1] ? files.get(fileVersionMatch[1]) : null;
      if (!existing) return err(404, 'no such file');
      // The cap is on the text, but JSON escaping can double its size (a file of newlines or quotes), so the
      // door leaves room for that; the text itself is measured by saveFileVersion, which answers 413.
      const limit = MAX_EDIT_BYTES * 2 + 4096;
      if (tooLarge(req, limit)) return err(413, `edited files are limited to ${MAX_EDIT_BYTES / 1024 / 1024} MB`);
      let raw: string;
      try {
        raw = await readTextCapped(req, limit);
      } catch {
        return err(413, `edited files are limited to ${MAX_EDIT_BYTES / 1024 / 1024} MB`);
      }
      let text: unknown;
      try {
        text = (JSON.parse(raw || '{}') as { text?: unknown } | null)?.text;
      } catch {
        return err(400, 'send the file text as JSON');
      }
      if (typeof text !== 'string') return err(400, 'send the file text as JSON');
      const entry = saveFileVersion(existing.entry, text);
      broadcast({ type: 'file', file: entry });
      return json({ file: entry });
    }

    // ---- interactive deliverables: buttons inside a delivered dashboard ----
    const deliverable = path.match(/^\/api\/deliverables\/([\w-]+)\/(action|approval)$/);
    if (deliverable && req.method === 'POST') {
      const file = files.get(deliverable[1]);
      if (!file) return err(404, 'no such file');
      const bodyIn = await body<Record<string, unknown>>(req);
      if (deliverable[2] === 'approval') {
        const item = deliverableApproval(file.entry, bodyIn);
        return json({ item });
      }
      return json({ item: deliverableAction(file.entry, bodyIn) });
    }

    if (path === '/api/settings' && req.method === 'PUT') {
      const patch = await body<Record<string, unknown>>(req);
      if (patch.timezone !== undefined) {
        if (typeof patch.timezone !== 'string' || !patch.timezone.trim()) throw new UserError('invalid timezone', 400);
        const tz = patch.timezone.trim();
        try {
          new Intl.DateTimeFormat(undefined, { timeZone: tz });
        } catch {
          throw new UserError('invalid timezone', 400);
        }
        patch.timezone = tz;
      }
      const next = settings.update(patch);
      broadcast({ type: 'settings', settings: next });
      return json({ settings: next });
    }
    if (path === '/api/brief/run' && req.method === 'POST') {
      // A brief starts a full Hermes turn; six in ten minutes is generous for "Run it now" and hard to loop by accident.
      const limited = tooMany(limits.briefs, device, 'brief runs');
      if (limited) return limited;
      const queued = runBrief('manual');
      return json({ ok: true, queued });
    }
    if (path === '/api/push/key' && req.method === 'GET') return json({ key: publicKey });
    if (path === '/api/push/subscribe' && req.method === 'POST') {
      try {
        saveSubscription(await body(req), device);
      } catch (e) {
        if (e instanceof UserError) throw e;
        if (e instanceof TypeError) throw new UserError('invalid push subscription', 400);
        throw e;
      }
      return json({ ok: true });
    }
    if (path === '/api/presence' && req.method === 'POST') {
      const { client, visible } = await body<{ client?: string; visible?: boolean }>(req);
      const id = String(client ?? '');
      if (!/^[\w-]{8,64}$/.test(id)) return err(400, 'bad client');
      presence.report(device, id, visible === true);
      return json({ ok: true });
    }
    if (path === '/api/push/test' && req.method === 'POST') {
      const limited = tooMany(limits.pushTests, device, 'test notifications');
      if (limited) return limited;
      const sent = await notify({ title: 'Hermes Duet', body: 'Notifications are working.', always: true }, { ignoreQuiet: true, ignorePrefs: true });
      return json({ sent });
    }
    return methodNotAllowed(path, req.method) ?? err(404, 'not found');
  } catch (e: any) {
    return apiError(e, path);
  }
}

// Most sites refuse to load inside the viewer's frame (X-Frame-Options), so a link to another page opens a new tab.
// Links within the same page (#section) still scroll in place.
const LINK_SHIM = `<script>addEventListener('click',function(e){var a=e.target instanceof Element&&e.target.closest('a[href]');if(!a||(a.target&&a.target!=='_self'))return;var u=new URL(a.href,location.href);if(!/^https?:$/.test(u.protocol)||u.href.split('#')[0]===location.href.split('#')[0])return;a.target='_blank';a.rel='noopener'},true)</script>`;

/**
 * The bridge every delivered HTML file gets: a dashboard the agent built can call back into Duet from its own
 * buttons. The frame is sandboxed without same-origin, so it can only post a message; the app decides what a message
 * means (a user turn, or an approval card) and the payload is validated there. Actions are lowercase identifiers and
 * payloads are plain data, so nothing here can become a URL or a command.
 */
const DELIVERABLE_BRIDGE = `<script>(function(){
  function post(kind,data){try{parent.postMessage({type:'duet_'+kind,data:data},'*')}catch(e){}}
  window.Duet={
    version:1,
    sendAction:function(action,payload){
      var name=String(action==null?'':action).slice(0,64);
      if(!name)return;
      post('action',{action:name,payload:payload===undefined?null:payload});
    },
    requestApproval:function(data){
      var d=data||{};
      post('approval',{title:String(d.title||'').slice(0,140),summary:String(d.summary||'').slice(0,4000),action_label:String(d.action_label||'').slice(0,30)});
    }
  };
  document.documentElement.setAttribute('data-duet','1');
})()</script>`;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function mimeTypeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function fileBody(path: string, opts?: { start?: number; end?: number }): BodyInit {
  return Readable.toWeb(createReadStream(path, opts)) as unknown as BodyInit;
}

/**
 * Serve a file with HTTP byte-range support (`Accept-Ranges: bytes`, `206 Partial Content`, `416` on out-of-range)
 * so iOS Safari / AVFoundation media playback and seeking work reliably.
 */
function serveRangedFile(req: Request, path: string, headers: Record<string, string>): Response {
  const size = statSync(path).size;
  const baseHeaders: Record<string, string> = { ...headers, 'accept-ranges': 'bytes' };
  const rangeHeader = req.headers.get('range');
  if (!rangeHeader) {
    return new Response(fileBody(path), {
      status: 200,
      headers: { ...baseHeaders, 'content-length': String(size) },
    });
  }
  const trimmed = rangeHeader.trim();
  if (!/^bytes=/i.test(trimmed)) {
    return new Response(fileBody(path), {
      status: 200,
      headers: { ...baseHeaders, 'content-length': String(size) },
    });
  }
  const spec = trimmed.slice(6).trim();
  if (spec.includes(',')) {
    // Multi-range requests are optional under RFC 9110; serve the full representation when multiple ranges are requested.
    return new Response(fileBody(path), {
      status: 200,
      headers: { ...baseHeaders, 'content-length': String(size) },
    });
  }
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (match[1] === '' && match[2] === '') || size === 0) {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, 'content-range': `bytes */${size}` },
    });
  }
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'content-range': `bytes */${size}` },
      });
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'content-range': `bytes */${size}` },
      });
    }
  }
  const length = end - start + 1;
  return new Response(fileBody(path, { start, end }), {
    status: 206,
    headers: {
      ...baseHeaders,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(length),
    },
  });
}

/**
 * An upload is served inline for the thread's thumbnails and the voice memo player, but sandboxed: an SVG is markup,
 * and it must never run script with this app's origin and cookie behind it.
 */
async function serveUpload(req: Request, id: string): Promise<Response> {
  const row = attachments.get(id);
  if (!row || !existsSync(row.path)) return err(404, 'file not found');
  return serveRangedFile(req, row.path, {
    'content-type': row.mime,
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
}

async function serveFile(id: string, download: boolean): Promise<Response> {
  const f = files.get(id);
  if (!f || !existsSync(f.path)) return err(404, 'file not found');
  const headers: Record<string, string> = {
    'content-type': f.entry.mime,
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    // Agent-made HTML runs in an opaque origin: scripts yes, cookies/API access no. Tabs it opens are ordinary pages.
    'content-security-policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals; frame-ancestors \'self\'',
  };
  if (download) headers['content-disposition'] = `attachment; filename="${f.entry.name.replace(/["\\\r\n]/g, '_')}"`;
  else if (f.entry.mime === 'text/html') return new Response(readFileSync(f.path, 'utf8') + LINK_SHIM + DELIVERABLE_BRIDGE, { headers });
  return new Response(fileBody(f.path), { headers });
}

/** True only for a regular file: a directory is not something the app shell can serve as a body. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

async function serveStatic(req: Request, path: string): Promise<Response> {
  // Reject malformed URL escapes before routing so bad paths return 400 rather than a 500 stack trace.
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return new Response('Bad request', { status: 400, headers: SECURITY_HEADERS });
  }
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const candidate = join(config.webDir, rel);
  const webDirRoot = config.webDir.endsWith(sep) ? config.webDir : `${config.webDir}${sep}`;
  const rawUrlPath = rel.replaceAll('\\', '/');
  const urlPath = rawUrlPath.startsWith('/') ? rawUrlPath : `/${rawUrlPath}`;
  // Require a regular file (directories pass existsSync and fail with EISDIR) so directory paths fall back to index.html.
  if ((candidate === config.webDir || candidate.startsWith(webDirRoot)) && urlPath !== '/' && isFile(candidate)) {
    // The build writes `.br`/`.gz` siblings; serve one when the client accepts it. The type comes from the original
    // path, not the `.br` sibling.
    const encoding = preferredEncoding(req);
    const encoded = encoding ? encodedPath(candidate, encoding, isFile) : null;
    const immutable = urlPath.startsWith('/assets/');
    return new Response(fileBody(encoded ?? candidate), {
      headers: {
        ...SECURITY_HEADERS,
        ...encodingHeaders(encoded ? encoding : null),
        'content-type': mimeTypeFor(candidate),
        ...(urlPath.endsWith('.html') ? { 'content-security-policy': APP_CSP } : {}),
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...(urlPath === '/sw.js' ? { 'service-worker-allowed': '/' } : {}),
      },
    });
  }
  const index = join(config.webDir, 'index.html');
  if (!isFile(index)) return new Response('Web app not built. Run: npm run build', { status: 503 });
  const encoding = preferredEncoding(req);
  const encoded = encoding ? encodedPath(index, encoding, isFile) : null;
  return new Response(fileBody(encoded ?? index), {
    headers: {
      ...SECURITY_HEADERS,
      ...encodingHeaders(encoded ? encoding : null),
      'content-security-policy': APP_CSP,
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
    },
  });
}

/** Setup checks for `hermes-duet doctor`. Never returns secret values. */
async function doctor() {
  const checks: { name: string; ok: boolean; detail: string; info?: boolean }[] = [];
  const add = (name: string, ok: boolean, detail: string, info = false) => checks.push({ name, ok, detail, info });
  add('web app built', existsSync(join(config.webDir, 'index.html')), existsSync(join(config.webDir, 'index.html')) ? config.webDir : 'run: bun run build');
  const up = await hermes.health();
  add('Hermes gateway reachable', up, up ? config.hermesUrl : `nothing answering at ${config.hermesUrl}`);
  if (!hermes.hasKey()) add('Hermes API key', false, 'set API_SERVER_KEY in ~/.hermes/.env or DUET_HERMES_KEY');
  else if (up) {
    const auth = await hermes.checkAuth();
    add('Hermes API key accepted', auth, auth ? 'ok' : 'Hermes rejected the key (401)');
  }
  const shim = join(config.root, 'server', 'mcp-shim.ts');
  const shimForward = shim.replaceAll('\\', '/');
  let cfg = '';
  try {
    cfg = readFileSync(join(config.hermesHome, 'config.yaml'), 'utf8');
  } catch {}
  const shimConfigured = cfg.includes(shim) || cfg.includes(shimForward);
  add('Duet tools in Hermes config', shimConfigured, shimConfigured ? 'mcp_servers entry points at this checkout' : `add an mcp_servers entry running ${shim}`);
  const lastTool = kv.get<number>('last_tool_call_at', 0);
  add('Hermes has called a Duet tool', lastTool > 0, lastTool ? `last call ${new Date(lastTool).toLocaleString()}` : 'not yet (normal on a fresh install)', true);
  add('public URL (needed for iOS push)', !!config.publicUrl, config.publicUrl || 'set DUET_PUBLIC_URL in .env');
  add('a device has notifications on', hasSubscriptions(), hasSubscriptions() ? 'yes' : 'open Settings → Notifications on your phone');
  add('context sources', existsSync(config.contextFile), existsSync(config.contextFile) ? config.contextFile : 'optional: copy context.example.md to context.local.md', true);
  const s = settings.get();
  add('morning brief', s.brief_enabled, s.brief_enabled ? `daily at ${s.brief_time} (${s.timezone}); the host must be awake` : 'off', true);
  const audio = audioDiagnostics();
  add(
    'speech-to-text (STT)',
    audio.stt.kind !== 'none',
    audio.stt.kind === 'http'
      ? `${audio.stt.url.split('?')[0]} (model: ${audio.stt.model})`
      : audio.stt.kind === 'cmd'
        ? `command: ${audio.stt.cmd}`
        : audio.stt.reason,
    true,
  );
  add(
    'text-to-speech (TTS)',
    audio.tts.kind !== 'none',
    audio.tts.kind === 'http'
      ? `${audio.tts.url.split('?')[0]} (model: ${audio.tts.model}, voice: ${audio.tts.voice})`
      : audio.tts.kind === 'cmd'
        ? `command: ${audio.tts.cmd}`
        : audio.tts.kind === 'say'
          ? 'macOS say + afconvert'
          : audio.tts.reason,
    true,
  );
  add(
    'ffmpeg (audio transcoding)',
    audio.ffmpeg,
    audio.ffmpeg ? 'found on PATH' : 'not found on PATH (needed to transcode non-WAV audio for whisper-cli and remux Safari m4a)',
    true,
  );
  return { ok: checks.every((c) => c.ok || c.info), checks };
}

/**
 * The event loops that need the database and the runner: a new file in the watched folder, and a meeting about to
 * start. Both stay quiet during quiet hours and both land in the general channel, where the user already looks.
 */
function startTriggerLoops() {
  const userHome = homedir();
  const home = (p: string) => {
    if (userHome && (p === userHome || p.startsWith(`${userHome}/`) || p.startsWith(`${userHome}\\`))) {
      return `~${p.slice(userHome.length)}`;
    }
    return p.replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)/, '~');
  };
  if (config.watchDir) {
    startFolderWatch(async (fresh: WatchedFile[]) => {
      const label = fresh.length === 1 ? `New file in ${home(config.watchDir)}` : `${fresh.length} new files in ${home(config.watchDir)}`;
      submitSystem(`${label}: ${fresh.map((f) => f.name).join(', ').slice(0, 160)}`, downloadsPrompt(fresh));
    });
  }

  // Calendar probes are AppleScript, so they run every couple of minutes at most, never on the 30s scheduler tick.
  let lastCalendar = 0;
  setInterval(async () => {
    if (!meetingPrepEnabled() || Date.now() - lastCalendar < 120_000) return;
    lastCalendar = Date.now();
    try {
      const tz = settings.get().timezone;
      await checkMeetings((e, now) => {
        const minutes = Math.max(1, Math.round((e.start - now) / 60_000));
        submitSystem(`“${e.title}” starts in ${minutes} minute${minutes === 1 ? '' : 's'}.`, meetingPrompt(e, now, tz));
      });
    } catch {
      // A denied or slow Calendar is already reported by the connectors list; the loop just waits for next time.
    }
  }, 60_000).unref?.();
}

// ---------- internal server (loopback only: MCP shim + CLI) ----------
const INTERNAL = internalToken();
const tokenFile = join(config.dataDir, 'internal.token');
writeFileSync(tokenFile, INTERNAL);
chmodSync(tokenFile, 0o600);

export async function handleInternal(req: Request): Promise<Response> {
  if (req.headers.get('authorization') !== `Bearer ${INTERNAL}`) return err(401, 'unauthorized');
  // cloudflared also connects from loopback, so refuse anything that looks proxied.
  if (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')) return err(403, 'forbidden');
  const url = new URL(req.url);
  const toolMatch = url.pathname.match(/^\/internal\/tool\/([\w-]+)$/);
  try {
    if (toolMatch && req.method === 'POST') {
      const { args } = await body<{ args?: Record<string, unknown> }>(req);
      return json({ text: await executeTool(toolMatch[1], args ?? {}) });
    }
    if (url.pathname === '/internal/pair' && req.method === 'POST') return json(createPairCode());
    if (url.pathname === '/internal/status' && req.method === 'GET') return json({ agent: agentState(), settings: settings.get() });
    if (url.pathname === '/internal/devices' && req.method === 'GET') return json({ devices: devices.all() });
    const revokeMatch = url.pathname.match(/^\/internal\/devices\/([\w-]+)\/revoke$/);
    if (revokeMatch && req.method === 'POST') {
      // A lost or replaced phone: its cookie stops working and it stops receiving pushes.
      return devices.revoke(revokeMatch[1]) ? json({ ok: true }) : err(404, 'no such device');
    }
    if (url.pathname === '/internal/doctor' && req.method === 'GET') return json(await doctor());
    if (url.pathname === '/internal/brief' && req.method === 'POST') {
      runBrief('manual');
      return json({ ok: true });
    }
    if (url.pathname === '/internal/checkin' && req.method === 'POST') {
      runCheckin();
      return json({ ok: true });
    }
    if (url.pathname === '/internal/message' && req.method === 'POST') {
      // The same rule as the public route: the shim and CLI must not be able to enqueue an empty or unbounded turn.
      const { text } = await body<{ text?: string }>(req);
      const t = messageText(text, false);
      if (!t) return err(400, 'empty message');
      if (t.length > MAX_MESSAGE) return err(400, 'message too long');
      return json({ item: submitUser(t) });
    }
    return err(404, 'not found');
  } catch (e: any) {
    return err(400, e?.message ?? String(e));
  }
}

/**
 * The live browser pane rides one websocket per phone: binary JPEG frames out (with a small
 * JSON header), pointer/keyboard events in. Frames are dropped rather than queued when a phone
 * can't keep up, so a slow link degrades the picture instead of lagging behind reality.
 */
let appServer: HttpServer | null = null;
let internalServer: HttpServer | null = null;
let browserWss: WebSocketServer | null = null;

/**
 * Compress a JSON response once the route has built it. Static files ride the precompressed siblings in
 * `serveStatic`; this covers `/api/state`, `/api/items` and search, which are the large ones on a phone reconnect.
 * SSE, uploads and delivered files are already streams or binary and are left alone.
 */
export async function compressJson(req: Request, pending: Promise<Response>): Promise<Response> {
  const res = await pending;
  if (!res || !(res.headers.get('content-type') ?? '').startsWith('application/json')) return res;
  if (res.headers.get('content-encoding')) return res;
  const encoding = preferredEncoding(req);
  if (!encoding) return res;
  const text = await res.text();
  // Below a kilobyte the frame headers cost more than the compression wins.
  if (Buffer.byteLength(text, 'utf8') < 1024) return new Response(text, { status: res.status, headers: res.headers });
  const body = encoding === 'br' ? brotliCompressSync(text) : gzipSync(text, { level: 6 });
  const headers = new Headers(res.headers);
  headers.set('content-encoding', encoding);
  headers.set('content-length', String(body.byteLength));
  headers.set('vary', 'accept-encoding');
  return new Response(body, { status: res.status, headers });
}

function toWebRequest(nodeReq: IncomingMessage, nodeRes?: ServerResponse): Request {
  const proto = (nodeReq.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || 'http';
  const host = (nodeReq.headers.host as string) || `127.0.0.1:${config.port}`;
  const url = new URL(nodeReq.url || '/', `${proto}://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, v);
    }
  }
  const ac = new AbortController();
  if (nodeRes) {
    nodeRes.on('close', () => {
      if (!nodeRes.writableFinished) ac.abort();
    });
  }
  const method = (nodeReq.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    signal: ac.signal,
    ...(hasBody ? { body: Readable.toWeb(nodeReq) as unknown as BodyInit, duplex: 'half' } : {}),
  };
  return new Request(url.toString(), init);
}

async function sendWebResponse(res: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = res.status;
  const setCookies = typeof (res.headers as any).getSetCookie === 'function' ? ((res.headers as any).getSetCookie() as string[]) : [];
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie' && setCookies.length > 0) return;
    nodeRes.setHeader(key, value);
  });
  if (setCookies.length > 0) nodeRes.setHeader('set-cookie', setCookies);

  if (!res.body) {
    nodeRes.end();
    return;
  }
  const reader = res.body.getReader();
  const abortReader = () => {
    reader.cancel().catch(() => {});
  };
  nodeRes.on('close', abortReader);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (nodeRes.destroyed || nodeRes.writableEnded) {
        await reader.cancel().catch(() => {});
        break;
      }
      if (!nodeRes.write(value)) {
        await new Promise<void>((resolve) => nodeRes.once('drain', resolve));
      }
    }
  } catch {
    // Client disconnected mid-stream.
  } finally {
    nodeRes.off('close', abortReader);
    if (!nodeRes.writableEnded) nodeRes.end();
  }
}

function attachBrowserSocket(ws: WsSocket) {
  if (process.env.DUET_CHROME_DEBUG) console.error('[ws] open', JSON.stringify({ kind: 'browser' }));
  const stopFrame = browser.onFrame((f) => {
    // A phone on a bad link must never make the server buffer megabytes of stale frames:
    // drop the frame instead of queueing it behind a stalled socket.
    if (ws.bufferedAmount > 1_500_000) return;
    const meta = new TextEncoder().encode(JSON.stringify({ w: f.width, h: f.height, tab: f.tabId }));
    const buf = new Uint8Array(4 + meta.length + f.jpeg.length);
    new DataView(buf.buffer).setUint32(0, meta.length, true);
    buf.set(meta, 4);
    buf.set(f.jpeg, 4 + meta.length);
    try {
      ws.send(buf);
    } catch (e: any) {
      console.error('[ws] frame send failed', e?.message);
    }
  });
  const stopTabs = browser.onTabs((tabs) => {
    try {
      ws.send(JSON.stringify({ type: 'tabs', tabs }));
    } catch (e: any) {
      console.error('[ws] tabs send failed', e?.message);
    }
  });
  browser.open().catch((e: Error) => {
    try {
      ws.send(JSON.stringify({ type: 'error', message: safeRouteMessage(e, 'Could not open browser') }));
    } catch {}
  });
  ws.on('message', async (raw) => {
    let evt: any;
    try {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : new TextDecoder().decode(raw as ArrayBuffer);
      evt = JSON.parse(text);
    } catch {
      return;
    }
    if (!evt?.type) return;
    try {
      await browser.input(evt);
    } catch (e: any) {
      try {
        ws.send(JSON.stringify({ type: 'error', message: safeRouteMessage(e, 'input failed') }));
      } catch {}
    }
  });
  ws.on('close', () => {
    stopFrame();
    stopTabs();
  });
}

export function startServers() {
  if (appServer && internalServer) return { appServer, internalServer };
  browserWss = new WebSocketServer({ noServer: true });
  appServer = createServer((nodeReq, nodeRes) => {
    const req = toWebRequest(nodeReq, nodeRes);
    const srv = { requestIP: () => ({ address: nodeReq.socket.remoteAddress ?? '' }) };
    compressJson(req, handleApp(req, srv))
      .then((res) => sendWebResponse(res, nodeRes))
      .catch((e) => {
        console.error('[http] unhandled', e);
        if (!nodeRes.headersSent) {
          nodeRes.statusCode = 500;
          nodeRes.end('Internal server error');
        } else if (!nodeRes.writableEnded) {
          nodeRes.end();
        }
      });
  });
  appServer.requestTimeout = 0;

  appServer.on('upgrade', async (nodeReq, socket, head) => {
    const req = toWebRequest(nodeReq);
    const pathname = new URL(req.url).pathname.replace(/\/+$/, '') || '/';
    if (pathname !== '/api/browser/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const device = await deviceFor(req);
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!sameOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    browserWss!.handleUpgrade(nodeReq, socket, head, (ws) => attachBrowserSocket(ws));
  });

  appServer.listen(config.port, config.host);

  internalServer = createServer((nodeReq, nodeRes) => {
    const req = toWebRequest(nodeReq, nodeRes);
    handleInternal(req)
      .then((res) => sendWebResponse(res, nodeRes))
      .catch((e) => {
        console.error('[internal] unhandled', e);
        if (!nodeRes.headersSent) {
          nodeRes.statusCode = 500;
          nodeRes.end('Internal server error');
        } else if (!nodeRes.writableEnded) {
          nodeRes.end();
        }
      });
  });
  internalServer.requestTimeout = 120_000;
  internalServer.listen(config.internalPort, '127.0.0.1');

  try {
    prune();
    setInterval(() => {
      try {
        prune();
      } catch (e: any) {
        console.error('[db] prune failed', e?.message ?? e);
      }
    }, 86_400_000).unref?.();
  } catch (e: any) {
    console.error('[db] prune failed', e?.message ?? e);
  }
  recoverOrphans();
  startHermesWatch();
  startConnectorWatch();
  startScheduler();
  startTriggerLoops();
  console.log(`[hermes-duet] app http://${config.host}:${config.port}  internal http://127.0.0.1:${config.internalPort}  hermes ${config.hermesUrl}`);
  return { appServer, internalServer };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServers();
}

/**
 * launchd and systemd send SIGTERM on stop and restart. Stop taking requests, end the event streams so their finally
 * blocks run, give the last write a moment, and only then close the database (which checkpoints the WAL). Runs that
 * were in flight stay 'running' in the database and recoverOrphans reattaches them on the next boot.
 */
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[hermes-duet] ${signal}: shutting down`);
  try {
    browserWss?.close();
    appServer?.close();
    internalServer?.close();
  } catch {}
  abortActiveRuns();
  try {
    browser.close();
  } catch {}
  await sleep(150);
  try {
    db.close();
  } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
if (process.platform === 'win32') process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
