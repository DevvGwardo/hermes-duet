import { useEffect, useRef, useState } from 'react';
import { cardOf, isSettledAsk } from '../../shared/links';
import { api, clearSettledNotifications, connect, isStandalone, pushSupported } from './api';
import { Composer, type ComposerHandle } from './components/Composer';
import { MakeView } from './components/MakeView';
import { BrandBadge, MangaBackdrop, Mascot, SpeechBubble, Wordmark } from './components/Manga';
import { Rail } from './components/Rail';
import { SettingsSheet } from './components/SettingsSheet';
import { TasksView } from './components/TasksView';
import { Thread } from './components/Thread';
import { Viewer } from './components/Viewer';
import { useStore } from './store';
import { Icon } from './ui';

type Tab = 'chat' | 'tasks' | 'make';

const TAB_META: Record<Tab, { label: string; icon: (p: { size?: number }) => React.ReactElement; blurb: string }> = {
  chat: { label: 'Chat', icon: Icon.chat, blurb: 'One thread, everything in it' },
  tasks: { label: 'Tasks', icon: Icon.tasks, blurb: 'What’s running, what needs you' },
  make: { label: 'Make', icon: Icon.make, blurb: 'Docs, decks, dashboards' },
};

export function App() {
  const authed = useStore((s) => s.authed);
  const ready = useStore((s) => s.ready);

  useEffect(() => {
    connect();
  }, []);

  if (authed === false) return <Pair />;
  if (!ready)
    return (
      <div className="boot">
        <MangaBackdrop stirred />
        <Mascot size={150} live />
      </div>
    );
  return <Shell />;
}

function useStatus() {
  const agent = useStore((s) => s.agent);
  const connected = useStore((s) => s.connected);
  if (!connected) return { cls: 'off', text: 'Reconnecting' };
  if (agent.hermes === 'down') return { cls: 'warn', text: 'Hermes offline' };
  if (agent.busy) return { cls: 'busy', text: agent.current_run?.kind === 'brief' ? 'Writing your brief' : 'Working' };
  if (agent.background_running) return { cls: 'busy', text: `${agent.background_running} in background` };
  return { cls: 'idle', text: 'Ready' };
}

function Shell() {
  const [tab, setTab] = useState<Tab>('chat');
  const [fileId, setFileId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [jump, setJump] = useState<string | null>(null);
  const [briefNote, setBriefNote] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const composer = useRef<ComposerHandle>(null);
  const agent = useStore((s) => s.agent);
  const pushEnabled = useStore((s) => s.pushEnabled);
  const pending = useStore((s) => s.pending.length);
  const working = useStore((s) => s.tasks.filter((t) => t.status === 'running' || t.status === 'waiting').length);
  // A string, so streaming deltas don't re-run the effect below; it changes only when another ask is settled.
  const settled = useStore((s) => s.items.filter(isSettledAsk).map((i) => i.id).join(' '));
  const [hideInstall, setHideInstall] = useState(() => localStorageGet('duet.hideInstall') === '1');
  const status = useStatus();
  const stirred = agent.busy || agent.background_running > 0;

  useEffect(() => {
    // Home-screen icon badge = things waiting on you (installed PWAs on iOS 16.4+, Chrome, Edge).
    const nav = navigator as any;
    (pending ? nav.setAppBadge?.(pending) : nav.clearAppBadge?.())?.catch?.(() => {});
  }, [pending]);

  useEffect(() => {
    // An approval or question decided here, on another device, or expired takes its banner with it.
    clearSettledNotifications().catch(() => {});
  }, [settled]);

  useEffect(() => {
    // Notification taps arrive here when the app is already open. Brief and handover pushes name their card only
    // in the URL, so read both. Clearing first lets a second tap on the same card scroll to it again.
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'open') {
        setTab('chat');
        const card = cardOf(e.data);
        if (card) {
          setJump(null);
          requestAnimationFrame(() => setJump(card));
        }
      }
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    const card = cardOf({ url: location.search });
    if (card) {
      setJump(card);
      // A reload shouldn't jump back to the card the notification opened.
      history.replaceState(null, '', location.pathname);
    }
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    // "/" jumps to the composer from anywhere, unless you're already typing or a sheet is open.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || settings || fileId) return;
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      setTab('chat');
      requestAnimationFrame(() => composer.current?.focus());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settings, fileId]);

  const jumpTo = (id: string) => {
    setTab('chat');
    setJump(null);
    requestAnimationFrame(() => setJump(id));
  };
  const startPrompt = (p: string) => {
    setTab('chat');
    requestAnimationFrame(() => composer.current?.prefill(p));
  };
  const briefNow = () =>
    api.runBrief().then(
      () => {
        setBriefNote('Brief on its way');
        setTimeout(() => setBriefNote(null), 4000);
      },
      () => setBriefNote('Could not start a brief'),
    );

  const showInstall = !hideInstall && !isStandalone() && /iPhone|iPad/.test(navigator.userAgent);
  const showPushNudge = !showInstall && !pushEnabled && pushSupported() && isStandalone();
  const badges: Record<Tab, number> = { chat: pending, tasks: working, make: 0 };
  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className={`app view-${tab}`}>
      <MangaBackdrop stirred={stirred} />

      <aside className="sidebar">
        <div className="side-brand">
          <BrandBadge size={46} live={stirred} />
          <div>
            <Wordmark stacked />
            <div className="brand-sub">your agent, in duet</div>
          </div>
        </div>
        <nav className="side-nav" role="tablist">
          {(Object.keys(TAB_META) as Tab[]).map((t) => {
            const M = TAB_META[t];
            return (
              <button key={t} role="tab" aria-selected={tab === t} className={`side-tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                <M.icon size={19} />
                <span className="side-tab-label">{M.label}</span>
                {badges[t] > 0 && <span className={`count ${t === 'chat' ? 'warm' : ''}`}>{badges[t]}</span>}
              </button>
            );
          })}
        </nav>
        <button className="side-action" onClick={briefNow}>
          <Icon.sun size={18} />
          <span>{briefNote ?? 'Brief me now'}</span>
        </button>
        <div className="side-foot">
          <div className={`status-card status-${status.cls}`}>
            <span className="sonar">
              <i />
            </span>
            <div>
              <div className="status-title">{status.text}</div>
              <div className="status-sub">Hermes · {agent.hermes === 'ok' ? 'connected' : agent.hermes}</div>
            </div>
          </div>
          <button className="side-tab" onClick={() => setSettings(true)}>
            <Icon.gear size={19} />
            <span className="side-tab-label">Settings</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="top-brand">
            <BrandBadge size={32} live={stirred} />
            <Wordmark size="sm" />
          </div>
          <div className="top-title">
            <h1>{TAB_META[tab].label}</h1>
            <span className="top-sub">{tab === 'chat' ? today : TAB_META[tab].blurb}</span>
          </div>
          <div className={`status-pill status-${status.cls}`}>
            <span className="status-dot" />
            <span className="status-text">{status.text}</span>
          </div>
          <button className="icon-btn top-gear" onClick={() => setSettings(true)} aria-label="Settings">
            <Icon.gear size={20} />
          </button>
        </header>

        {showInstall && (
          <div className="banner">
            <span>Add Hermes Duet to your Home Screen (Share → Add to Home Screen) to get notifications.</span>
            <button
              className="icon-btn"
              aria-label="Dismiss"
              onClick={() => {
                localStorageSet('duet.hideInstall', '1');
                setHideInstall(true);
              }}
            >
              <Icon.close size={16} />
            </button>
          </div>
        )}
        {showPushNudge && (
          <button className="banner action" onClick={() => setSettings(true)}>
            Turn on notifications so I can reach you when something needs you.
          </button>
        )}

        <main className="content">
          {tab === 'chat' && <Thread onOpenFile={setFileId} scrollToId={jump} onSuggest={startPrompt} followKey={sent} />}
          {tab === 'tasks' && <TasksView onJump={jumpTo} onOpenFile={setFileId} />}
          {tab === 'make' && <MakeView onOpenFile={setFileId} onStart={startPrompt} />}
        </main>

        {tab === 'chat' && <Composer ref={composer} onSent={() => setSent((n) => n + 1)} />}

        <nav className="dock" role="tablist">
          {(Object.keys(TAB_META) as Tab[]).map((t) => {
            const M = TAB_META[t];
            return (
              <button key={t} role="tab" aria-selected={tab === t} className={`dock-tab ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>
                <span className="dock-icon">
                  <M.icon size={21} />
                  {badges[t] > 0 && <span className={`badge ${t === 'chat' ? '' : 'cool'}`}>{badges[t]}</span>}
                </span>
                <span className="dock-label">{M.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <Rail tab={tab} onJump={jumpTo} onOpenFile={setFileId} onShowTasks={() => setTab('tasks')} />

      {fileId && <Viewer fileId={fileId} onClose={() => setFileId(null)} />}
      {settings && <SettingsSheet onClose={() => setSettings(false)} />}
    </div>
  );
}

function Pair() {
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.pair(code.trim());
      await connect();
    } catch (e: any) {
      setErr(e.message === 'not paired' ? 'That code didn’t work. Codes expire after 10 minutes.' : e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pair">
      <MangaBackdrop stirred={busy} />
      <form onSubmit={submit} className="pair-card">
        <div className="pair-hero">
          <Mascot size={210} live={busy} />
          <SpeechBubble>
            Who's this? Run <code>hermes-duet pair</code> on your Mac and tell me the code.
          </SpeechBubble>
        </div>
        <h1>
          <Wordmark size="lg" />
        </h1>
        <p className="pair-tag">your agent, working alongside you</p>
        <div className="pair-panel">
          <label htmlFor="pair-code">Pairing code</label>
          <input
            id="pair-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD-1234"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellCheck={false}
            maxLength={12}
            autoFocus
          />
          {err && <p className="error small">{err}</p>}
          <button className="btn btn-primary" disabled={code.trim().length < 6 || busy}>
            {busy ? 'Pairing…' : 'Pair'}
          </button>
        </div>
      </form>
    </div>
  );
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}
