/**
 * Live browser pane.
 *
 * One persistent, headed, real Google Chrome lives on the Mac (its own profile, so logins
 * survive) and is driven over raw CDP: the agent through Hermes's ``browser.cdp_url``, the
 * phone through this module. Frames come from ``Page.startScreencast`` (JPEG, change-only,
 * acked so Chrome keeps sending) and the phone's taps come back as ``Input.*`` commands,
 * which Chrome delivers as trusted input, so human-verification widgets actually accept them.
 *
 * No playwright dependency: Bun speaks CDP directly.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config';

const DEBUG_PORT = Number(process.env.DUET_CHROME_PORT ?? 9333);
const PROFILE = process.env.DUET_CHROME_PROFILE ?? join(config.hermesHome, 'duet-chrome');
const CHROME =
  process.env.DUET_CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/** Phone screens are small; capping the frame width is what keeps this ~200KB/s instead of 1MB/s. */
const MAX_WIDTH = Number(process.env.DUET_CHROME_WIDTH ?? 760);
const QUALITY = Number(process.env.DUET_CHROME_QUALITY ?? 45);
/** Hard cap on frames handed to phones; Chrome sends them as fast as it can otherwise. */
const MIN_FRAME_GAP_MS = Number(process.env.DUET_CHROME_FPS_GAP ?? 110);
const MAX_SHOTS_PER_SEC = 20;

export type Tab = { id: string; title: string; url: string; active: boolean };
export type Frame = { jpeg: Uint8Array; width: number; height: number; tabId: string };
type Sink = (f: Frame) => void;
type TabInfo = (tabs: Tab[]) => void;

let chrome: ReturnType<typeof Bun.spawn> | null = null;
let ws: WebSocket | null = null;
let connecting: Promise<void> | null = null;
let cmdId = 1;
const pending = new Map<number, (v: any) => void>();
const sinks = new Set<Sink>();
/** The newest frame, kept so a phone that just opened the pane is not left staring at black. */
let lastFrame: Frame | null = null;
const tabSinks = new Set<TabInfo>();

/** targetId → CDP session id, for the page targets we've attached to. */
const sessions = new Map<string, string>();
let active: string | null = null;
let lastFrameAt = 0;
let shotCount = 0;
let shotWindow = Date.now();
let titles = new Map<string, { title: string; url: string }>();

function log(...a: unknown[]) {
  if (process.env.DUET_CHROME_DEBUG) console.log('[browser]', ...a);
}

async function reachable(): Promise<string | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, {
      signal: AbortSignal.timeout(700),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { webSocketDebuggerUrl?: string };
    return j.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

async function ensureChrome(): Promise<void> {
  if (await reachable()) return;
  if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME}`);
  mkdirSync(PROFILE, { recursive: true });
  log('launching Chrome', PROFILE);
  chrome = Bun.spawn(
    [
      CHROME,
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE}`,
      // Keep the profile a normal user profile: --enable-automation is what sites sniff for.
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      '--restore-last-session=false',
      'about:blank',
    ],
    { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' },
  );
  for (let i = 0; i < 60; i++) {
    if (await reachable()) return;
    await Bun.sleep(250);
  }
  throw new Error('Chrome did not expose a debugging port');
}

function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
  if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('browser not connected'));
  const id = cmdId++;
  const msg: Record<string, unknown> = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
    }, 20_000);
    pending.set(id, (v) => {
      clearTimeout(timer);
      resolve(v);
    });
    try {
      ws!.send(JSON.stringify(msg));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** A dead CDP socket must not leave callers hanging until their 20s timeout. */
function rejectPending(reason: string) {
  for (const [, done] of pending) {
    try {
      done({ error: { message: reason } });
    } catch {}
  }
  pending.clear();
}

function onEvent(msg: any) {
  const { method, params, sessionId } = msg;
  if (method === 'Page.screencastFrame') {
    // Ack first: without it Chrome stops sending after a couple of frames.
    if (sessionId) ws?.send(JSON.stringify({ id: cmdId++, method: 'Page.screencastFrameAck', params: { sessionId }, sessionId }));

    const targetId = [...sessions.entries()].find(([, s]) => s === sessionId)?.[0] ?? '';
    if (targetId !== active) return;
    const now = Date.now();
    if (now - lastFrameAt < MIN_FRAME_GAP_MS) return;
    if (now - shotWindow > 1000) {
      shotWindow = now;
      shotCount = 0;
    }
    if (++shotCount > MAX_SHOTS_PER_SEC) return;
    lastFrameAt = now;

    const meta = params.metadata ?? {};
    const jpeg = Uint8Array.from(atob(params.data), (c) => c.charCodeAt(0));
    const frame: Frame = {
      jpeg,
      width: meta.deviceWidth || 0,
      height: meta.deviceHeight || 0,
      tabId: targetId,
    };
    for (const s of sinks) {
      try {
        s(frame);
      } catch {}
    }
    lastFrame = frame;
    return;
  }

  if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
    const info = params.targetInfo;
    if (info?.type === 'page') {
      titles.set(info.targetId, { title: info.title || '', url: info.url || '' });
      if (method === 'Target.targetCreated' && !sessions.has(info.targetId) && !info.url?.startsWith('devtools://')) {
        attach(info.targetId).catch((e) => log('attach failed', e.message));
      } else {
        emitTabs();
      }
    }
    return;
  }

  if (method === 'Target.targetDestroyed') {
    const targetId = params.targetId as string;
    const s = sessions.get(targetId);
    if (s) sessions.delete(targetId);
    titles.delete(targetId);
    if (active === targetId) active = null;
    emitTabs();
  }
}

async function attach(targetId: string) {
  const res = await send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = res?.result?.sessionId;
  if (!sessionId) return;
  sessions.set(targetId, sessionId);
  await send('Page.enable', {}, sessionId).catch(() => {});
  if (!active) await startScreencast(targetId);
  const t = titles.get(targetId);
  send('Target.getTargetInfo', { targetId })
    .then((r) => {
      const info = r?.result?.targetInfo;
      if (info) {
        titles.set(targetId, { title: info.title || t?.title || '', url: info.url || t?.url || '' });
        emitTabs();
      }
    })
    .catch(() => emitTabs());
}

async function startScreencast(targetId: string) {
  const sessionId = sessions.get(targetId);
  if (!sessionId) return;
  if (active && active !== targetId) {
    const old = sessions.get(active);
    if (old) await send('Page.stopScreencast', {}, old).catch(() => {});
  }
  active = targetId;
  lastFrameAt = 0;
  await send(
    'Page.startScreencast',
    { format: 'jpeg', quality: QUALITY, maxWidth: MAX_WIDTH, maxHeight: 1600, everyNthFrame: 1 },
    sessionId,
  ).catch((e) => log('startScreencast failed', e.message));
  emitTabs();
}

function emitTabs() {
  buildTabs().then((tabs) => {
    for (const s of tabSinks) {
      try {
        s(tabs);
      } catch {}
    }
  });
}

export async function buildTabs(): Promise<Tab[]> {
  try {
    const r = await send('Target.getTargets');
    const infos = (r?.result?.targetInfos ?? []) as any[];
    return infos
      .filter((i) => i.type === 'page' && !String(i.url).startsWith('devtools://'))
      .map((i) => ({
        id: i.targetId,
        title: i.title || titles.get(i.targetId)?.title || '',
        url: i.url || '',
        active: i.targetId === active,
      }));
  } catch {
    return [];
  }
}

export async function connect(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (connecting) return connecting;
  connecting = (async () => {
    await ensureChrome();
    const url = await reachable();
    if (!url) throw new Error('Chrome debugging endpoint disappeared');
    await new Promise<void>((resolve, reject) => {
      const sock = new WebSocket(url);
      const fail = (e: unknown) => reject(e instanceof Error ? e : new Error(String(e)));
      sock.onopen = () => {
        ws = sock;
        send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
        resolve();
      };
      sock.onerror = fail;
      sock.onclose = () => {
        if (ws === sock) ws = null;
        sessions.clear();
        active = null;
        rejectPending('browser connection closed');
        // A phone still watching should get its picture back by itself: Chrome can be
        // restarted or crash underneath us, and "close and reopen the pane" is not an answer.
        if (sinks.size > 0) scheduleReconnect();
      };
      sock.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        } catch {
          return;
        }
        if (msg.id && pending.has(msg.id)) {
          const done = pending.get(msg.id)!;
          pending.delete(msg.id);
          done(msg);
          return;
        }
        if (msg.method) onEvent(msg);
      };
    });
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

/** Retry the CDP connection with backoff while somebody is still watching. */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(30_000, 500 * 2 ** reconnectAttempt++);
  log('reconnect in', delay, 'ms');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (sinks.size === 0) {
      reconnectAttempt = 0;
      return;
    }
    connect()
      .then(() => {
        reconnectAttempt = 0;
        return open();
      })
      .catch((e: Error) => {
        log('reconnect failed', e.message);
        scheduleReconnect();
      });
  }, delay);
}

/** Attach to whatever page is already open, and make sure something is being streamed. */
export async function open(): Promise<Tab[]> {
  await connect();
  let tabs = await buildTabs();
  // Chrome keeps running with no tabs once you close the last window, and then every tap
  // would fail with "no active tab" against a black canvas. Make one instead.
  if (tabs.length === 0) {
    const created = await send('Target.createTarget', { url: 'about:blank' }).catch(() => null);
    const id = created?.result?.targetId;
    if (id) {
      await attach(id).catch(() => {});
      tabs = await buildTabs();
    }
  }
  for (const t of tabs) if (!sessions.has(t.id)) await attach(t.id).catch(() => {});
  if (!active && tabs[0]) await startScreencast(tabs[0].id);
  return buildTabs();
}

export function onFrame(sink: Sink): () => void {
  sinks.add(sink);
  // Replay the last picture immediately: on a page that is not repainting, waiting for
  // Chrome's next frame means a black pane for as long as the user stares at it.
  if (lastFrame) {
    try {
      sink(lastFrame);
    } catch {}
  }
  return () => sinks.delete(sink);
}

export function onTabs(sink: TabInfo): () => void {
  tabSinks.add(sink);
  return () => tabSinks.delete(sink);
}

export async function focusTab(tabId: string): Promise<void> {
  await connect();
  if (!sessions.has(tabId)) await attach(tabId);
  await startScreencast(tabId);
}

async function dispatch(method: string, params: Record<string, unknown>) {
  const sessionId = active ? sessions.get(active) : undefined;
  if (!sessionId) throw new Error('no active tab');
  const r = await send(method, params, sessionId);
  if (r?.error) throw new Error(r.error.message ?? 'CDP error');
  return r;
}

export type PhoneInput =
  | { type: 'tap'; x: number; y: number }
  | { type: 'long-press'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; dy: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string }
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'reload' }
  | { type: 'tab'; id: string }
  | { type: 'new-tab' };

/** Keys the phone's keyboard bar and back button are allowed to synthesize. */
const KEY_CODES: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};

/** A bare host or a pasted fragment should not reach Chrome as a relative URL. */
export function normalizeUrl(raw: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^(https?|about):/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null; // file:, javascript:, data: and friends
  if (/^[\w-]+(\.[\w-]+)+([/:?#]|$)/.test(s)) return `https://${s}`;
  return `https://${s.replace(/^\/+/, '')}`;
}

/**
 * Validate what came off the wire before it reaches CDP. Kept pure so it can be tested
 * without a browser: a malformed event must never turn into a stray CDP method.
 */
export function normalizeInput(raw: unknown): PhoneInput | null {
  const e = raw as Record<string, any>;
  if (!e || typeof e !== 'object' || typeof e.type !== 'string') return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);
  switch (e.type) {
    case 'tap':
    case 'long-press':
      return { type: e.type, x: Math.max(0, num(e.x)), y: Math.max(0, num(e.y)) };
    case 'scroll':
      return {
        type: 'scroll',
        x: Math.max(0, num(e.x)),
        y: Math.max(0, num(e.y)),
        dy: Math.max(-4000, Math.min(4000, num(e.dy))),
      };
    case 'text': {
      const text = typeof e.text === 'string' ? e.text.slice(0, 2000) : '';
      return text ? { type: 'text', text } : null;
    }
    case 'key':
      // Own-property check: `'constructor' in KEY_CODES` is true through the prototype,
      // which would let a junk key name reach CDP as a nonsense virtual key code.
      return typeof e.key === 'string' && Object.hasOwn(KEY_CODES, e.key)
        ? { type: 'key', key: e.key }
        : null;
    case 'navigate': {
      const url = normalizeUrl(e.url);
      return url ? { type: 'navigate', url } : null;
    }
    case 'back':
    case 'reload':
    case 'new-tab':
      return { type: e.type } as PhoneInput;
    case 'tab':
      return typeof e.id === 'string' && e.id ? { type: 'tab', id: e.id } : null;
    default:
      return null;
  }
}

export async function input(raw: unknown): Promise<void> {
  const evt = normalizeInput(raw);
  if (!evt) throw new Error('unsupported input event');
  // First touch after the app restarts can arrive before anything is streaming: opening
  // is cheap and makes the very first tap work instead of failing with "no active tab".
  if (!active && evt.type !== 'navigate' && evt.type !== 'tab' && evt.type !== 'new-tab') {
    await open().catch(() => {});
  }
  switch (evt.type) {
    case 'tap':
      await dispatch('Input.dispatchMouseEvent', { type: 'mouseMoved', x: evt.x, y: evt.y, button: 'none' });
      await dispatch('Input.dispatchMouseEvent', { type: 'mousePressed', x: evt.x, y: evt.y, button: 'left', clickCount: 1 });
      await dispatch('Input.dispatchMouseEvent', { type: 'mouseReleased', x: evt.x, y: evt.y, button: 'left', clickCount: 1 });
      return;
    case 'long-press':
      await dispatch('Input.dispatchMouseEvent', { type: 'mousePressed', x: evt.x, y: evt.y, button: 'left', clickCount: 1 });
      await Bun.sleep(650);
      await dispatch('Input.dispatchMouseEvent', { type: 'mouseReleased', x: evt.x, y: evt.y, button: 'left', clickCount: 1 });
      return;
    case 'scroll':
      await dispatch('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: evt.x,
        y: evt.y,
        deltaX: 0,
        deltaY: evt.dy,
      });
      return;
    case 'text':
      await dispatch('Input.insertText', { text: evt.text });
      return;
    case 'key': {
      const key = evt.key;
      const code = KEY_CODES[key];
      if (!code) return;
      const map: Record<string, { key: string; text?: string }> = {
        Enter: { key: 'Enter', text: '\r' },
        Backspace: { key: 'Backspace' },
        Tab: { key: 'Tab' },
        Escape: { key: 'Escape' },
        ' ': { key: ' ', text: ' ' },
        PageUp: { key: 'PageUp' },
        PageDown: { key: 'PageDown' },
        End: { key: 'End' },
        Home: { key: 'Home' },
        ArrowLeft: { key: 'ArrowLeft' },
        ArrowUp: { key: 'ArrowUp' },
        ArrowRight: { key: 'ArrowRight' },
        ArrowDown: { key: 'ArrowDown' },
      };
      await dispatch('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: code, ...map[key] });
      await dispatch('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, ...map[key] });
      return;
    }
    case 'navigate':
      await connect();
      if (!sessions.has(active ?? '')) await open().catch(() => {});
      await dispatch('Page.navigate', { url: evt.url });
      return;
    case 'back':
      await dispatch('Runtime.evaluate', { expression: 'history.back()' });
      return;
    case 'reload':
      await dispatch('Page.reload', {});
      return;
    case 'tab':
      await focusTab(evt.id);
      return;
    case 'new-tab': {
      await connect();
      const r = await send('Target.createTarget', { url: 'about:blank' });
      const id = r?.result?.targetId;
      if (id) await focusTab(id);
      return;
    }
  }
}

/** Give Hermes a CDP URL it can drive, so agent and phone share one browser. */
export function cdpUrl(): string {
  return `http://127.0.0.1:${DEBUG_PORT}`;
}

export function status(): { running: boolean; port: number; profile: string; tabs: number } {
  return { running: !!ws && ws.readyState === WebSocket.OPEN, port: DEBUG_PORT, profile: PROFILE, tabs: sessions.size };
}

// ---------------------------------------------------------------------------
// Viewport emulation
// ---------------------------------------------------------------------------

export type ViewportMode = 'mobile' | 'desktop';

/** The iPhone 14/15 logical size: sites lay themselves out for a phone instead of a desktop window. */
export const MOBILE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 3 };

export function viewportMetrics(mode: ViewportMode) {
  return mode === 'mobile' ? { ...MOBILE_VIEWPORT, mobile: true } : null;
}

/**
 * Render the page as a phone or as a desktop. Mobile mode also turns on touch emulation, so a site that branches on
 * pointer type picks its mobile layout; desktop mode clears the override entirely.
 */
export async function setViewport(raw: unknown): Promise<ViewportMode> {
  const mode: ViewportMode = raw === 'mobile' ? 'mobile' : 'desktop';
  const sessionId = active ? sessions.get(active) : undefined;
  if (!sessionId) throw new Error('no active tab');
  const metrics = viewportMetrics(mode);
  if (metrics) {
    await send('Emulation.setDeviceMetricsOverride', { ...metrics, screenOrientation: { type: 'portraitPrimary', angle: 0 } }, sessionId);
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }, sessionId).catch(() => {});
  } else {
    await send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false }, sessionId);
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: false }, sessionId).catch(() => {});
  }
  return mode;
}

// ---------------------------------------------------------------------------
// Typing into the page as if the user typed it (logins, card fields)
// ---------------------------------------------------------------------------

async function sessionId(): Promise<string> {
  if (!active) await open().catch(() => {});
  const id = active ? sessions.get(active) : undefined;
  if (!id) throw new Error('no active tab');
  return id;
}

/**
 * Focus the first visible element matching one of `selectors` and type into it with Input.insertText, which Chrome
 * delivers as a trusted edit. Returns false when the page has no such field (yet) instead of throwing, so a login page
 * that is still rendering gets a clear "not found" rather than a stack trace.
 */
async function typeInto(sid: string, selectors: string[], value: string): Promise<boolean> {
  const expr = `(() => {
    const sels = ${JSON.stringify(selectors)};
    for (const s of sels) {
      let el = null;
      try { el = document.querySelector(s); } catch { continue; }
      if (!el || el.disabled || el.readOnly) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      el.focus();
      if (typeof el.select === 'function') el.select();
      return true;
    }
    return false;
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sid);
  if (!r?.result?.result?.value) return false;
  await send('Input.insertText', { text: value }, sid);
  return true;
}

const LOGIN_USER = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name="username"]',
  'input[name="email"]',
  'input[id*="username" i]',
  'input[id*="email" i]',
  'input[type="text"]',
];
const LOGIN_PASS = ['input[type="password"]', 'input[autocomplete="current-password"]', 'input[name="password"]'];

/**
 * Fill the username and password fields of the page in front of the user. They tapped a button; the credentials come
 * from a local vault CLI and are typed straight into Chrome. Nothing is logged, echoed back, or put in a card.
 */
export async function fillLogin(username: string, password: string): Promise<{ user: boolean; pass: boolean }> {
  const sid = await sessionId();
  const user = await typeInto(sid, LOGIN_USER, username);
  // Tab moves focus the way a person would; some pages only reveal the password step after the username is entered.
  if (user) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 9, key: 'Tab' }, sid);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab' }, sid);
  }
  const pass = await typeInto(sid, LOGIN_PASS, password);
  if (pass) {
    // Submit, so the login actually completes without another tap on the phone.
    await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', text: '\r' }, sid);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter' }, sid);
  }
  return { user, pass };
}

const CARD_NUMBER = ['input[autocomplete="cc-number"]', 'input[name*="cardnumber" i]', 'input[name*="card_number" i]', 'input[id*="card-number" i]', 'input[name="number"]', 'input[placeholder*="card number" i]'];
const CARD_EXPIRY = ['input[autocomplete="cc-exp"]', 'input[name*="exp" i]', 'input[id*="exp" i]', 'input[placeholder*="MM" i]'];
const CARD_CVV = ['input[autocomplete="cc-csc"]', 'input[name*="cvc" i]', 'input[name*="cvv" i]', 'input[name*="security" i]', 'input[id*="cvc" i]', 'input[placeholder*="CVC" i]'];

/**
 * Type an issued single-use card into the checkout. The caller keeps the number only in memory and calls this
 * immediately after issuing it; only which fields were found is reported back.
 */
export async function fillCard(card: { number: string; expMonth: number; expYear: number; cvv: string }): Promise<{ number: boolean; expiry: boolean; cvv: boolean }> {
  const sid = await sessionId();
  const exp = `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`;
  const number = await typeInto(sid, CARD_NUMBER, card.number);
  const expiry = await typeInto(sid, CARD_EXPIRY, exp);
  const cvv = await typeInto(sid, CARD_CVV, card.cvv);
  return { number, expiry, cvv };
}

/** Hostname of the page in front of the user, for looking up which login it needs. */
export async function currentHost(): Promise<string> {
  const sid = await sessionId();
  const r = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sid);
  const href = String(r?.result?.result?.value ?? '');
  try {
    return new URL(href).hostname;
  } catch {
    return '';
  }
}