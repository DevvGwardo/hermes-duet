import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { Snapshot } from '../shared/types';
import { createPairCode, deviceCookie, deviceFor, internalToken, isHttps, redeemPairCode, sameOrigin } from './auth';
import { sseResponse } from './bus';
import { config } from './config';
import { files, items, kv, pages, settings, tasks } from './db';
import { hermes } from './hermes';
import { hasSubscriptions, notify, publicKey, saveSubscription } from './push';
import { actOnCard, agentState, cancelTask, executeTool, recoverOrphans, runBrief, runCheckin, startHermesWatch, stopMain, submitUser } from './runner';
import { startScheduler } from './scheduler';
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

// ---------- public app server (the tunnel points here) ----------
async function handleApp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (!path.startsWith('/api/')) return serveStatic(path);

  if (path === '/api/pair' && req.method === 'POST') {
    const { code } = await body<{ code?: string }>(req);
    const token = await redeemPairCode(String(code ?? ''), req.headers.get('user-agent') ?? 'device');
    if (!token) return err(401, 'invalid or expired code');
    return json({ ok: true }, 200, { 'set-cookie': deviceCookie(token, isHttps(req)) });
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
        settings: settings.get(),
        agent: agentState(),
        push_enabled: hasSubscriptions(device),
      };
      return json(snap);
    }
    if (path === '/api/items' && req.method === 'GET') {
      const before = url.searchParams.get('before') ?? '';
      return json(items.before(before, 100));
    }
    if (path === '/api/events' && req.method === 'GET') return sseResponse(req);

    if (path === '/api/messages' && req.method === 'POST') {
      const { text } = await body<{ text?: string }>(req);
      const t = String(text ?? '').trim();
      if (!t) return err(400, 'empty message');
      if (t.length > 20_000) return err(400, 'message too long');
      return json({ item: submitUser(t) });
    }

    const cardMatch = path.match(/^\/api\/cards\/([\w-]+)\/act$/);
    if (cardMatch && req.method === 'POST') {
      const { action, value } = await body<{ action?: string; value?: string }>(req);
      const item = actOnCard(cardMatch[1], String(action ?? ''), value);
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

    const fileMatch = path.match(/^\/api\/files\/([\w-]+)$/);
    if (fileMatch && req.method === 'GET') return serveFile(fileMatch[1], url.searchParams.has('download'));

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
    if (path === '/api/push/test' && req.method === 'POST') {
      const sent = await notify({ title: 'Hermes Duet', body: 'Notifications are working.', always: true }, { ignoreQuiet: true });
      return json({ sent });
    }
    return err(404, 'not found');
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const status = /not found/i.test(msg) ? 404 : /already|expected|invalid|bad|empty|too/i.test(msg) ? 400 : 500;
    if (status === 500) console.error('[api]', path, e);
    return err(status, msg);
  }
}

function serveFile(id: string, download: boolean): Response {
  const f = files.get(id);
  if (!f || !existsSync(f.path)) return err(404, 'file not found');
  const headers: Record<string, string> = {
    'content-type': f.entry.mime,
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    // Agent-made HTML runs in an opaque origin: scripts yes, cookies/API access no.
    'content-security-policy': 'sandbox allow-scripts allow-popups allow-downloads; frame-ancestors \'self\'',
  };
  if (download) headers['content-disposition'] = `attachment; filename="${f.entry.name.replace(/["\\\r\n]/g, '_')}"`;
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

// ---------- internal server (loopback only: MCP shim + CLI) ----------
const INTERNAL = internalToken();
const tokenFile = join(config.dataDir, 'internal.token');
writeFileSync(tokenFile, INTERNAL);
chmodSync(tokenFile, 0o600);

async function handleInternal(req: Request): Promise<Response> {
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
      const { text } = await body<{ text?: string }>(req);
      return json({ item: submitUser(String(text ?? '')) });
    }
    return err(404, 'not found');
  } catch (e: any) {
    return err(400, e?.message ?? String(e));
  }
}

Bun.serve({ hostname: config.host, port: config.port, fetch: handleApp, idleTimeout: 0 });
Bun.serve({ hostname: '127.0.0.1', port: config.internalPort, fetch: handleInternal, idleTimeout: 120 });

recoverOrphans();
startHermesWatch();
startScheduler();
console.log(`[hermes-duet] app http://${config.host}:${config.port}  internal http://127.0.0.1:${config.internalPort}  hermes ${config.hermesUrl}`);
