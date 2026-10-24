import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../ui';

type Tab = { id: string; title: string; url: string; active: boolean };

/**
 * Live view of the Chrome the agent is driving, plus your hands on it.
 *
 * Frames arrive as binary JPEGs over one websocket; taps and typing go back as CDP input,
 * which Chrome treats as trusted — that is what lets you clear a human-verification check
 * the agent got stuck on instead of just watching it fail.
 */
export function BrowserView({ onClose }: { onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const keyRef = useRef<HTMLTextAreaElement | null>(null);
  const lastValue = useRef('');
  const lastScroll = useRef(0);
  const gesture = useRef<{ x: number; y: number; at: number; moved: boolean } | null>(null);

  const [status, setStatus] = useState<'connecting' | 'live' | 'idle' | 'error'>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [url, setUrl] = useState('');
  const [urlOpen, setUrlOpen] = useState(false);
  const [tabsOpen, setTabsOpen] = useState(false);

  const send = useCallback((evt: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(evt));
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let seq = 0;
    let drawn = 0;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/api/browser/ws`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onmessage = async (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'tabs') {
              setTabs(msg.tabs ?? []);
              const active = (msg.tabs ?? []).find((t: Tab) => t.active);
              if (active) setUrl(active.url);
            }
            if (msg.type === 'error') {
              setNotice(msg.message);
              // Input errors can leave a perfectly good last frame on screen; only
              // replace it when Chrome never produced a frame in the first place.
              if (drawn === 0) setStatus('error');
            }
          } catch {}
          return;
        }
        const buf = ev.data as ArrayBuffer;
        if (buf.byteLength < 5) return;
        try {
          const metaLen = new DataView(buf).getUint32(0, true);
          const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, metaLen)));
          const jpeg = new Uint8Array(buf, 4 + metaLen);
          sizeRef.current = { w: meta.w || sizeRef.current.w, h: meta.h || sizeRef.current.h };
          // Decoding is async, so a slow frame can land after a newer one. Stamp each
          // frame and refuse to paint anything older than what is already on screen.
          const mine = ++seq;
          const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
          if (mine < drawn) {
            bmp.close();
            return;
          }
          drawn = mine;
          const canvas = canvasRef.current;
          if (!canvas) {
            bmp.close();
            return;
          }
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          canvas.getContext('2d')?.drawImage(bmp, 0, 0);
          bmp.close();
          setStatus('live');
        } catch {
          // A truncated frame is not a reason to tear the session down; the next one lands.
        }
      };
      ws.onopen = () => {
        attempt = 0;
        setStatus('live');
      };
      ws.onerror = () => setNotice('could not reach the browser');
      ws.onclose = () => {
        wsRef.current = null;
        if (closed) return;
        // Chrome or the server restarting should heal on its own; the pane is the whole
        // point and "close and reopen" is a bad answer on a phone.
        setStatus('idle');
        const delay = Math.min(8000, 500 * 2 ** attempt++);
        retry = setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  /** Canvas pixels are the page's CSS pixels: scale the touch back into that space. */
  const toPage = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    const { w, h } = sizeRef.current;
    if (!canvas || !rect || !rect.width || !rect.height || !w || !h) return { x: 0, y: 0 };
    return {
      x: Math.round(((clientX - rect.left) / rect.width) * w),
      y: Math.round(((clientY - rect.top) / rect.height) * h),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    keyRef.current?.focus({ preventScroll: true });
    gesture.current = { x: e.clientX, y: e.clientY, at: Date.now(), moved: false };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dy = e.clientY - g.y;
    if (Math.abs(dy) > 12) {
      g.moved = true;
      // One scroll event per ~40ms is enough to feel native; more just floods CDP and
      // makes the page lurch on a slow link.
      const now = Date.now();
      if (now - (lastScroll.current || 0) >= 40 || Math.abs(dy) > 48) {
        lastScroll.current = now;
        const p = toPage(e.clientX, e.clientY);
        send({ type: 'scroll', x: p.x, y: p.y, dy: -dy });
      }
      g.y = e.clientY;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.moved) return;
    const p = toPage(e.clientX, e.clientY);
    const held = Date.now() - g.at;
    send({ type: held > 550 ? 'long-press' : 'tap', x: p.x, y: p.y });
  };

  /** iOS gives no usable key events on a hidden field, so diff its value instead. */
  const onType = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    const prev = lastValue.current;
    // Only insertions are reliable here: the field is cleared after every change, so a
    // shrink is not a deletion we can attribute. Backspace is handled as a key event.
    if (next.length > prev.length) send({ type: 'text', text: next.slice(prev.length) });
    lastValue.current = '';
    e.target.value = '';
  };

  /** Special keys must not also land in the field, or Enter would send twice. */
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const passthrough: Record<string, string> = {
      Enter: 'Enter',
      Backspace: 'Backspace',
      Tab: 'Tab',
      Escape: 'Escape',
    };
    if (!passthrough[e.key]) return;
    e.preventDefault();
    send({ type: 'key', key: passthrough[e.key] });
  };

  const go = () => {
    const raw = url.trim();
    if (!raw) return;
    send({ type: 'navigate', url: /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}` });
    setUrlOpen(false);
  };

  return (
    <div className="browser-pane" role="dialog" aria-label="Live browser">
      <div className="browser-bar">
        <button className="icon-btn" aria-label="Back" onClick={() => send({ type: 'back' })}>
          <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
            <Icon.chevron size={18} />
          </span>
        </button>
        <button className="icon-btn" aria-label="Reload" onClick={() => send({ type: 'reload' })}>
          <Icon.bolt size={18} />
        </button>
        <button
          className="browser-url"
          onClick={() => setUrlOpen((v) => !v)}
          title={url}
        >
          <span className={`status-dot ${status === 'live' ? 'ok' : status === 'error' ? 'bad' : ''}`} />
          {url.replace(/^https?:\/\//, '').slice(0, 64) || 'no tab'}
        </button>
        <button className="icon-btn" aria-label="Tabs" onClick={() => setTabsOpen((v) => !v)}>
          <Icon.deck size={18} />
        </button>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          <Icon.close size={18} />
        </button>
      </div>

      {urlOpen && (
        <div className="browser-urlbar">
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go();
            }}
            placeholder="https://…"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button onClick={go}>Go</button>
        </div>
      )}

      {tabsOpen && (
        <div className="browser-tabs">
          {tabs.length === 0 && <div className="browser-empty">no tabs yet</div>}
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`browser-tab ${t.active ? 'on' : ''}`}
              onClick={() => {
                send({ type: 'tab', id: t.id });
                setTabsOpen(false);
              }}
            >
              <b>{t.title || t.url || 'untitled'}</b>
              <span>{t.url.replace(/^https?:\/\//, '')}</span>
            </button>
          ))}
          <button
            className="browser-tab new"
            onClick={() => {
              send({ type: 'new-tab' });
              setTabsOpen(false);
            }}
          >
            <b>+ new tab</b>
          </button>
        </div>
      )}

      <div className="browser-stage">
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (gesture.current = null)}
        />
        {status !== 'live' && (
          <div className="browser-overlay">
            {status === 'connecting' && 'starting Chrome…'}
            {status === 'idle' && 'reconnecting…'}
            {status === 'error' && (notice || 'browser unavailable')}
          </div>
        )}
      </div>

      <textarea
        ref={keyRef}
        className="browser-keys"
        onChange={onType}
        onKeyDown={onKey}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        aria-label="Keyboard for the live browser"
      />
      {notice && status === 'live' && (
        <div className="browser-notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
    </div>
  );
}