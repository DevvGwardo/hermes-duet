import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { Snapshot } from '../shared/types';
import { briefSpeech, speak, transcribeFile } from './audio';
import { capabilities } from './capabilities';
import { channelInput } from './channels';
import { createPairCode, deviceCookie, deviceFor, internalToken, isHttps, redeemPairCode, sameOrigin } from './auth';
import { listConnectors, testConnector } from './connectors';
import { sseResponse } from './bus';
import { config } from './config';
import { type AttachmentRow, attachments, channels, db, devices, files, items, kv, newId, pages, settings, tasks, toAttachment, triggers } from './db';
import { hermes } from './hermes';
import { presence } from './presence';
import { hasSubscriptions, notify, publicKey, saveSubscription } from './push';
import { actOnCard, agentState, cancelTask, deliverableAction, deliverableApproval, executeTool, recoverOrphans, runBrief, runCheckin, startConnectorWatch, startHermesWatch, startUserTask, stopMain, stopPage, submitSystem, submitUser } from './runner';
import { ftsQuery, search } from './search';
import { startScheduler } from './scheduler';
import { downloadsPrompt, meetingPrompt, webhookMatches, webhookPrompt, type WatchedFile } from './triggers';
import { checkMeetings, meetingPrepEnabled, recordWebhook, startFolderWatch, webhookReady, webhookToken } from './triggers-runtime';
import { MAX_UPLOAD_BYTES, normalizeMime, saveUpload } from './uploads';
import { readLogin, vaults } from './vault';
import { broadcast } from './bus';

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const err = (status: number, error: string) => json({ error }, status);

async function body<T = any>(req: Request): Promise<T> {
  if (!(req.headers.get('content-type') ?? '').includes('application/json')) throw new Error('expected JSON');
  const text = await req.text();
  if (text.length > 256_000) throw new Error('body too large');
  return (text ? JSON.parse(text) : {}) as T;
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
const ERROR_CODES: Record<number, string> = { 400: 'bad_request', 401: 'not_paired', 403: 'forbidden', 404: 'not_found', 413: 'too_large', 429: 'too_many', 500: 'internal' };
export function apiError(e: any, path: string): Response {
  const msg = String(e?.message ?? e ?? 'error');
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
  [/^\/api\/channels$/, ['GET', 'POST']],
  [/^\/api\/channels\/[\w-]+$/, ['DELETE']],
  [/^\/api\/channels\/[\w-]+\/seen$/, ['POST']],
  [/^\/api\/channels\/[\w-]+\/items$/, ['GET']],
  [/^\/api\/search$/, ['GET']],
  [/^\/api\/connectors$/, ['GET']],
  [/^\/api\/connectors\/[\w-]+\/test$/, ['POST']],
  [/^\/api\/triggers$/, ['GET']],
  [/^\/api\/events$/, ['GET']],
  [/^\/api\/capabilities$/, ['GET']],
  [/^\/api\/browser\/(status|tabs|vaults)$/, ['GET']],
  [/^\/api\/browser\/(open|input|viewport|autofill)$/, ['POST']],
  [/^\/api\/messages$/, ['POST']],
  [/^\/api\/tasks$/, ['POST']],
  [/^\/api\/tasks\/[\w-]+\/cancel$/, ['POST']],
  [/^\/api\/uploads$/, ['POST']],
  [/^\/api\/uploads\/[\w-]+$/, ['GET']],
  [/^\/api\/audio\/transcribe$/, ['POST']],
  [/^\/api\/cards\/[\w-]+\/act$/, ['POST']],
  [/^\/api\/runs\/stop$/, ['POST']],
  [/^\/api\/pages\/[\w-]+$/, ['DELETE']],
  [/^\/api\/files\/[\w-]+$/, ['GET']],
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
  const lines = rows.map((r) => `- ${r.path} (${r.mime}, ${kb(r.size)})${r.mime.startsWith('audio/') ? ' — a voice memo the user recorded' : ''}`);
  return `\n\nThe user attached ${rows.length === 1 ? 'a file' : `${rows.length} files`} with this message:\n${lines.join('\n')}\nLook at them with your file or vision tools before answering.`;
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'SAMEORIGIN',
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
  "frame-ancestors 'none'",
].join('; ');

import * as browser from './browser';

// ---------- public app server (the tunnel points here) ----------
export async function handleApp(req: Request, server?: any): Promise<Response> {
  const url = new URL(req.url);
  // A trailing slash is the same route. Without this, `/api/items/` missed every branch and fell out of the API block
  // as an opaque 404 (and non-API paths fell through to the app shell), which the client reported as a parse error.
  const rawPath = url.pathname;
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;

  if (path !== '/api' && !path.startsWith('/api/')) return serveStatic(rawPath);

  // Liveness for Docker, launchd and anything else watching this process. It reveals nothing and needs no pairing.
  if (path === '/api/health' && req.method === 'GET') return json({ ok: true, at: Date.now() });
  // Which build the phone is talking to, so client/server drift after an upgrade is visible instead of mysterious.
  if (path === '/api/version' && req.method === 'GET') return json({ version: VERSION });

  if (path === '/api/pair' && req.method === 'POST') {
    const { code } = await body<{ code?: string }>(req);
    const token = await redeemPairCode(String(code ?? ''), req.headers.get('user-agent') ?? 'device');
    if (!token) return err(401, 'invalid or expired code');
    return json({ ok: true }, 200, { 'set-cookie': deviceCookie(token, isHttps(req)) });
  }

  /**
   * Webhook ingress for GitHub, Stripe, Zapier, n8n or a plain curl. It is called by the outside world, so it cannot
   * carry a device cookie; the unguessable token in the URL is the credential, and it is the only one accepted.
   */
  const hookMatch = path.match(/^\/api\/webhooks\/([\w-]{8,64})$/);
  if (hookMatch && req.method === 'POST') {
    if (!webhookMatches(webhookToken(), hookMatch[1])) return err(401, 'bad webhook token');
    if (tooLarge(req, 256_000)) return err(413, 'payload too large');
    if (!webhookReady()) return err(429, 'too many webhooks');
    const kindRaw = url.searchParams.get('kind') ?? '';
    let payload: unknown = null;
    const type = req.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      payload = await req.json().catch(() => null);
    } else {
      payload = await req.text();
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
      const snap: Snapshot = {
        items: page.items,
        has_more: page.has_more,
        pending: items.pendingCards(),
        tasks: tasks.recent(),
        files: files.all(),
        pages: pages.all(),
        channels: channels.all(),
        settings: settings.get(),
        agent: agentState(),
        push_enabled: hasSubscriptions(device),
      };
      return json(snap);
    }
    if (path === '/api/items' && req.method === 'GET') {
      const before = url.searchParams.get('before') ?? '';
      const channel = url.searchParams.get('channel') ?? '';
      if (channel && !channels.get(channel)) return err(404, 'no such channel');
      return json(items.before(before, 100, channel || undefined));
    }

    // ---- topic channels (see server/channels.ts) ----
    if (path === '/api/channels' && req.method === 'GET') return json({ channels: channels.all() });
    if (path === '/api/channels' && req.method === 'POST') {
      const channel = channels.create(channelInput(await body(req)));
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
      if (!channels.get(channelSeen[1])) return err(404, 'no such channel');
      channels.seen(channelSeen[1]);
      return json({ ok: true });
    }
    const channelItems = path.match(/^\/api\/channels\/([\w-]+)\/items$/);
    if (channelItems && req.method === 'GET') {
      if (!channels.get(channelItems[1])) return err(404, 'no such channel');
      const before = url.searchParams.get('before') ?? '';
      if (before) return json(items.before(before, 100, channelItems[1]));
      return json(items.latest(100, channelItems[1]));
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
        const login = await readLogin(host, which);
        try {
          const filled = await browser.fillLogin(login.username, login.password, host);
          if (!filled.pass) return err(400, `Found the ${login.vault} login for ${host}, but there is no password field on the page.`);
          return json({ host, vault: login.vault, filled });
        } finally {
          // The credentials live no longer than this request.
          login.password = '';
        }
      } catch (e: any) {
        return err(400, e?.message ?? 'Autofill failed');
      }
    }

    if (path === '/api/messages' && req.method === 'POST') {
      const { text, channel_id, attachment_ids } = await body<{ text?: string; channel_id?: string; attachment_ids?: string[] }>(req);
      const ids = Array.isArray(attachment_ids) ? attachment_ids.slice(0, 6).map(String) : [];
      if (attachment_ids && !Array.isArray(attachment_ids)) return err(400, 'attachment_ids must be a list');
      const rows = ids.map((id) => attachments.get(id)).filter((r): r is AttachmentRow => !!r);
      if (rows.length !== ids.length) return err(400, 'unknown attachment');
      const t = messageText(text, rows.length > 0);
      if (!t) return err(400, 'empty message');
      if (t.length > MAX_MESSAGE) return err(400, 'message too long');
      const note = attachmentNote(rows);
      const item = submitUser(t, note ? `${t}${note}` : undefined, channel_id, rows.map(toAttachment));
      if (rows.length) attachments.link(ids, item.id);
      return json({ item });
    }
    if (path === '/api/tasks' && req.method === 'POST') {
      const { text, channel_id } = await body<{ text?: string; channel_id?: string }>(req);
      const t = String(text ?? '').trim();
      if (!t) return err(400, 'empty message');
      if (t.length > 20_000) return err(400, 'message too long');
      return json(startUserTask(t, channel_id));
    }

    // ---- uploads, voice memos and spoken briefs (see server/uploads.ts, server/audio.ts) ----
    if (path === '/api/uploads' && req.method === 'POST') {
      // One limit: the same number uploads.ts enforces after reading, so a file can't pass the gate and then be
      // rejected deeper after it has been fully buffered.
      if (tooLarge(req, MAX_UPLOAD_BYTES)) return err(413, 'that file is too large');
      const form = await req.formData().catch(() => null);
      const file = form?.get('file');
      if (!(file instanceof File)) return err(400, 'send the file in a "file" field');
      const listed = form?.get('mime');
      const mime = normalizeMime(listed ? String(listed) : file.type);
      return json({ attachment: saveUpload({ bytes: new Uint8Array(await file.arrayBuffer()), mime, filename: String(form?.get('name') ?? file.name) }) });
    }
    const uploadMatch = path.match(/^\/api\/uploads\/([\w-]+)$/);
    if (uploadMatch && req.method === 'GET') return serveUpload(uploadMatch[1]);

    if (path === '/api/audio/transcribe' && req.method === 'POST') {
      if (tooLarge(req, MAX_UPLOAD_BYTES)) return err(413, 'that recording is too large');
      let bytes: Uint8Array;
      let mime: string;
      if ((req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
        const form = await req.formData().catch(() => null);
        const file = form?.get('audio') ?? form?.get('file');
        if (!(file instanceof File)) return err(400, 'send the recording in an "audio" field');
        bytes = new Uint8Array(await file.arrayBuffer());
        mime = normalizeMime(file.type);
      } else {
        bytes = new Uint8Array(await req.arrayBuffer());
        mime = normalizeMime(req.headers.get('content-type'));
      }
      if (!mime.startsWith('audio/')) return err(400, 'send an audio recording');
      // The memo is kept even when transcription is unavailable, so it can be replayed and retried later.
      const attachment = saveUpload({ bytes, mime, filename: 'Voice memo' });
      const row = attachments.get(attachment.id)!;
      try {
        const text = await transcribeFile(row.path);
        return json({ text, attachment });
      } catch (e: any) {
        return json({ error: e?.message ?? 'Transcription failed', attachment, text: '' }, 503);
      }
    }

    // "Listen" on the morning brief: synthesized once, then served from data/tts.
    const briefAudio = path.match(/^\/api\/brief\/([\w-]+)\/audio$/);
    if (briefAudio && req.method === 'GET') {
      const item = items.get(briefAudio[1]);
      if (!item?.card || item.card.type !== 'brief') return err(404, 'no such brief');
      const clip = await speak(briefSpeech(item.card));
      return new Response(Bun.file(clip.path), {
        headers: { 'content-type': clip.mime, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' },
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
    const pageMatch = path.match(/^\/api\/pages\/([\w-]+)$/);
    if (pageMatch && req.method === 'DELETE') {
      await stopPage(pageMatch[1]);
      return json({ ok: true });
    }

    const fileMatch = path.match(/^\/api\/files\/([\w-]+)$/);
    if (fileMatch && req.method === 'GET') return await serveFile(fileMatch[1], url.searchParams.has('download'));

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
      const next = settings.update(await body(req));
      broadcast({ type: 'settings', settings: next });
      return json({ settings: next });
    }
    if (path === '/api/brief/run' && req.method === 'POST') {
      runBrief('manual');
      return json({ ok: true });
    }
    if (path === '/api/push/key' && req.method === 'GET') return json({ key: publicKey });
    if (path === '/api/push/subscribe' && req.method === 'POST') {
      saveSubscription(await body(req), device);
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
      const sent = await notify({ title: 'Hermes Duet', body: 'Notifications are working.', always: true }, { ignoreQuiet: true });
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

/**
 * An upload is served inline for the thread's thumbnails and the voice memo player, but sandboxed: an SVG is markup,
 * and it must never run script with this app's origin and cookie behind it.
 */
async function serveUpload(id: string): Promise<Response> {
  const row = attachments.get(id);
  if (!row || !existsSync(row.path)) return err(404, 'file not found');
  return new Response(Bun.file(row.path), {
    headers: {
      'content-type': row.mime,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
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
  else if (f.entry.mime === 'text/html') return new Response((await Bun.file(f.path).text()) + LINK_SHIM + DELIVERABLE_BRIDGE, { headers });
  return new Response(Bun.file(f.path), { headers });
}

async function serveStatic(path: string): Promise<Response> {
  const rel = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
  const candidate = join(config.webDir, rel);
  if (candidate.startsWith(config.webDir) && rel !== '/' && existsSync(candidate)) {
    const file = Bun.file(candidate);
    if (file.size > 0 || (await file.exists())) {
      const immutable = rel.startsWith('/assets/');
      return new Response(file, {
        headers: {
          ...SECURITY_HEADERS,
          ...(rel.endsWith('.html') ? { 'content-security-policy': APP_CSP } : {}),
          'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          ...(rel === '/sw.js' ? { 'service-worker-allowed': '/' } : {}),
        },
      });
    }
  }
  const index = Bun.file(join(config.webDir, 'index.html'));
  if (!(await index.exists())) return new Response('Web app not built. Run: bun run build', { status: 503 });
  return new Response(index, {
    headers: { ...SECURITY_HEADERS, 'content-security-policy': APP_CSP, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
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
  let cfg = '';
  try {
    cfg = readFileSync(join(config.hermesHome, 'config.yaml'), 'utf8');
  } catch {}
  add('Duet tools in Hermes config', cfg.includes(shim), cfg.includes(shim) ? 'mcp_servers entry points at this checkout' : `add an mcp_servers entry running ${shim}`);
  const lastTool = kv.get<number>('last_tool_call_at', 0);
  add('Hermes has called a Duet tool', lastTool > 0, lastTool ? `last call ${new Date(lastTool).toLocaleString()}` : 'not yet (normal on a fresh install)', true);
  add('public URL (needed for iOS push)', !!config.publicUrl, config.publicUrl || 'set DUET_PUBLIC_URL in .env');
  add('a device has notifications on', hasSubscriptions(), hasSubscriptions() ? 'yes' : 'open Settings → Notifications on your phone');
  add('context sources', existsSync(config.contextFile), existsSync(config.contextFile) ? config.contextFile : 'optional: copy context.example.md to context.local.md', true);
  const s = settings.get();
  add('morning brief', s.brief_enabled, s.brief_enabled ? `daily at ${s.brief_time} (${s.timezone}); the Mac must be awake` : 'off', true);
  return { ok: checks.every((c) => c.ok || c.info), checks };
}

/**
 * The event loops that need the database and the runner: a new file in the watched folder, and a meeting about to
 * start. Both stay quiet during quiet hours and both land in the general channel, where the user already looks.
 */
function startTriggerLoops() {
  const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
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
  }, 60_000);
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
if (import.meta.main) Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: (req, srv) => handleApp(req, srv),
  websocket: {
    open(ws: any) {
      if (process.env.DUET_CHROME_DEBUG) console.error('[ws] open', JSON.stringify(ws.data));
      if (ws.data?.kind !== 'browser') return;
      const stopFrame = browser.onFrame((f) => {
        // A phone on a bad link must never make the server buffer megabytes of stale frames:
        // drop the frame instead of queueing it behind a stalled socket.
        const buffered = typeof (ws as any).getBufferedAmount === 'function' ? (ws as any).getBufferedAmount() : 0;
        if (buffered > 1_500_000) return;
        const meta = new TextEncoder().encode(
          JSON.stringify({ w: f.width, h: f.height, tab: f.tabId }),
        );
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
      ws.data.stop = () => {
        stopFrame();
        stopTabs();
      };
      browser.open().catch((e: Error) => {
        try {
          ws.send(JSON.stringify({ type: 'error', message: e.message }));
        } catch {}
      });
    },
    async message(ws: any, raw: any) {
      if (ws.data?.kind !== 'browser') return;
      let evt: any;
      try {
        evt = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
      } catch {
        return;
      }
      if (!evt?.type) return;
      try {
        await browser.input(evt);
      } catch (e: any) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: e?.message ?? 'input failed' }));
        } catch {}
      }
    },
    close(ws: any) {
      ws.data?.stop?.();
    },
  },
  idleTimeout: 0,
});
if (import.meta.main) Bun.serve({ hostname: '127.0.0.1', port: config.internalPort, fetch: handleInternal, idleTimeout: 120 });

if (import.meta.main) {
  recoverOrphans();
  startHermesWatch();
  startConnectorWatch();
  startScheduler();
  startTriggerLoops();
  console.log(`[hermes-duet] app http://${config.host}:${config.port}  internal http://127.0.0.1:${config.internalPort}  hermes ${config.hermesUrl}`);
}

// launchd sends SIGTERM on stop and restart. Closing the database checkpoints the WAL, so a restart never depends on
// recovery picking up a half-written file; runs that were in flight are reattached by recoverOrphans on the next boot.
let closing = false;
function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[hermes-duet] ${signal}: shutting down`);
  try {
    db.close();
  } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
